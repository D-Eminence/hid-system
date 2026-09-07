#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import pg from 'pg';
import { databaseOptions } from './database-options.mjs';

const { Client } = pg;
const targetUrl = process.env.DATABASE_URL;
const runId = process.env.MIGRATION_RUN_ID;
const operator = process.env.MIGRATION_OPERATOR;
const encryptionKeyReference = process.env.MIGRATION_FIELD_KEY_REFERENCE;
const facilityTimezones = parseFacilityTimezones(process.env.MIGRATION_FACILITY_TIMEZONES_JSON);
const encryptionKey = decodeKey('MIGRATION_FIELD_ENCRYPTION_KEY_B64', 32);
const lookupKey = decodeKey('MIGRATION_LOOKUP_HMAC_KEY_B64', 32);
const batchSize = Number.parseInt(process.env.MIGRATION_BATCH_SIZE ?? '250', 10);

if (!targetUrl) throw new Error('DATABASE_URL is required');
if (!runId) throw new Error('MIGRATION_RUN_ID is required');
if (!operator) throw new Error('MIGRATION_OPERATOR is required');
if (!encryptionKeyReference) throw new Error('MIGRATION_FIELD_KEY_REFERENCE is required');
if (!Number.isSafeInteger(batchSize) || batchSize < 10 || batchSize > 5_000) {
  throw new Error('MIGRATION_BATCH_SIZE must be between 10 and 5000');
}

class PromotionConflict extends Error {
  constructor(entityType, sourcePk, conflictType, sourceHash, targetHash, details) {
    super(`${conflictType} for ${entityType}/${sourcePk}`);
    this.entityType = entityType;
    this.sourcePk = sourcePk;
    this.conflictType = conflictType;
    this.sourceHash = sourceHash;
    this.targetHash = targetHash;
    this.details = details;
  }
}

function decodeKey(name, minimumBytes) {
  const encoded = process.env[name];
  if (!encoded) throw new Error(`${name} is required`);
  const value = Buffer.from(encoded, 'base64');
  if (value.length < minimumBytes) throw new Error(`${name} must decode to at least ${minimumBytes} bytes`);
  return value.subarray(0, minimumBytes);
}

function parseFacilityTimezones(value) {
  if (!value) throw new Error('MIGRATION_FACILITY_TIMEZONES_JSON is required');
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('MIGRATION_FACILITY_TIMEZONES_JSON must be a facility UUID to IANA timezone object');
  }
  for (const [facilityId, timezone] of Object.entries(parsed)) {
    if (!/^[0-9a-f-]{36}$/i.test(facilityId) || typeof timezone !== 'string') {
      throw new Error('Invalid facility timezone mapping');
    }
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  }
  return parsed;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify({ base64: value.toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error(`Unsupported canonical value: ${typeof value}`);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacLookup(value) {
  return createHmac('sha256', lookupKey).update(value, 'utf8').digest('hex');
}

function encrypt(value, associatedData) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), nonce, tag, ciphertext]);
}

function decrypt(value, associatedData) {
  if (!Buffer.isBuffer(value) || value.length < 30 || value[0] !== 1) throw new Error('Unsupported ciphertext envelope');
  const nonce = value.subarray(1, 13);
  const tag = value.subarray(13, 29);
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
}

