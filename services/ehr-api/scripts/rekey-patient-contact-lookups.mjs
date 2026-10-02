#!/usr/bin/env node

// Controlled one-shot rekey for rows written before the dedicated contact
// lookup domain existed. Dry-run is the default; --apply commits one complete,
// serializable reconciliation. No contact or digest is printed.
import { createDecipheriv, createHmac } from 'node:crypto';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';
import { contactLookupHmac, normalizeContactForLookup } from './contact-lookup.mjs';

const { Client } = pg;
const apply = process.argv.includes('--apply');
if (process.argv.some((arg) => arg.startsWith('--') && arg !== '--apply' && arg !== '--dry-run')) {
  throw new Error('Only --apply or --dry-run is supported');
}
if (apply && process.argv.includes('--dry-run')) throw new Error('Choose --apply or --dry-run');
const databaseUrl = process.env.DATABASE_URL;
const operator = process.env.MIGRATION_OPERATOR;
const snapshot = process.env.MIGRATION_SNAPSHOT_ID;
if (!databaseUrl || !operator || !snapshot) {
  throw new Error('DATABASE_URL, MIGRATION_OPERATOR and MIGRATION_SNAPSHOT_ID are required');
}

function key(name) {
  const encoded = process.env[name];
  if (!encoded) throw new Error(`${name} is required`);
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 32 || value.toString('base64') !== encoded) throw new Error(`${name} must be exactly 32 base64-encoded bytes`);
  return value;
}

const contactKey = key('CONTACT_LOOKUP_HMAC_KEY_B64');
const legacyLookupKey = key('MIGRATION_LOOKUP_HMAC_KEY_B64');
const legacyFieldKey = key('MIGRATION_FIELD_ENCRYPTION_KEY_B64');
const enrollmentKey = key('NIN_ENCRYPTION_KEY_B64');
const otpKey = key('OTP_HMAC_KEY_B64');

function legacyContact(ciphertext, patientId, channel) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 30 || ciphertext[0] !== 1) {
    throw new Error('Legacy contact ciphertext is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', legacyFieldKey, ciphertext.subarray(1, 13));
  decipher.setAAD(Buffer.from(`${patientId}:${channel}`, 'utf8'));
  decipher.setAuthTag(ciphertext.subarray(13, 29));
  return Buffer.concat([decipher.update(ciphertext.subarray(29)), decipher.final()]).toString('utf8');
}

function enrollmentContact(ciphertext, enrollmentId) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 30 || ciphertext[0] !== 1) {
    throw new Error('Enrollment contact ciphertext is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', enrollmentKey, ciphertext.subarray(1, 13));
  decipher.setAAD(Buffer.from(`identity:public-patient-enrollment:${enrollmentId}:contact`, 'utf8'));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(13, -16)), decipher.final()]).toString('utf8');
}

function hmac(keyValue, value) {
  return createHmac('sha256', keyValue).update(value, 'utf8').digest('hex');
}

function oldEnrollmentRecipientHmac(channel, contact) {
  return hmac(otpKey, ['patient-enrollment-recipient', channel, contact].join('\u001f'));
}

function identical(left, right) {
  return String(left ?? '').trim() === right;
}

function assertUnique(seen, channel, digest, patientId) {
  const keyValue = `${channel}:${digest}`;
  const priorPatient = seen.get(keyValue);
  if (priorPatient && priorPatient !== patientId) throw new Error('Canonical contact conflict; no rows were changed');
  seen.set(keyValue, patientId);
}

