import { resetEnvironmentForTests } from '../config/environment';
import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { DatabaseService } from '../database/database.service';
import { CardLinksEmailDispatcher, CardLinksSweeper } from './card-links.dispatcher';

describe('Card links (0118): the patient emails and the sweeper', () => {
  const original = { ...process.env };
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let claimed: unknown[];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('claim_card_share_emails')) { const rows = claimed; claimed = []; return { rows }; }
    if (sql.includes('record_card_share_email_outcome')) return { rows: [{ next_status: values[2] === 'accepted' ? 'delivered' : 'pending' }] };
    if (sql.includes('close_expired_card_shares')) return { rows: [{ swept: { closed: 1 } }] };
    return { rows: [] };
  }) };
  const database = { withSystemTransaction: jest.fn(async (_c: string, work: (c: unknown) => Promise<unknown>) => work(client)) };
  const notification = { deliverCardShareOpened: jest.fn(), deliverCardShareCreated: jest.fn() };

  beforeEach(() => {
    queries.length = 0;
    jest.clearAllMocks();
    Object.assign(process.env, { CARD_LINKS_ENABLED: 'true' });
    resetEnvironmentForTests();
    claimed = [
      { email_id: 'e1', kind: 'opened', recipient: 'ada@example.com', reference: 'K7P2-QX9M', recipient_hint: 'k•••@x.com',
        occurred_at: new Date('2026-11-04T09:42:00Z'), link_expires_at: new Date('2026-11-05T09:00:00Z'), attempt_count: 1 },
      { email_id: 'e2', kind: 'created', recipient: 'ada@example.com', reference: 'K7P2-QX9M', recipient_hint: 'k•••@x.com',
        occurred_at: new Date('2026-11-04T09:00:00Z'), link_expires_at: new Date('2026-11-05T09:00:00Z'), attempt_count: 1,
        link_emailed: true },
    ];
    notification.deliverCardShareOpened.mockResolvedValue({ outcome: 'accepted', provider: 'ses' });
    notification.deliverCardShareCreated.mockResolvedValue({ outcome: 'unknown', safeCode: 'timeout' });
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const dispatcher = () => new CardLinksEmailDispatcher(database as unknown as DatabaseService,
    notification as unknown as NotificationOtpClient);

  it('claims, sends E7 and E8 with no health data, and records each outcome', async () => {
    const summary = await dispatcher().dispatch('sweep-0001');
    expect(summary).toEqual({ claimed: 2, delivered: 1, retried: 1, failed: 0 });
    expect(notification.deliverCardShareOpened).toHaveBeenCalledWith({ emailId: 'e1', recipient: 'ada@example.com',
      reference: 'K7P2-QX9M', openedAt: new Date('2026-11-04T09:42:00Z'), correlationId: 'sweep-0001' });
    expect(notification.deliverCardShareCreated).toHaveBeenCalledWith({ emailId: 'e2', recipient: 'ada@example.com',
      reference: 'K7P2-QX9M', recipientHint: 'k•••@x.com', expiresAt: new Date('2026-11-05T09:00:00Z'),
      linkEmailed: true, correlationId: 'sweep-0001' });
    expect(queries.filter((query) => query.sql.includes('record_card_share_email_outcome')).map((query) => query.values[2]))
      .toEqual(['accepted', 'unknown']);
  });

  it('E8 says when the link was not emailed (a blocked or capped address, or a failed send) (F6)', async () => {
    claimed = [{ ...claimed[1]!, link_emailed: false }];
    await dispatcher().dispatch('sweep-0003');
    expect(notification.deliverCardShareCreated).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'e2',
      linkEmailed: false }));
    expect(queries.find((query) => query.sql.includes('claim_card_share_emails'))?.sql).toContain('link_emailed');
  });

  it('does nothing while CARD_LINKS_ENABLED is off: no claim, no sweep', async () => {
    process.env.CARD_LINKS_ENABLED = 'false';
    expect(await dispatcher().dispatch('sweep-0002')).toEqual({ claimed: 0, delivered: 0, retried: 0, failed: 0 });
    await new CardLinksSweeper(dispatcher(), database as unknown as DatabaseService).runOnce();
    expect(queries).toEqual([]);
  });

  it('the sweeper ends links past their end and applies retention, then sends the emails', async () => {
    await new CardLinksSweeper(dispatcher(), database as unknown as DatabaseService).runOnce();
    expect(queries[0]?.sql).toContain('identity.close_expired_card_shares($1)');
    expect(queries.some((query) => query.sql.includes('claim_card_share_emails'))).toBe(true);
  });
});
