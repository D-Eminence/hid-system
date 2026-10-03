// Synthetic data only. Called inside the disposable PostgreSQL rehearsal.
import assert from 'node:assert/strict';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, deterministicUuid } from './staging-cutover-additions.mjs';
import { contactLookupHmac } from './contact-lookup.mjs';

export async function rehearseStagingAdditions(client, databaseUrl) {
  const parentId = randomUUID();
  const keyEnvelope = randomBytes(33);
  const key = keyEnvelope.subarray(0, 32);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const collections = Object.fromEntries(['accounts', 'auth_identities', 'user_profiles', 'organizations',
    'facilities', 'patients', 'patient_access_secrets', 'medical_records', 'medical_record_versions',
    'medical_record_files', 'patient_identifiers', 'staff', 'memberships', 'access_requests',
    'consent_grants', 'audit_events'].map(type => [type, []]));
  for (let n = 0; n < 39; n++) {
    const patientId = randomUUID();
    const accountId = n < 6 ? randomUUID() : null;
    collections.patients.push({ id: patientId, auth_user_id: accountId });
    collections.patient_access_secrets.push({ patient_id: patientId,
      access_pin_hash: '$2b$10$' + 'a'.repeat(53), created_at: timestamp, updated_at: timestamp });
    if (accountId) {
      collections.accounts.push({ id: accountId });
      const identity = { id: randomUUID(), user_id: accountId, provider: 'google', provider_id: `synthetic-google-${n}`,
        account_status: 'active', created_at: timestamp };
      collections.auth_identities.push(identity);
      await client.query(`insert into auth.accounts(id,subject,legacy_identity_user_id,source_system)
        values ($1,$2,$1,'legacy_identity')`, [accountId, `synthetic-account-${n}`]);
      await client.query(`insert into auth.external_identities(id,account_id,issuer,subject,source_system)
        values ($1,$2,'https://accounts.google.com',$3,'legacy_identity')`,
      [deterministicUuid(`legacy-provider-identity:${identity.id}`), accountId, identity.provider_id]);
    }
    const hid = 'HID-TEST' + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(n / 32)]
      + 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n % 32];
    await client.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,source_system,source_record_id)
      values ($1::uuid,$2,$3,'Synthetic','Patient','Synthetic Patient','legacy_identity',$1::text)`, [patientId, accountId, hid]);
  }
  // A retained category verifies that unrelated preserved payloads remain sealed.
  collections.medical_records.push({ id: randomUUID(), title: 'Synthetic archival record' });
  const rows = []; const counts = {}; const checksums = {};
  for (const [type, payloads] of Object.entries(collections)) {
    const category = payloads.map(payload => ({ type, pk: payload.id ?? payload.patient_id,
      payload, checksum: sha256(canonicalJson(payload)) })).sort((a, b) => a.pk.localeCompare(b.pk));
    rows.push(...category); counts[type] = category.length;
    checksums[type] = sha256(category.map(row => `${row.pk}:${row.checksum}\n`).join(''));
  }
  const checksum = sha256(canonicalJson({ counts, checksums }));
  await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
    values ($1,'legacy_identity','synthetic-rehearsal','stage','running','synthetic-test')`, [parentId]);
  for (const row of rows) await client.query(`insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256)
    values ($1,$2,$3,$4,$5)`, [parentId, row.type, row.pk, JSON.stringify(row.payload), row.checksum]);
  for (const type of Object.keys(counts)) await client.query(`insert into migration.entity_reconciliations
    (run_id,entity_type,source_count,target_count,source_checksum_sha256,target_checksum_sha256)
    values ($1,$2,$3,$3,$4,$4)`, [parentId, type, counts[type], checksums[type]]);
  await client.query(`update migration.runs set status='staged',source_counts=$2,source_checksum_sha256=$3 where id=$1`,
    [parentId, JSON.stringify(counts), checksum]);
  await client.query(`update migration.runs set status='verified',mode='reconcile',completed_at=now(),target_counts=$2,target_checksum_sha256=$3 where id=$1`,
    [parentId, JSON.stringify(counts), checksum]);
  for (const payload of collections.patient_access_secrets) {
    const plaintext = canonicalJson({ source_table: 'public.hid_patient_access_secrets', payload });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${parentId}:${payload.patient_id}:patient-access-secret`));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
    await client.query(`insert into migration.legacy_patient_access_secrets
      (id,run_id,patient_id,encrypted_payload,payload_sha256,encryption_key_reference)
      values ($1,$2,$3,$4,$5,'synthetic-key-v1')`, [randomUUID(), parentId, payload.patient_id, ciphertext, sha256(plaintext)]);
  }
  const script = fileURLToPath(new URL('./promote-staging-cutover-additions.mjs', import.meta.url));
  const env = { ...process.env, NODE_ENV: 'test', HID_DEPLOYMENT_ENV: 'staging', DATABASE_URL: databaseUrl,
    DATABASE_SSL: 'false', MIGRATION_PARENT_RUN_ID: parentId, MIGRATION_PARENT_SOURCE_CHECKSUM: checksum,
    MIGRATION_OPERATOR: 'synthetic-test', MIGRATION_FIELD_KEY_REFERENCE: 'synthetic-key-v1',
    MIGRATION_FIELD_ENCRYPTION_KEY_B64: keyEnvelope.toString('base64') };
  delete env.DATABASE_SSL_ROOT_CERT_BASE64;
  const run = (args = [], failure) => {
    try {
      const output = execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(failure, undefined, 'Expected rejection');
      return JSON.parse(output);
    } catch (error) {
      if (!failure) throw new Error(`Synthetic bridge failed: ${String(error.stderr ?? error.message).trim()}`);
      assert.match(String(error.stderr), failure);
    }
  };
  const pinCount = async () => Number((await client.query('select count(*) as n from identity.patient_access_pins')).rows[0].n);
  assert.equal(run().mode, 'dry-run'); assert.equal(await pinCount(), 0);
  assert.equal((await client.query("select count(*)::int n from migration.runs where source_system='staging_cutover_additions'")).rows[0].n, 0);
  // A mismapped Google identity must reject before any PIN or receipt is written.
  const subject = collections.auth_identities[0].provider_id;
  const accountId = collections.accounts[0].id;
  await client.query('update auth.external_identities set account_id=$1 where subject=$2', [collections.accounts[1].id, subject]);
  run(['--apply'], /Google mapping differs/); assert.equal(await pinCount(), 0);
  await client.query('update auth.external_identities set account_id=$1 where subject=$2', [accountId, subject]);
  const googlePatientId = collections.patients[0].id;
  await client.query('update identity.patients set account_id=null where id=$1', [googlePatientId]);
  run(['--apply'], /Google canonical patient association differs/); assert.equal(await pinCount(), 0);
  await client.query('update identity.patients set account_id=$1 where id=$2', [accountId, googlePatientId]);
  assert.equal(run(['--apply']).mode, 'applied'); assert.equal(await pinCount(), 39);
  run(['--apply']); assert.equal(await pinCount(), 39);
  assert.equal((await client.query("select count(*)::int n from migration.runs where source_system='staging_cutover_additions'")).rows[0].n, 1);
  const patientId = collections.patients[0].id;
  await client.query('update identity.patient_access_pins set row_version=2 where patient_id=$1', [patientId]);
  run(['--apply'], /no overwrite/);
  assert.equal(String((await client.query('select row_version from identity.patient_access_pins where patient_id=$1', [patientId])).rows[0].row_version), '2');
  assert.equal((await client.query('select source_checksum_sha256 from migration.runs where id=$1', [parentId])).rows[0].source_checksum_sha256.trim(), checksum);
  // Exercise the real rekey SQL against a generated legacy key envelope.
  const lookupEnvelope = randomBytes(33);
  const contactKey = randomBytes(32);
  const email = 'synthetic.patient@example.invalid';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${patientId}:email`));
  const encryptedEmail = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encryptedEmail]);
  const oldLookup = createHmac('sha256', lookupEnvelope.subarray(0, 32)).update(email).digest('hex');
  await client.query('update identity.patients set email_ciphertext=$2,email_lookup_hmac=$3,contact_key_version=$4 where id=$1',
    [patientId, ciphertext, oldLookup, 'synthetic-key-v1']);
  const rekeyEnv = { ...env, MIGRATION_SNAPSHOT_ID: 'synthetic-rehearsal',
    MIGRATION_LOOKUP_HMAC_KEY_B64: lookupEnvelope.toString('base64'), CONTACT_LOOKUP_HMAC_KEY_B64: contactKey.toString('base64'),
    OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'), NIN_ENCRYPTION_KEY_B64: randomBytes(32).toString('base64') };
  const rekey = args => execFileSync(process.execPath,
    [fileURLToPath(new URL('./rekey-patient-contact-lookups.mjs', import.meta.url)), ...args],
    { env: rekeyEnv, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const contact = async () => (await client.query('select email_ciphertext,email_lookup_hmac,row_version from identity.patients where id=$1', [patientId])).rows[0];
  rekey(['--dry-run']); assert.equal((await contact()).email_lookup_hmac.trim(), oldLookup);
  rekey(['--apply']); const migratedContact = await contact();
  assert.equal(migratedContact.email_lookup_hmac.trim(), contactLookupHmac('email', email, contactKey));
  assert.deepEqual(migratedContact.email_ciphertext, ciphertext);
  rekey(['--apply']); assert.deepEqual(await contact(), migratedContact);
  return { dryRunRolledBack: true, googleMismatchRejected: true, pinsPreserved: 39,
    repeatedApplyIdempotent: true, changedPinNotOverwritten: true, originalRunUnchanged: true,
    contactRekey: 'dry-run, apply and repeat preserved ciphertext; generated legacy keys accepted' };
}