function dateOrNull(value) {
  return value ? new Date(value) : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function recordOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uuidOrNull(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function correlationOrFallback(value, eventId) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
    ? value
    : `legacy:${eventId}`;
}

function legacyAuditOutcome(value) {
  if (value === 'deny' || value === 'not_found' || value === 'denied') return 'denied';
  if (value === 'failure' || value === 'failed') return 'failure';
  return 'success';
}

function normalizePhone(value) {
  return value ? String(value).replace(/[^0-9+]/g, '') : null;
}

function normalizeEmail(value) {
  return value ? String(value).trim().toLowerCase() : null;
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function deterministicUuid(namespace) {
  const bytes = createHash('sha256').update(namespace, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedRoleCode(value) {
  const aliases = new Map([
    ['doctor', 'doctor'],
    ['clinician', 'clinician'],
    ['nurse', 'nurse'],
    ['lab', 'lab'],
    ['laboratory', 'lab'],
    ['lab_technician', 'lab'],
    ['pharmacist', 'pharmacist'],
    ['receptionist', 'receptionist'],
    ['admin', 'admin'],
    ['org_admin', 'org_admin'],
  ]);
  return aliases.get(String(value ?? '').toLowerCase()) ?? null;
}

async function validateRbacVocabulary(client) {
  const availableRoles = new Set((await client.query('select code from auth.roles where active')).rows.map((row) => row.code));
  let cursor = '';
  for (;;) {
    const rows = await stagedRows(client, 'memberships', cursor);
    if (rows.rows.length === 0) break;
    for (const row of rows.rows) {
      cursor = row.source_pk;
      const source = row.payload;
      const requested = [source.membership_role, source.app_role]
        .filter((value) => value && value !== 'patient' && value !== 'platform_admin');
      for (const value of requested) {
        const normalized = normalizedRoleCode(value);
        if (!normalized || !availableRoles.has(normalized)) {
          throw new PromotionConflict(
            'memberships',
            row.source_pk,
            'invalid_source_value',
            row.payload_sha256.trim(),
            null,
            { field: 'role', reason: 'unmapped_or_unconfigured_role' },
          );
        }
      }
    }
  }
}

async function stagedRows(client, entityType, cursor) {
  return client.query(
    `select source_pk, payload, payload_sha256
       from migration.source_rows
      where run_id = $1 and entity_type = $2 and source_pk > $3
      order by source_pk
      limit $4`,
    [runId, entityType, cursor, batchSize],
  );
}

async function insertExact(client, entityType, sourceRow, tableName, data, comparisonColumns = Object.keys(data), conflictColumn = 'id') {
  const [schema, table] = tableName.split('.');
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  let inserted;
  try {
    inserted = await client.query(
      `insert into ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
         (${columns.map(quoteIdentifier).join(', ')})
       values (${placeholders.join(', ')})
       on conflict (${quoteIdentifier(conflictColumn)}) do nothing`,
      values,
    );
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    const constraint = typeof error === 'object' && error !== null && 'constraint' in error ? error.constraint : undefined;
    throw new PromotionConflict(
      entityType,
      sourceRow.source_pk,
      code === '23503' ? 'missing_dependency' : code === '23514' ? 'invalid_source_value' : 'target_content_mismatch',
      sourceRow.payload_sha256.trim(),
      null,
      { table: tableName, databaseCode: code ?? 'unknown', constraint: constraint ?? null },
    );
  }
  if (inserted.rowCount > 0) return;

  const expectedInput = Object.fromEntries(comparisonColumns.map((column) => [column,
    Buffer.isBuffer(data[column]) ? `\\x${data[column].toString('hex')}` : data[column],
  ]));
  // Read the proposed values through the same PostgreSQL column types as the
  // existing row. pg returns bigint as text and date/timestamptz as Date;
  // comparing untyped JS input falsely blocks exact retries. No row is changed.
  const expectedResult = await client.query(
    `select ${comparisonColumns.map(quoteIdentifier).join(', ')}
       from jsonb_populate_record(null::${quoteIdentifier(schema)}.${quoteIdentifier(table)}, $1::jsonb)`,
    [JSON.stringify(expectedInput)],
  );
  const expected = expectedResult.rows[0];
  const existing = await client.query(
    `select ${comparisonColumns.map(quoteIdentifier).join(', ')}
       from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}
      where ${quoteIdentifier(conflictColumn)} = $1`,
    [data[conflictColumn]],
  );
  const actual = existing.rows[0];
  const expectedHash = sha256(canonicalJson(expected));
  const actualHash = actual ? sha256(canonicalJson(actual)) : null;
  if (!actual || actualHash !== expectedHash) {
    throw new PromotionConflict(
      entityType,
      sourceRow.source_pk,
      'target_content_mismatch',
      sourceRow.payload_sha256.trim(),
      actualHash,
      { table: tableName, constraint: conflictColumn },
    );
  }
}

async function requireTarget(client, tableName, id, entityType, sourceRow) {
  const [schema, table] = tableName.split('.');
  const result = await client.query(
    `select id from ${quoteIdentifier(schema)}.${quoteIdentifier(table)} where id = $1`,
    [id],
  );
  if (!result.rows[0]) {
    throw new PromotionConflict(
      entityType,
      sourceRow.source_pk,
      'missing_dependency',
      sourceRow.payload_sha256.trim(),
      null,
      { missingTable: tableName, missingId: String(id) },
    );
  }
  return result.rows[0];
}

async function profileForAuthUser(client, authUserId) {
  const result = await client.query(
    `select payload
       from migration.source_rows
      where run_id = $1 and entity_type = 'user_profiles'
        and payload->>'auth_user_id' = $2
      limit 1`,
    [runId, authUserId],
  );
  return result.rows[0]?.payload;
}

async function accountForProfile(client, profileId) {
  if (!profileId) return null;
  const result = await client.query(
    `select account_row.id
       from migration.source_rows staged_profile
       join auth.accounts account_row on account_row.id::text = staged_profile.payload->>'auth_user_id'
      where staged_profile.run_id = $1
        and staged_profile.entity_type = 'user_profiles'
        and staged_profile.source_pk = $2
      limit 1`,
    [runId, profileId],
  );
  return result.rows[0]?.id ?? null;
}

async function promoteEntity(client, entityType, transform) {
  let cursor = '';
  let promoted = 0;
  for (;;) {
    const result = await stagedRows(client, entityType, cursor);
    if (result.rows.length === 0) break;
    await client.query('begin isolation level serializable');
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended('hid-legacy-promotion', 0))");
      for (const row of result.rows) {
        await transform(row);
        cursor = row.source_pk;
        promoted += 1;
      }
      await client.query(
        `update migration.source_rows set promoted_at = coalesce(promoted_at, clock_timestamp())
          where run_id = $1 and entity_type = $2 and source_pk = any($3::text[])`,
        [runId, entityType, result.rows.map((row) => row.source_pk)],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
  process.stdout.write(`${entityType}: promoted or matched ${promoted}\n`);
}

async function main() {
  const client = new Client(databaseOptions(targetUrl, 'hid-legacy-promoter'));
  await client.connect();
  try {
    const runResult = await client.query(
      `select id, status, source_system from migration.runs where id = $1`,
      [runId],
    );
    const run = runResult.rows[0];
    if (!run || run.source_system !== 'legacy_identity' || run.status !== 'staged') {
      throw new Error('MIGRATION_RUN_ID must reference a staged legacy_identity run');
    }
    const conflicts = await client.query('select count(*)::integer as count from migration.conflicts where run_id = $1', [runId]);
    if ((conflicts.rows[0]?.count ?? 0) > 0) throw new Error('Run has conflicts; create a new corrected staging run');
    await validateRbacVocabulary(client);

    await promoteEntity(client, 'accounts', async (row) => {
      const source = row.payload;
      const passwordHash = textOrNull(source.encrypted_password);
      if (passwordHash && !/^\$2[aby]\$/.test(passwordHash)) {
        throw new PromotionConflict('accounts', row.source_pk, 'invalid_source_value', row.payload_sha256.trim(), null, { field: 'encrypted_password', reason: 'unsupported_algorithm' });
      }
      const profile = await profileForAuthUser(client, source.id);
      const createdAt = new Date(source.created_at);
      const updatedAt = new Date(source.updated_at ?? source.created_at);
      const accountStatus = source.deleted_at
        ? 'deleted'
        : source.email_confirmed_at
          ? 'active'
          : 'pending_reset';
      const data = {
        id: source.id,
        subject: source.id,
        email: textOrNull(source.email),
        display_name: textOrNull(profile?.display_name),
        status: accountStatus,
        disabled_until: dateOrNull(source.banned_until),
        email_verified_at: dateOrNull(source.email_confirmed_at),
        password_hash: passwordHash,
        password_algorithm: passwordHash ? 'bcrypt_legacy' : null,
        password_changed_at: null,
        token_version: 1,
        row_version: 1,
        legacy_identity_user_id: source.id,
        source_system: 'legacy_identity',
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: updatedAt,
      };
      await insertExact(client, 'accounts', row, 'auth.accounts', data);
      const external = {
        id: deterministicUuid(`legacy-identity:${source.id}`),
        account_id: source.id,
        issuer: 'legacy-identity',
        subject: source.id,
        status: accountStatus === 'active' ? 'active' : 'disabled',
        assurance_level: null,
        linked_at: createdAt,
        revoked_at: source.deleted_at ? dateOrNull(source.deleted_at) : null,
        source_system: 'legacy_identity',
      };
      await insertExact(client, 'accounts', row, 'auth.external_identities', external);
    });

    await promoteEntity(client, 'organizations', async (row) => {
      const source = row.payload;
      const createdAt = new Date(source.created_at);
      await insertExact(client, 'organizations', row, 'identity.organizations', {
        id: source.id,
        name: source.name,
        slug: source.slug,
        active: source.active,
        row_version: 1,
        source_system: 'legacy_identity',
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
      });
    });

    await promoteEntity(client, 'facilities', async (row) => {
      const source = row.payload;
      const timezone = facilityTimezones[source.id];
      if (!timezone) {
        throw new PromotionConflict('facilities', row.source_pk, 'invalid_source_value', row.payload_sha256.trim(), null, { field: 'timezone', reason: 'explicit_mapping_required' });
      }
      await requireTarget(client, 'identity.organizations', source.organization_id, 'facilities', row);
      const createdAt = new Date(source.created_at);
      await insertExact(client, 'facilities', row, 'identity.facilities', {
        id: source.id,
        organization_id: source.organization_id,
        name: source.name,
        code: source.code,
        active: source.active,
        // Match the immutable 0027 upgrade for facilities imported after that
        // migration has run. Leaving the new default 'pending' contradicts an
        // active legacy row and fails facilities_active_status_ck.
        lifecycle_status: source.active ? 'verified' : 'suspended',
        status_reason: 'Migrated from the pre-foundation active flag',
        status_changed_at: new Date(source.updated_at ?? source.created_at),
        timezone,
        row_version: 1,
        source_system: 'legacy_identity',
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
      });
    });

    await promoteEntity(client, 'patients', async (row) => {
      const source = row.payload;
      await requireTarget(client, 'auth.accounts', source.auth_user_id, 'patients', row);
      const phone = normalizePhone(source.phone_e164);
      const email = normalizeEmail(source.email);
      const emergencyContact = {
        name: source.emergency_contact_name ?? null,
        relationship: source.emergency_contact_relationship ?? null,
        phone: source.emergency_contact_phone ?? null,
        address: source.emergency_contact_address ?? null,
      };
      const hasEmergencyContact = Object.values(emergencyContact).some((value) => value !== null && value !== '');
      const createdAt = new Date(source.created_at);
      const data = {
        id: source.id,
        account_id: source.auth_user_id,
        hid_code: source.hid_code,
        first_name: source.first_name,
        last_name: source.last_name,
        full_name: source.full_name,
        phone_e164_ciphertext: phone ? encrypt(phone, `${source.id}:phone`) : null,
        phone_lookup_hmac: phone ? hmacLookup(phone) : null,
        email_ciphertext: email ? encrypt(email, `${source.id}:email`) : null,
        email_lookup_hmac: email ? hmacLookup(email) : null,
        contact_key_version: phone || email ? encryptionKeyReference : null,
        gender: textOrNull(source.gender),
        dob: source.dob ?? null,
        country: textOrNull(source.country),
        state: textOrNull(source.state),
        photo_object_key: null,
        emergency_contact_ciphertext: hasEmergencyContact
          ? encrypt(canonicalJson(emergencyContact), `${source.id}:emergency-contact`)
          : null,
        emergency_contact_key_version: hasEmergencyContact ? encryptionKeyReference : null,
        nin_last4: textOrNull(source.nin_last4),
        nin_hash: textOrNull(source.nin_hash),
        nin_ciphertext: textOrNull(source.nin_ciphertext),
        notifications_enabled: source.notifications_enabled ?? true,
        profile_percent: source.profile_percent ?? 0,
        status: source.deleted_at ? 'deleted' : 'active',
        row_version: 1,
        source_system: 'legacy_identity',
        source_record_id: source.id,
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
      };
      const encryptedColumns = new Set(['phone_e164_ciphertext', 'email_ciphertext', 'emergency_contact_ciphertext']);
      await insertExact(client, 'patients', row, 'identity.patients', data, Object.keys(data).filter((column) => !encryptedColumns.has(column)));

      const existing = await client.query(
        `select phone_e164_ciphertext, email_ciphertext, emergency_contact_ciphertext from identity.patients where id = $1`,
        [source.id],
      );
      const target = existing.rows[0];
      if ((phone && decrypt(target.phone_e164_ciphertext, `${source.id}:phone`) !== phone)
          || (!phone && target.phone_e164_ciphertext !== null)
          || (email && decrypt(target.email_ciphertext, `${source.id}:email`) !== email)
          || (!email && target.email_ciphertext !== null)
          || (hasEmergencyContact && decrypt(target.emergency_contact_ciphertext, `${source.id}:emergency-contact`) !== canonicalJson(emergencyContact))
          || (!hasEmergencyContact && target.emergency_contact_ciphertext !== null)) {
        throw new PromotionConflict('patients', row.source_pk, 'target_content_mismatch', row.payload_sha256.trim(), null, { field: 'encrypted_contact' });
      }

      const clinical = {
        blood_group: source.blood_group ?? null,
        genotype: source.genotype ?? null,
        allergies: source.allergies ?? null,
        chronic_conditions: source.chronic_conditions ?? null,
        current_medications: source.current_medications ?? null,
        medical_notes: source.medical_notes ?? null,
      };
      if (Object.values(clinical).some((value) => value !== null && value !== '')) {
        const plaintext = canonicalJson(clinical);
        const quarantine = {
          id: deterministicUuid(`${runId}:legacy-clinical:${source.id}`),
          run_id: runId,
          patient_id: source.id,
          source_record_id: source.id,
          encrypted_payload: encrypt(plaintext, `${runId}:${source.id}:legacy-clinical`),
          payload_sha256: sha256(plaintext),
          encryption_key_reference: encryptionKeyReference,
          status: 'quarantined',
          created_at: new Date(),
        };
        await insertExact(
          client,
          'patients',
          row,
          'migration.legacy_clinical_quarantine',
          quarantine,
          Object.keys(quarantine).filter((column) => !['encrypted_payload', 'created_at'].includes(column)),
        );
      }
    });

    await promoteEntity(client, 'patient_identifiers', async (row) => {
      const source = row.payload;
      await requireTarget(client, 'identity.patients', source.patient_id, 'patient_identifiers', row);
      const isPublic = source.identifier_type === 'hid_code';
      const normalized = String(source.normalized_value ?? source.raw_value).trim();
      const data = {
        id: source.id,
        patient_id: source.patient_id,
        identifier_type: source.identifier_type,
        public_value: isPublic ? normalized.toUpperCase() : null,
        value_ciphertext: isPublic ? null : encrypt(String(source.raw_value), `${source.id}:identifier`),
        lookup_hmac: isPublic ? null : hmacLookup(normalized.toLowerCase()),
        encryption_key_version: isPublic ? null : encryptionKeyReference,
        display_hint: null,
        verified: source.verified,
        source_system: 'legacy_identity',
        created_at: new Date(source.created_at),
      };
      await insertExact(client, 'patient_identifiers', row, 'identity.patient_identifiers', data, Object.keys(data).filter((column) => column !== 'value_ciphertext'));
      if (!isPublic) {
        const existing = await client.query('select value_ciphertext from identity.patient_identifiers where id = $1', [source.id]);
        if (decrypt(existing.rows[0].value_ciphertext, `${source.id}:identifier`) !== String(source.raw_value)) {
          throw new PromotionConflict('patient_identifiers', row.source_pk, 'target_content_mismatch', row.payload_sha256.trim(), null, { field: 'encrypted_identifier' });
        }
      }
    });

    await promoteEntity(client, 'staff', async (row) => {
      const source = row.payload;
      await requireTarget(client, 'auth.accounts', source.auth_user_id, 'staff', row);
      const createdAt = new Date(source.created_at);
      await insertExact(client, 'staff', row, 'identity.staff', {
        id: source.id,
        account_id: source.auth_user_id,
        full_name: source.full_name,
        email: source.email,
        hospital_name: textOrNull(source.hospital_name),
        verification_status: source.verification_status,
        license_number: textOrNull(source.license_number),
        default_role: source.role,
        active: source.active,
        row_version: 1,
        source_system: 'legacy_identity',
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
      });
    });

    await promoteEntity(client, 'memberships', async (row) => {
      const source = row.payload;
      await requireTarget(client, 'identity.staff', source.staff_account_id, 'memberships', row);
      await requireTarget(client, 'identity.organizations', source.organization_id, 'memberships', row);
      if (source.facility_id) await requireTarget(client, 'identity.facilities', source.facility_id, 'memberships', row);
      const staff = await client.query('select account_id from identity.staff where id = $1', [source.staff_account_id]);
      const createdAt = new Date(source.created_at);
      await insertExact(client, 'memberships', row, 'identity.staff_facility_memberships', {
        id: source.id,
        staff_id: source.staff_account_id,
        account_id: staff.rows[0].account_id,
        organization_id: source.organization_id,
        facility_id: source.facility_id ?? null,
        membership_role: source.membership_role,
        app_role: source.app_role,
        is_primary: source.is_primary,
        active: source.active,
        migration_hold_reason: !source.facility_id
          ? 'legacy_membership_missing_facility'
          : source.app_role === 'platform_admin'
            ? 'privileged_role_requires_reapproval'
            : null,
        source_system: 'legacy_identity',
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
        row_version: 1,
      });
      if (source.facility_id && source.app_role !== 'platform_admin') {
        const scopedRoleCodes = [...new Set([source.membership_role, source.app_role])]
          .map(normalizedRoleCode)
          .filter((code) => code !== null);
        for (const roleCode of scopedRoleCodes) {
          await insertExact(client, 'memberships', row, 'auth.account_roles', {
            id: deterministicUuid(`legacy-membership-role:${source.id}:${roleCode}`),
            account_id: staff.rows[0].account_id,
            role_code: roleCode,
            scope_type: 'facility',
            membership_id: source.id,
            facility_id: source.facility_id,
            granted_at: createdAt,
            granted_by: null,
            grant_reason: 'Legacy assignment retained during governed administration migration',
            revoked_at: source.active ? null : new Date(source.updated_at ?? source.created_at),
            // Match 0027's provenance fallback when the legacy source has no
            // revoking actor. Do not invent a privileged administrator.
            revoked_by: source.active ? null : staff.rows[0].account_id,
            revocation_reason: source.active ? null
              : 'Legacy revocation retained during governed administration migration',
          });
        }
      }
    });

    await promoteEntity(client, 'access_requests', async (row) => {
      const source = row.payload;
      await requireTarget(client, 'identity.patients', source.patient_id, 'access_requests', row);
      const membership = await client.query(
        `select staff_id, facility_id from identity.staff_facility_memberships where id = $1`,
        [source.requester_membership_id],
      );
      if (!membership.rows[0] || membership.rows[0].staff_id !== source.requester_staff_account_id) {
        throw new PromotionConflict('access_requests', row.source_pk, 'missing_dependency', row.payload_sha256.trim(), null, { dependency: 'exact_membership_staff' });
      }
      const createdAt = new Date(source.created_at);
      await insertExact(client, 'access_requests', row, 'identity.access_requests', {
        id: source.id,
        patient_id: source.patient_id,
        staff_id: source.requester_staff_account_id,
        membership_id: source.requester_membership_id,
        facility_id: membership.rows[0].facility_id,
        scope: source.scope,
        reason: source.reason,
        status: source.status,
        requested_duration_minutes: source.requested_duration_minutes,
        break_glass: source.break_glass,
        approved_by_patient_id: source.approved_by_patient_id ?? null,
        approved_at: dateOrNull(source.approved_at),
        denied_at: dateOrNull(source.denied_at),
        denied_reason: textOrNull(source.denied_reason),
        correlation_id: null,
        purpose_of_use: null,
        migration_hold_reason: 'legacy_request_purpose_unmapped',
        source_system: 'legacy_identity',
        source_record_id: source.id,
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
        row_version: 1,
      });
    });

    await promoteEntity(client, 'consent_grants', async (row) => {
      const source = row.payload;
      const membership = await client.query(
        `select staff_id, account_id, facility_id from identity.staff_facility_memberships where id = $1`,
        [source.membership_id],
      );
      const member = membership.rows[0];
      if (!member || member.staff_id !== source.staff_account_id) {
        throw new PromotionConflict('consent_grants', row.source_pk, 'missing_dependency', row.payload_sha256.trim(), null, { dependency: 'exact_membership_staff' });
      }
      const createdAt = new Date(source.created_at);
      const revokedBy = await accountForProfile(client, source.revoked_by_user_profile_id);
      await insertExact(client, 'consent_grants', row, 'identity.consent_grants', {
        id: source.id,
        request_id: null,
        source_request_id: source.request_id ? String(source.request_id) : null,
        patient_id: source.patient_id,
        staff_id: source.staff_account_id,
        account_id: member.account_id,
        membership_id: source.membership_id,
        facility_id: member.facility_id,
        scope: source.scope,
        status: source.status,
        granted_by_patient_id: source.granted_by_patient_id ?? null,
        reason: source.reason,
        starts_at: new Date(source.starts_at),
        expires_at: new Date(source.expires_at),
        revoked_at: dateOrNull(source.revoked_at),
        revoked_by: revokedBy,
        revoked_reason: textOrNull(source.revoked_reason),
        break_glass: source.scope === 'break_glass',
        correlation_id: null,
        purpose_of_use: null,
        migration_hold_reason: 'legacy_grant_purpose_unmapped',
        source_system: 'legacy_identity',
        source_record_id: source.id,
        source_created_at: createdAt,
        created_at: createdAt,
        updated_at: new Date(source.updated_at ?? source.created_at),
        row_version: 1,
      });
    });

    await promoteEntity(client, 'audit_events', async (row) => {
      const source = row.payload;
      const metadata = recordOrEmpty(source.metadata);
      const facilityId = uuidOrNull(metadata.facility_id);
      if (facilityId) {
        const facility = await client.query('select organization_id from identity.facilities where id = $1', [facilityId]);
        if (!facility.rows[0]
          || (source.organization_id && facility.rows[0].organization_id !== source.organization_id)) {
          throw new PromotionConflict(
            'audit_events', row.source_pk, 'missing_dependency', row.payload_sha256.trim(), null,
            { dependency: 'metadata_facility_organization' },
          );
        }
      }
      const actorAccount = source.actor_user_id
        ? await client.query('select id from auth.accounts where id = $1', [source.actor_user_id])
        : { rows: [] };
      await insertExact(client, 'audit_events', row, 'audit.events', {
        event_id: source.event_id,
        occurred_at: new Date(source.created_at),
        recorded_at: new Date(),
        correlation_id: correlationOrFallback(metadata.correlation_id ?? source.request_id, source.event_id),
        actor_type: 'legacy',
        actor_subject: source.actor_user_id ?? null,
        actor_account_id: actorAccount.rows[0]?.id ?? null,
        actor_membership_id: null,
        organization_id: source.organization_id ?? null,
        facility_id: facilityId,
        patient_id: source.patient_id ?? null,
        action: source.action,
        outcome: legacyAuditOutcome(metadata.outcome),
        resource_type: source.resource_type ?? null,
        resource_id: source.resource_id ? String(source.resource_id) : null,
        purpose_of_use: textOrNull(metadata.purpose),
        reason: source.reason ?? null,
        source_ip: source.ip_address ?? null,
        user_agent: source.user_agent ? String(source.user_agent).slice(0, 512) : null,
        provenance: 'legacy_identity',
        source_system: 'public.hid_audit_events',
        source_event_id: String(source.event_id),
        details: source.metadata ?? {},
      }, ['event_id', 'occurred_at', 'correlation_id', 'actor_type', 'actor_subject', 'actor_account_id', 'organization_id', 'facility_id', 'patient_id', 'action', 'outcome', 'resource_type', 'resource_id', 'reason', 'source_ip', 'user_agent', 'provenance', 'source_system', 'source_event_id', 'details'], 'event_id');
    });

    await client.query(
      `update migration.runs
          set mode = 'promote', notes = coalesce(notes, '') || E'\nPromotion completed; reconciliation required.'
        where id = $1 and status = 'staged'`,
      [runId],
    );
    process.stdout.write(`Promotion completed for run ${runId}; run reconciliation before cutover\n`);
  } catch (error) {
    if (error instanceof PromotionConflict) {
      await client.query(
        `insert into migration.conflicts (
           run_id, entity_type, source_pk, conflict_type, source_sha256, target_sha256, details
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         on conflict (run_id, entity_type, source_pk, conflict_type) do nothing`,
        [runId, error.entityType, error.sourcePk, error.conflictType, error.sourceHash, error.targetHash, JSON.stringify(error.details)],
      );
      await client.query("update migration.runs set status = 'blocked', notes = 'Promotion conflict; no overwrite performed' where id = $1", [runId]);
    } else {
      await client.query(
        `update migration.runs
            set status = 'failed', completed_at = clock_timestamp(),
                notes = 'Promotion failed; inspect restricted operational logs'
          where id = $1 and status <> 'blocked'`,
        [runId],
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Legacy promotion failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
