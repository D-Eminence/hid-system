import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { HidRequest } from '../common/request-context';
import { CardShareRecordsService } from '../ehr/card-share/card-share-records.service';
import { DatabaseService } from './database.service';

// The receiver's records read (0118) against PostgreSQL with every migration
// applied and the runtime roles bootstrapped (a throwaway cluster; synthetic
// values only). Set HID_CARD_SHARE_TEST_DATABASE_URL to a login that may
// SET ROLE to hid_ehr_api_runtime and owns the card-link tables; skipped
// otherwise. The fixture is committed (the tables are never deleted from),
// so use a throwaway database only.
const url = process.env.HID_CARD_SHARE_TEST_DATABASE_URL;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from({ length: 9 }, (_, index) => (index === 4 ? '-'
  : ALPHABET[Math.floor(Math.random() * ALPHABET.length)])).join('');

(url ? describe : describe.skip)('Card-share read transaction on PostgreSQL (0118)', () => {
  const environment = { ...process.env };
  let admin: Pool;
  let runtime: Pool;

  beforeAll(() => {
    admin = new Pool({ connectionString: url, max: 1 });
    runtime = new Pool({ connectionString: url, max: 1, options: '-c role=hid_ehr_api_runtime' });
  });
  afterAll(async () => {
    process.env = environment;
    await Promise.all([admin.end(), runtime.end()]);
  });

  async function liveView(scope: 'card' | 'card_and_records') {
    const ids = { account: randomUUID(), patient: randomUUID(), share: randomUUID(), code: randomUUID(), view: randomUUID() };
    const secret = randomUUID().replace(/-/g, '') + 'abcdefghijk';
    const tag = ids.share.slice(0, 8);
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
        values ($1::uuid, 'patient:' || $1::text, 'e8-pg-' || $2::text || '@example.invalid', 'Pg Cardlink', 'active',
          clock_timestamp(), 'hid')`,
      [ids.account, tag]);
      await client.query(`insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status,
          notifications_enabled, source_system)
        values ($1, $2, $3, 'Pg', 'Cardlink', 'Pg Cardlink', 'active', true, 'hid')`,
      [ids.patient, ids.account, `HID-${reference().replace('-', '').slice(0, 8)}`]);
      await client.query(`insert into ehr.patient_reported_health_profiles (patient_id, blood_group, genotype, allergies,
          updated_by_account_id) values ($1, 'O+', 'AA', 'Synthetic allergy', $2)`, [ids.patient, ids.account]);
      await client.query(`insert into identity.card_shares (id, patient_id, reference, scope, duration_preset, consent_version,
          recipient_ciphertext, recipient_key_version, recipient_hmac, recipient_hint, token_hmac, created_at, expires_at,
          delivery_outcome, idempotency_key, request_sha256)
        values ($1, $2, $3, $4, '24h', 'card-share-v1', decode(repeat('ab', 40), 'hex'), 'test-v1', $5, 'k•••@example.com', $6,
          now(), now() + interval '24 hours', 'sent', 'e8-pg-idem-' || $7::text, $5)`,
      [ids.share, ids.patient, reference(), scope, sha256(`address:${tag}`), sha256(`token:${tag}`), tag]);
      await client.query(`insert into identity.card_share_codes (id, share_id, verifier_hmac, key_version, requester_sha256,
          created_at, expires_at, delivery_outcome, consumed_at)
        values ($1, $2, $3, 'test-v1', $3, now(), now() + interval '10 minutes', 'sent', now())`,
      [ids.code, ids.share, sha256(`code:${tag}`)]);
      await client.query(`insert into identity.card_share_views (id, share_id, code_id, secret_sha256, created_at, expires_at)
        values ($1, $2, $3, $4, now(), now() + interval '30 minutes')`, [ids.view, ids.share, ids.code, sha256(secret)]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return { ...ids, secret };
  }

  function records() {
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    Object.assign(database, { pool: runtime });
    return new CardShareRecordsService(database);
  }

  function request(viewId: string, secret: string, correlationId: string): HidRequest {
    return { correlationId, cookies: { [`hid_cv_${viewId.replace(/-/g, '')}`]: secret },
      header: (name: string) => (name.toLowerCase() === 'x-card-view' ? viewId : undefined) } as unknown as HidRequest;
  }

  it('answers a live "Card and records" view and audits the read once (F1: not refused by a read-only transaction)', async () => {
    process.env.CARD_LINKS_ENABLED = 'true';
    const view = await liveView('card_and_records');
    const correlationId = `e8-pg-read-${view.share.slice(0, 8)}`;
    const answer = await records().read(request(view.view, view.secret, correlationId));
    expect(answer).toMatchObject({ scope: 'card_and_records',
      healthProfile: { bloodGroup: 'O+', genotype: 'AA', allergies: 'Synthetic allergy' } });
    const audited = await admin.query(`select count(*)::int as n from audit.events
      where action = 'ehr.card-share.records.read' and correlation_id = $1 and resource_id = $2`, [correlationId, view.share]);
    expect(audited.rows[0].n).toBe(1);
  });

  it('answers "Card only" with the card fields only', async () => {
    process.env.CARD_LINKS_ENABLED = 'true';
    const view = await liveView('card');
    const answer = await records().read(request(view.view, view.secret, `e8-pg-card-${view.share.slice(0, 8)}`));
    expect(answer).toMatchObject({ scope: 'card', encounters: [], notes: [],
      healthProfile: { bloodGroup: 'O+', genotype: 'AA', allergies: 'Synthetic allergy' } });
  });

  it('the reads run read only: a write in the operation is refused (25006)', async () => {
    process.env.CARD_LINKS_ENABLED = 'true';
    const view = await liveView('card');
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    Object.assign(database, { pool: runtime });
    await expect(database.withCardShareTransaction(sha256(view.secret), `e8-pg-write-${view.share.slice(0, 8)}`,
      (client) => client.query(`update ehr.patient_reported_health_profiles set allergies = 'changed'`)))
      .rejects.toMatchObject({ code: '25006' });
  });

  it('an unknown view answers 410 CARD_SHARE_VIEW_ENDED, never a server error', async () => {
    process.env.CARD_LINKS_ENABLED = 'true';
    await expect(records().read(request(randomUUID(), 'U3ludGhldGljVmlld1NlY3JldDAxMjM0NTY3ODlBQkM', 'e8-pg-unknown')))
      .rejects.toMatchObject({ code: 'CARD_SHARE_VIEW_ENDED' });
  });
});