async function main() {
  const client = new Client(databaseOptions(databaseUrl, 'hid-contact-rekey'));
  await client.connect();
  try {
    await client.query('begin isolation level serializable');
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-contact-lookup-rekey', 0))");
    const seen = new Map();
    const legacyChanges = [];
    const enrollmentChanges = [];

    const legacy = await client.query(`
      select id, phone_e164_ciphertext, phone_lookup_hmac, email_ciphertext, email_lookup_hmac
      from identity.patients where source_system = 'legacy_identity' order by id for update`);
    for (const row of legacy.rows) {
      const changed = {};
      for (const [channel, ciphertext, prior] of [
        ['phone', row.phone_e164_ciphertext, row.phone_lookup_hmac],
        ['email', row.email_ciphertext, row.email_lookup_hmac],
      ]) {
        if (ciphertext === null) {
          if (prior !== null) throw new Error('Legacy contact lookup lacks ciphertext');
          continue;
        }
        const plaintext = legacyContact(ciphertext, row.id, channel);
        const normalized = normalizeContactForLookup(channel, plaintext);
        if (normalized !== plaintext) throw new Error('Legacy contact normalization changed; review source before rekey');
        const canonical = contactLookupHmac(channel, normalized, contactKey);
        const previous = hmac(legacyLookupKey, normalized);
        if (!identical(prior, previous) && !identical(prior, canonical)) {
          throw new Error('Legacy contact lookup does not match its ciphertext');
        }
        assertUnique(seen, channel, canonical, row.id);
        if (!identical(prior, canonical)) changed[channel] = canonical;
      }
      if (Object.keys(changed).length > 0) legacyChanges.push({ id: row.id, ...changed });
    }

    const enrollments = await client.query(`
      select enrollment.id, enrollment.state, enrollment.patient_id, enrollment.contact_channel,
             enrollment.contact_ciphertext, enrollment.contact_hmac, enrollment.contact_lookup_hmac,
             patient.source_system as patient_source_system,
             patient.phone_e164_ciphertext, patient.phone_lookup_hmac,
             patient.email_ciphertext, patient.email_lookup_hmac
      from identity.public_patient_enrollments enrollment
      left join identity.patients patient on patient.id = enrollment.patient_id
      where enrollment.contact_hmac is not null
      order by enrollment.id for update of enrollment`);
    for (const row of enrollments.rows) {
      const channel = row.contact_channel;
      if (!['phone', 'email'].includes(channel) || !row.contact_ciphertext) {
        throw new Error('Enrollment contact evidence is incomplete');
      }
      const plaintext = enrollmentContact(row.contact_ciphertext, row.id);
      const normalized = normalizeContactForLookup(channel, plaintext);
      if (normalized !== plaintext || !identical(row.contact_hmac, oldEnrollmentRecipientHmac(channel, normalized))) {
        throw new Error('Enrollment recipient does not match verified contact evidence');
      }
      const canonical = contactLookupHmac(channel, normalized, contactKey);
      if (row.contact_lookup_hmac && !identical(row.contact_lookup_hmac, canonical)) {
        throw new Error('Existing canonical enrollment lookup does not match evidence');
      }
      if (row.state === 'active') {
        if (!row.patient_id || row.patient_source_system !== 'hid-public-qoreid-enrollment') {
          throw new Error('Active enrollment has no exact public patient');
        }
        const patientCiphertext = channel === 'phone' ? row.phone_e164_ciphertext : row.email_ciphertext;
        const patientLookup = channel === 'phone' ? row.phone_lookup_hmac : row.email_lookup_hmac;
        if (!Buffer.isBuffer(patientCiphertext) || !patientCiphertext.equals(row.contact_ciphertext)
            || (!identical(patientLookup, row.contact_hmac) && !identical(patientLookup, canonical))) {
          throw new Error('Active enrollment patient contact does not match enrollment evidence');
        }
        assertUnique(seen, channel, canonical, row.patient_id);
      }
      const patientLookup = channel === 'phone' ? row.phone_lookup_hmac : row.email_lookup_hmac;
      if (!identical(row.contact_lookup_hmac, canonical)
          || (row.state === 'active' && !identical(patientLookup, canonical))) {
        enrollmentChanges.push({ id: row.id, patientId: row.patient_id, channel, canonical,
          updateEnrollment: !identical(row.contact_lookup_hmac, canonical),
          updatePatient: row.state === 'active' && !identical(patientLookup, canonical) });
      }
    }

    for (const change of legacyChanges) {
      await client.query(`update identity.patients
        set phone_lookup_hmac = coalesce($2, phone_lookup_hmac),
            email_lookup_hmac = coalesce($3, email_lookup_hmac),
            updated_at = clock_timestamp(), row_version = row_version + 1
        where id = $1 and source_system = 'legacy_identity'`,
      [change.id, change.phone ?? null, change.email ?? null]);
    }
    for (const change of enrollmentChanges) {
      if (change.updateEnrollment) await client.query(`update identity.public_patient_enrollments
        set contact_lookup_hmac = $2, updated_at = clock_timestamp(), row_version = row_version + 1
        where id = $1`, [change.id, change.canonical]);
      if (change.updatePatient) await client.query(`update identity.patients
        set phone_lookup_hmac = case when $2 = 'phone' then $3 else phone_lookup_hmac end,
            email_lookup_hmac = case when $2 = 'email' then $3 else email_lookup_hmac end,
            updated_at = clock_timestamp(), row_version = row_version + 1
        where id = $1 and source_system = 'hid-public-qoreid-enrollment'`,
      [change.patientId, change.channel, change.canonical]);
    }
    if (apply) await client.query(`insert into migration.patient_contact_lookup_rekeys
      (source_snapshot,operator,legacy_patient_count,legacy_contact_count,enrollment_count)
      values ($1,$2,$3,$4,$5)`, [
      snapshot, operator, legacy.rows.length,
      legacy.rows.reduce((count, row) => count
        + Number(row.phone_e164_ciphertext !== null)
        + Number(row.email_ciphertext !== null), 0),
      enrollments.rows.length,
    ]);
    if (apply) await client.query('commit');
    else await client.query('rollback');
    process.stdout.write(`${apply ? 'Applied' : 'Dry-run verified'} contact rekey for ${legacyChanges.length} legacy patients and ${enrollmentChanges.length} public enrollments; source snapshot ${snapshot}; operator ${operator}.\n`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Contact rekey blocked: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
