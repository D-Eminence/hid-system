import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import type { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import type { ExportRegistrationsDto } from './dto/export-registrations.dto';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import type { AddCampaignMemberDto } from './dto/add-campaign-member.dto';
import type { SaveRegistrationScreeningDto } from './dto/registration-screening.dto';
import type { ConfirmHealthIdDto, StartHealthIdDto } from './dto/health-id.dto';
import { registrationHealthIds } from './registration-health-ids';
import { OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS, ReadBudgetExceeded, withinBudget } from './health-id-budget';
import type { OutreachCampaign, CampaignMember, CampaignRole, CampaignStaff } from './campaign.types';
import { registrationCase, type OutreachRegistrationCase, type RegistrationRow } from './outreach.types';
import { isOutreachTenant, OUTREACH_NOTES_LIMIT, outreachRuleProblem, tenantNoHealthIdLink } from './outreach-tenant';
import { assertScreeningPlausible, normalizeScreening, registrationScreening, screeningRefusal,
  type RegistrationScreening, type ScreeningRow } from './registration-screening';

interface IdempotencyRow { request_sha256: string; registration_case_id: string }

/**
 * The registration's screening as the session can see it (0118's row-level
 * security), in one read per registration: null when there is none, else how
 * many health checks it holds (0 for a form saved with nothing filled in).
 * hasScreening is whether it is not null, hasRecordedChecks whether it is
 * above 0. No health value leaves here: the registration list, read, create
 * and link answers carry neither genotype nor blood group (finding of 14 Nov
 * 2026: those are read one person at a time, with a screening read audit row).
 * Genotype and blood group (0122) are counted through to_jsonb, so this read
 * names no 0122 column and runs on a database without them.
 */
const HAS_SCREENING = `(select num_nonnulls(screening.bp_systolic,screening.bp_diastolic,screening.pulse_bpm,
    screening.temperature_c,screening.weight_kg,screening.height_cm,screening.glucose_value,screening.glucose_unit,
    screening.glucose_timing,screening.malaria_rdt,screening.hearing_left,screening.hearing_right,
    screening.main_complaint,screening.seen_by_clinician,screening.clinician_name,screening.outcome,screening.referred,
    screening.referred_to,to_jsonb(screening)->>'genotype',to_jsonb(screening)->>'blood_group')
    + (jsonb_array_length(screening.medicines_given) > 0)::int
  from outreach.registration_screenings screening
  where screening.registration_case_id=registration_cases.id) as screening_values`;

/** The optional screening fields beyond 0118's that a database with 0122 takes. */
export const SCREENING_EXTRAS = ['genotype', 'bloodGroup'] as const;

/**
 * Whether the screenings table has 0122's columns, from a "select *" on it:
 * node-postgres names every selected column in `fields`, rows or none. The
 * service names genotype and blood_group only then, so this build runs on a
 * database without 0122 (a release that rolls outreach-api before the
 * migration): the health checks save and read as before, and the website is
 * told (accepts: []) not to offer the two boxes.
 */
function hasBloodColumns(result: { fields?: readonly { name: string }[] }): boolean {
  const names = new Set((result.fields ?? []).map((field) => field.name));
  return names.has('genotype') && names.has('blood_group');
}

/** A screening save's answer: 201 for the first save, 200 for an update or a replay. */
export interface ScreeningSaveResult {
  status: 200 | 201;
  screening: RegistrationScreening;
  /** The extra fields this database takes (0122): genotype and bloodGroup, or none before 0122. */
  accepts: readonly string[];
}

/** A screening read: the screening or null, and the extra fields this database takes. */
export interface ScreeningReadResult { screening: RegistrationScreening | null; accepts: readonly string[] }

const SCREENING_COLUMNS = `bp_systolic,bp_diastolic,pulse_bpm,temperature_c,weight_kg,height_cm,
  glucose_value,glucose_unit,glucose_timing,malaria_rdt,hearing_left,hearing_right,main_complaint,
  seen_by_clinician,clinician_name,outcome,medicines_given,referred,referred_to`;

/** 403 for anyone but a campaign's own admins (0111, ADR-045 option B). */
function campaignAdminRequired(what: string): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED', `Only this Outreach campaign's admins can ${what}`);
}

/** The database's own admin refusals (0111's trigger and member policy) as the same 403; anything else unchanged. */
function adminRefusal(error: unknown, what: string): unknown {
  const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === '42501' && (message === 'Outreach campaign admin is required'
    || message.includes('"outreach_campaign_members_admin_create"'))) return campaignAdminRequired(what);
  return error;
}

export interface RegistrationListOptions { readonly campaignId?: string; readonly limit?: number; readonly before?: string }

/** The opaque list cursor: base64url of "<created_at in microseconds since epoch>.<id>". */
export function encodeRegistrationCursor(micros: string, id: string): string {
  return Buffer.from(`${micros}.${id}`, 'utf8').toString('base64url');
}

export function decodeRegistrationCursor(cursor: string): { micros: string; id: string } {
  const match = /^(\d{1,16})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(/^[A-Za-z0-9_-]{1,96}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '');
  const micros = match?.[1];
  const id = match?.[2];
  // At most 2^53 - 1 (about the year 2255): the SQL multiplies through float8,
  // exact only up to there, and overflows near the bigint maximum.
  if (micros === undefined || id === undefined || BigInt(micros) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainProblem(400, 'OUTREACH_LIST_CURSOR_INVALID', 'The list cursor is not valid; start from the first page');
  }
  return { micros, id: id.toLowerCase() };
}

@Injectable()
export class OutreachService {
  private readonly logger = new Logger(OutreachService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreateRegistrationCaseDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    const normalized = { ...input, fullName: input.fullName.trim(),
      phone: input.phone?.trim() || null, operationalNotes: input.operationalNotes?.trim() || null };
    // The area (0118) is in the digest only when given, so a request without it digests as before.
    const area = input.area?.replace(/\u0000/g, '').trim().replace(/\s+/g, ' ') || undefined;
    if (area) normalized.area = area;
    else delete normalized.area;
    const tenant = isOutreachTenant(context);
    if (tenant) this.assertTenantRegistration(normalized);
    const digest = requestDigest('outreach.registration-case.create', normalized);
    try {
      return await this.database.withTransaction(context, async (client) => {
        const replay = await this.replay(client, context, 'registration_case_create', idempotencyKey, digest);
        if (replay) return replay;
        if (normalized.campaignId) await this.assertCampaignAcceptsRegistration(client, normalized.campaignId, context);
        const inserted = await client.query<RegistrationRow>(`insert into outreach.registration_cases (
          facility_id,created_by_account_id,created_by_membership_id,local_command_id,
          temporary_patient_id,full_name,sex,age_years,phone,operational_notes,campaign_id,area
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [context.facilityId, context.actor.accountId, context.membershipId, normalized.localCommandId,
          normalized.temporaryPatientId, normalized.fullName, normalized.sex, normalized.ageYears,
          normalized.phone, normalized.operationalNotes, normalized.campaignId ?? null, normalized.area ?? null]);
        const row = inserted.rows[0];
        if (!row) throw new Error('Outreach registration insert returned no row');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,actor_account_id,actor_membership_id
        ) values ($1,'registration_case_received',$2,$3,$4,$5)`,
        [row.id, context.facilityId, row.temporary_patient_id, context.actor.accountId, context.membershipId]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_create',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, row.id]);
        await this.outbox(client, 'OutreachRegistrationCaseCreated', row.id, 1, context, null,
          { registrationCaseId: row.id, temporaryPatientId: row.temporary_patient_id,
            campaignId: row.campaign_id, status: 'identity_resolution_pending' });
        // The person's agreement, in the same transaction (plan PR-4): the
        // database refuses an outreach group's registration without it.
        if (normalized.consent) {
          // 0115's policy: the capturer is the request's own account and membership.
          await client.query(`insert into outreach.registration_consents (
            registration_case_id,facility_id,consent_text_version,language,method,guardian_name,
            captured_by_account_id,captured_by_membership_id
          ) values ($1,$2,$3,$4,$5,$6,platform.current_account_id(),$7)`,
          [row.id, context.facilityId, normalized.consent.textVersion, normalized.consent.language,
            normalized.consent.method, normalized.consent.guardianName ?? null, context.membershipId]);
        }
        await this.audit.recordWithClient(client, context, 'outreach.registration-case.received', row.id);
        const value = registrationCase(row);
        if (!row.campaign_id) return value;
        return { ...value, possibleDuplicate: await this.possibleDuplicate(client, row) };
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      // Outside the transaction: a duplicate of a concurrent identical request
      // is retried and replayed; only a conflict that remains is a 409.
      this.translateConflict(error, 'OUTREACH_REGISTRATION_CONFLICT',
        'This local Outreach registration was already received');
      this.translateCampaignRefusal(error);
      const rule = outreachRuleProblem(error);
      if (rule) throw rule;
      throw error;
    }
  }

  /**
   * What an outreach group's registration needs before anything is written
   * (plan PR-1/PR-4; the database checks the same): a campaign, the person's
   * agreement, a parent's or guardian's name for anyone under 18, and short
   * notes with no diagnoses.
   */
  private assertTenantRegistration(input: Omit<CreateRegistrationCaseDto, 'phone' | 'operationalNotes'>
    & { operationalNotes: string | null }): void {
    if (!input.campaignId) {
      throw new DomainProblem(422, 'OUTREACH_CAMPAIGN_REQUIRED', 'Choose the campaign this person is being registered in.');
    }
    if (!input.consent) {
      throw new DomainProblem(422, 'OUTREACH_CONSENT_REQUIRED',
        'Read the notice to the person and record how they agreed before registering them.');
    }
    if (input.ageYears < 18 && !input.consent.guardianName) {
      throw new DomainProblem(422, 'OUTREACH_CONSENT_GUARDIAN_REQUIRED',
        'This person is under 18. Enter the name of the parent or guardian who agreed.');
    }
    if (input.operationalNotes && input.operationalNotes.length > OUTREACH_NOTES_LIMIT) {
      throw new DomainProblem(422, 'OUTREACH_NOTES_TOO_LONG',
        `Keep notes to ${OUTREACH_NOTES_LIMIT} characters, and do not write diagnoses.`);
    }
  }

  /**
   * A hint, never a refusal (field critique): another registration in the
   * same campaign has the same phone, or the same name and age. Read as the
   * caller, so it sees only what the caller may see.
   */
  private async possibleDuplicate(client: PoolClient, row: RegistrationRow): Promise<boolean> {
    const result = await client.query<{ found: boolean }>(`select exists (
        select 1 from outreach.registration_cases other
         where other.campaign_id=$1 and other.facility_id=$2 and other.id<>$3
           and ((other.phone is not null and other.phone=$4)
             or (lower(btrim(other.full_name))=lower(btrim($5)) and other.age_years=$6))
      ) as found`, [row.campaign_id, row.facility_id, row.id, row.phone, row.full_name, row.age_years]);
    return result.rows[0]?.found === true;
  }

  /** Records an export of the registration list (format and count only; 0118 follow-up, no migration). */
  async recordExport(input: ExportRegistrationsDto, context: DataAccessContext): Promise<void> {
    await this.database.withTransaction(context, async (client) => {
      if (input.campaignId) {
        // A campaign at the facility that the session is a member of (0045): never
        // an audit row naming a campaign the person cannot see.
        const campaign = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2
          and outreach.registration_campaign_member(id, facility_id)`, [input.campaignId, context.facilityId]);
        if (!campaign.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      }
      await this.audit.recordExportWithClient(client, context,
        { format: input.format, count: input.count, campaignId: input.campaignId ?? null });
    });
  }

  /**
   * The registrations the session can see, newest first: a page of `limit`
   * (default 100, at most 500), optionally one campaign's, before a cursor.
   * Without options it answers exactly as before (the newest 100). nextCursor
   * is set when more rows exist; it encodes (created_at in whole
   * microseconds, id), compared exactly in SQL.
   */
  async list(context: DataAccessContext, options: RegistrationListOptions = {}):
    Promise<readonly OutreachRegistrationCase[] & { nextCursor?: string }> {
    const limit = options.limit ?? 100;
    const cursor = options.before === undefined ? null : decodeRegistrationCursor(options.before);
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<RegistrationRow & { cursor_micros: string }>(`select registration_cases.*,${HAS_SCREENING},
          ((extract(epoch from created_at) * 1000000)::numeric(20,0))::text as cursor_micros
        from outreach.registration_cases where facility_id=$1
          and ($2::uuid is null or campaign_id = $2::uuid)
          and ($3::bigint is null or (created_at, id) < (timestamptz 'epoch' + $3::bigint * interval '1 microsecond', $4::uuid))
        order by created_at desc,id desc limit $5`,
      [context.facilityId, options.campaignId ?? null, cursor?.micros ?? null, cursor?.id ?? null, limit + 1]);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.list', context.facilityId);
      const rows = result.rows.slice(0, limit);
      const healthIds = await registrationHealthIds(client, rows.map((row) => row.id));
      const page: OutreachRegistrationCase[] & { nextCursor?: string } = rows.map(({ cursor_micros: _cursor, ...row }) =>
        registrationCase(row, healthIds.get(row.id) ?? null));
      const last = rows[rows.length - 1];
      if (result.rows.length > limit && last) page.nextCursor = encodeRegistrationCursor(last.cursor_micros, last.id);
      return page;
    });
  }

  async get(id: string, context: DataAccessContext): Promise<OutreachRegistrationCase> {
    return this.database.withTransaction(context, async (client) => {
      const value = await this.find(client, id);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.read', id,
        value.resolvedPatientId ?? undefined);
      return value;
    });
  }

  async linkExisting(id: string, input: LinkExistingPatientDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    // An outreach group never links anyone to a Health ID (plan PR-4); the
    // person does it later from their own account. Identity and the database
    // refuse it too.
    if (isOutreachTenant(context)) throw tenantNoHealthIdLink();
    await this.identity.authorizeExistingPatient(input.canonicalPatientId, context);
    const normalized = { ...input, reason: input.reason.trim() };
    const digest = requestDigest('outreach.registration-case.link-existing', { id, ...normalized });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const replay = await this.replay(client, context, 'registration_case_link_existing',
          idempotencyKey, digest);
        if (replay) return replay;
        const currentResult = await client.query<RegistrationRow>(
          'select * from outreach.registration_cases where id=$1 for update', [id]);
        const current = currentResult.rows[0];
        if (!current) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
          'The Outreach registration case was not found');
        if (current.status !== 'identity_resolution_pending') throw new DomainProblem(409,
          'OUTREACH_REGISTRATION_ALREADY_RESOLVED', 'The Outreach registration case is already resolved');
        if (Number(current.row_version) !== normalized.expectedVersion) throw new DomainProblem(412,
          'VERSION_CONFLICT', 'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.patient_mappings (
          registration_case_id,facility_id,temporary_patient_id,canonical_patient_id,
          resolution_kind,resolved_by_account_id,resolved_by_membership_id,reason
        ) values ($1,$2,$3,$4,'linked_existing',$5,$6,$7)`,
        [id, context.facilityId, current.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        const updated = await client.query<RegistrationRow>(`update outreach.registration_cases set
          status='identity_resolved',resolved_patient_id=$2,resolution_kind='linked_existing',
          resolved_by_account_id=$3,resolved_by_membership_id=$4,resolution_reason=$5,
          resolved_at=clock_timestamp(),row_version=row_version+1
          where id=$1 and row_version=$6 returning *,${HAS_SCREENING}`,
        [id, normalized.canonicalPatientId, context.actor.accountId, context.membershipId,
          normalized.reason, normalized.expectedVersion]);
        const row = updated.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT',
          'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,canonical_patient_id,
          actor_account_id,actor_membership_id,reason
        ) values ($1,'existing_patient_linked',$2,$3,$4,$5,$6,$7)`,
        [id, context.facilityId, row.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_link_existing',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, id]);
        await this.outbox(client, 'OutreachPatientResolved', id, Number(row.row_version), context,
          normalized.canonicalPatientId, { registrationCaseId: id,
            temporaryPatientId: row.temporary_patient_id, campaignId: row.campaign_id,
            canonicalPatientId: normalized.canonicalPatientId,
            resolutionKind: 'linked_existing' });
        await this.audit.recordWithClient(client, context, 'outreach.patient.linked-existing', id,
          normalized.canonicalPatientId);
        return registrationCase(row);
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      this.translateConflict(error, 'OUTREACH_RESOLUTION_CONFLICT',
        'The Outreach registration has a conflicting patient resolution');
      const rule = outreachRuleProblem(error);
      if (rule) throw rule;
      throw error;
    }
  }

  /**
   * The screening of a registration (0118), or null when none was recorded.
   * 404 when the session cannot see the registration. One audit row (ids only).
   */
  async getScreening(caseId: string, context: DataAccessContext): Promise<RegistrationScreening | null> {
    return (await this.readScreening(caseId, context)).screening;
  }

  /**
   * getScreening, with the extra fields this database takes (0122's genotype
   * and bloodGroup, or none on a database without them), for the answer's
   * `accepts`.
   */
  async readScreening(caseId: string, context: DataAccessContext): Promise<ScreeningReadResult> {
    return this.database.withTransaction(context, async (client) => {
      await this.assertCaseVisible(client, caseId);
      const result = await client.query<ScreeningRow>(
        'select * from outreach.registration_screenings where registration_case_id=$1', [caseId]);
      await this.audit.recordWithClient(client, context, 'outreach.registration-screening.read', caseId);
      const row = result.rows[0];
      return { screening: row ? registrationScreening(row) : null,
        accepts: hasBloodColumns(result) ? SCREENING_EXTRAS : [] };
    });
  }

  /**
   * Saves a registration's whole screening (0118): version 1 on the first save
   * (no If-Match), the next version on an update (If-Match the current one).
   * The last save's Idempotency-Key and digest are kept on the row: the same
   * key and body answer the current screening (200), the same key with another
   * body 409 IDEMPOTENCY_CONFLICT. Genotype and blood group (0122) left out of
   * the body are kept as recorded on an update (null clears them). On a
   * database without 0122 they are never named: a body giving either a value
   * is refused (409 OUTREACH_SCREENING_FIELDS_NOT_TAKEN), null is ignored.
   */
  async saveScreening(caseId: string, input: SaveRegistrationScreeningDto, expectedVersion: number | undefined,
    idempotencyKey: string, context: DataAccessContext): Promise<ScreeningSaveResult> {
    const fields = normalizeScreening(input);
    assertScreeningPlausible(fields);
    // Genotype and blood group (0122) are in the digest only when the body
    // carried them, so a body without them digests as before.
    const digest = requestDigest('registration_screening_save', { caseId, ...fields });
    const values = [fields.bpSystolic, fields.bpDiastolic, fields.pulseBpm, fields.temperatureC, fields.weightKg,
      fields.heightCm, fields.glucoseValue, fields.glucoseUnit, fields.glucoseTiming, fields.malariaRdt,
      fields.hearingLeft, fields.hearingRight, fields.mainComplaint, fields.seenByClinician, fields.clinicianName,
      fields.outcome, JSON.stringify(fields.medicinesGiven), fields.referred, fields.referredTo];
    try {
      return await this.database.withTransaction(context, async (client): Promise<ScreeningSaveResult> => {
        await this.assertCaseVisible(client, caseId);
        const selected = await client.query<ScreeningRow>(`select * from outreach.registration_screenings
          where registration_case_id=$1 for update`, [caseId]);
        const current = selected.rows[0];
        const blood = hasBloodColumns(selected);
        if (!blood && ((fields.genotype ?? null) !== null || (fields.bloodGroup ?? null) !== null)) {
          throw new DomainProblem(409, 'OUTREACH_SCREENING_FIELDS_NOT_TAKEN',
            'Genotype and blood group cannot be saved yet. Save the other health checks without them.');
        }
        const accepts = blood ? SCREENING_EXTRAS : [];
        if (current && current.idempotency_key === idempotencyKey) {
          if (current.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
            'The Idempotency-Key belongs to a different Outreach request');
          return { status: 200, screening: registrationScreening(current), accepts };
        }
        let row: ScreeningRow | undefined;
        if (!current) {
          if (expectedVersion !== undefined) throw new DomainProblem(412, 'VERSION_CONFLICT',
            'The screening changed; reload before saving');
          row = (await client.query<ScreeningRow>(`insert into outreach.registration_screenings (
            registration_case_id,facility_id,${SCREENING_COLUMNS},version,
            recorded_by_account_id,recorded_by_membership_id,updated_by_account_id,updated_by_membership_id,
            idempotency_key,request_sha256${blood ? ',genotype,blood_group' : ''}
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,1,
            $22,$23,$22,$23,$24,$25${blood ? ',$26,$27' : ''}) returning *`,
          [caseId, context.facilityId, ...values, context.actor.accountId, context.membershipId,
            idempotencyKey, digest, ...(blood ? [fields.genotype ?? null, fields.bloodGroup ?? null] : [])])).rows[0];
        } else {
          if (expectedVersion === undefined) throw new DomainProblem(409, 'OUTREACH_SCREENING_EXISTS',
            'This person already has a screening; reload it and save your changes over it');
          if (Number(current.version) !== expectedVersion) throw new DomainProblem(412, 'VERSION_CONFLICT',
            'The screening changed; reload before saving');
          row = (await client.query<ScreeningRow>(`update outreach.registration_screenings set
            bp_systolic=$2,bp_diastolic=$3,pulse_bpm=$4,temperature_c=$5,weight_kg=$6,height_cm=$7,
            glucose_value=$8,glucose_unit=$9,glucose_timing=$10,malaria_rdt=$11,hearing_left=$12,hearing_right=$13,
            main_complaint=$14,seen_by_clinician=$15,clinician_name=$16,outcome=$17,medicines_given=$18::jsonb,
            referred=$19,referred_to=$20,version=version+1,updated_by_account_id=$21,updated_by_membership_id=$22,
            idempotency_key=$23,request_sha256=$24${blood ? `,
            genotype=case when $26::boolean then $27::text else genotype end,
            blood_group=case when $28::boolean then $29::text else blood_group end` : ''}
            where registration_case_id=$1 and version=$25 returning *`,
          [caseId, ...values, context.actor.accountId, context.membershipId, idempotencyKey, digest,
            expectedVersion, ...(blood ? [fields.genotype !== undefined, fields.genotype ?? null,
              fields.bloodGroup !== undefined, fields.bloodGroup ?? null] : [])])).rows[0];
          if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'The screening changed; reload before saving');
        }
        if (!row) throw new Error('Outreach screening save returned no row');
        await this.audit.recordWithClient(client, context, 'outreach.registration-screening.recorded', caseId);
        return { status: current ? 200 : 201, screening: registrationScreening(row), accepts };
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      // A concurrent first save that committed first and remains after the retry.
      this.translateConflict(error, 'OUTREACH_SCREENING_EXISTS',
        'This person already has a screening; reload it and save your changes over it');
      throw screeningRefusal(error) ?? outreachRuleProblem(error) ?? error;
    }
  }

  /** 404 unless the session can see the registration (its row-level security). */
  private async assertCaseVisible(client: PoolClient, caseId: string): Promise<void> {
    const result = await client.query('select id from outreach.registration_cases where id=$1', [caseId]);
    if (!result.rows[0]) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
      'The Outreach registration case was not found');
  }

  async listCampaigns(context: DataAccessContext): Promise<readonly OutreachCampaign[]> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query(`select id, facility_id as "facilityId", name, services, status, starts_at as "startsAt",
        ends_at as "endsAt", row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"
        from outreach.campaigns where facility_id=$1 order by starts_at desc,id`, [context.facilityId]);
      return result.rows.map((row) => ({ ...row, rowVersion: Number(row.rowVersion),
        startsAt: new Date(row.startsAt).toISOString(), endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() }));
    }, { readOnly: true });
  }

  async createCampaign(input: CreateCampaignDto, context: DataAccessContext): Promise<OutreachCampaign> {
    const services = [...new Set(input.services)];
    if (input.endsAt && new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
      throw new DomainProblem(400, 'OUTREACH_CAMPAIGN_DATES_INVALID', 'An Outreach campaign must end after it starts');
    }
    return this.withRules(() => this.database.withTransaction(context, async (client) => {
      const result = await client.query(`insert into outreach.campaigns
        (facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at,ends_at)
        values ($1,$2,$3,$4,$5,$6,$7) returning id,facility_id as "facilityId",name,services,status,
        starts_at as "startsAt",ends_at as "endsAt",row_version as "rowVersion",created_at as "createdAt",updated_at as "updatedAt"`,
        [context.facilityId, context.actor.accountId, context.membershipId, input.name.trim(), services,
          input.startsAt, input.endsAt ?? null]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'OUTREACH_CAMPAIGN_UNAVAILABLE', 'Campaign could not be created');
      await client.query(`insert into outreach.campaign_members
        (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
        values ($1,$2,$3,'admin',$4,$3)`,
      [row.id, context.facilityId, context.membershipId, context.actor.accountId]);
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_created',$3,$4,$5::jsonb,$6)`,
        [row.id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ name: row.name, services }), context.correlationId]);
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_member_added',$3,$4,$5::jsonb,$6)`,
        [row.id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ membershipId: context.membershipId, role: 'admin' }), context.correlationId]);
      await this.audit.recordWithClient(client, context, 'outreach.campaign.created', row.id);
      return { ...row, rowVersion: Number(row.rowVersion), startsAt: new Date(row.startsAt).toISOString(),
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
    }, { isolationLevel: 'SERIALIZABLE' }));
  }

  /** Runs a command and answers an outreach group's database rules in plain English. */
  private async withRules<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw outreachRuleProblem(error) ?? error;
    }
  }

  async updateCampaignStatus(id: string, input: UpdateCampaignStatusDto, expectedVersion: number, context: DataAccessContext): Promise<OutreachCampaign> {
    return this.withRules(() => this.database.withTransaction(context, async (client) => {
      const current = (await client.query(`select * from outreach.campaigns where id=$1 and facility_id=$2 for update`, [id, context.facilityId])).rows[0];
      if (!current) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      // 0111 (ADR-045 option B): only this campaign's own admins open or close it.
      if (await this.campaignRole(client, id, context) !== 'admin') throw campaignAdminRequired('open or close it');
      if (Number(current.row_version) !== expectedVersion) throw new DomainProblem(412, 'VERSION_CONFLICT', 'The Outreach campaign changed; reload before retrying');
      if (current.status === input.status) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_STATE_CONFLICT', 'The Outreach campaign is already in that state');
      if (current.status === 'closed') throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_CLOSED', 'A closed Outreach campaign cannot be reopened');
      if (input.status === 'active' && new Date(current.starts_at).getTime() > Date.now()) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_NOT_STARTED', 'The Outreach campaign cannot become active before its start time');
      const updated = (await client.query(`update outreach.campaigns set status=$3,row_version=row_version+1 where id=$1 and facility_id=$2 returning *`, [id, context.facilityId, input.status])
        .catch((error: unknown) => { throw adminRefusal(error, 'open or close it'); })).rows[0];
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_status_changed',$3,$4,$5::jsonb,$6)`,
        [id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ from: current.status, to: input.status, reason: input.reason.trim() }), context.correlationId]);
      await this.audit.recordWithClient(client, context, 'outreach.campaign.status-changed', id);
      return { id: updated.id, facilityId: updated.facility_id, name: updated.name, services: updated.services,
        status: updated.status, startsAt: new Date(updated.starts_at).toISOString(), endsAt: updated.ends_at ? new Date(updated.ends_at).toISOString() : null,
        rowVersion: Number(updated.row_version), createdAt: new Date(updated.created_at).toISOString(), updatedAt: new Date(updated.updated_at).toISOString() };
    }));
  }

  async listCampaignMembers(id: string, context: DataAccessContext): Promise<readonly CampaignMember[]> {
    return this.database.withTransaction(context, async (client) => {
      const exists = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!exists.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      const result = await client.query(`select id,campaign_id as "campaignId",membership_id as "membershipId",role,created_at as "createdAt"
        from outreach.campaign_members where campaign_id=$1 and facility_id=$2 order by created_at,id`, [id, context.facilityId]);
      return result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    }, { readOnly: true });
  }

  async addCampaignMember(id: string, input: AddCampaignMemberDto, context: DataAccessContext): Promise<CampaignMember> {
    return this.withRules(() => this.database.withTransaction(context, async (client) => {
      const campaign = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!campaign.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      // 0111 (ADR-045 option B): only this campaign's own admins add members, and only active staff at the facility.
      if (await this.campaignRole(client, id, context) !== 'admin') throw campaignAdminRequired('add members');
      const person = (await client.query<{ campaign_role: string | null }>(`select campaign_role
        from outreach.campaign_staff($1) where membership_id=$2`, [id, input.membershipId])).rows[0];
      if (!person) throw new DomainProblem(422, 'OUTREACH_STAFF_NOT_AVAILABLE', 'That person is not an active staff member at this facility');
      if (person.campaign_role) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_MEMBER_EXISTS', 'The staff member is already in this Outreach campaign');
      try {
        const result = await client.query(`insert into outreach.campaign_members
          (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
          values ($1,$2,$3,$4,$5,$6) returning id,campaign_id as "campaignId",membership_id as "membershipId",role,created_at as "createdAt"`,
          [id, context.facilityId, input.membershipId, input.role, context.actor.accountId, context.membershipId]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'OUTREACH_CAMPAIGN_UNAVAILABLE', 'Campaign membership could not be added');
        await client.query(`insert into outreach.campaign_events
          (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
          values ($1,$2,'campaign_member_added',$3,$4,$5::jsonb,$6)`,
          [id, context.facilityId, context.actor.accountId, context.membershipId, JSON.stringify({ membershipId: input.membershipId, role: input.role }), context.correlationId]);
        await this.audit.recordWithClient(client, context, 'outreach.campaign.member-added', id);
        return { ...row, createdAt: new Date(row.createdAt).toISOString() };
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === '23505') {
          throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_MEMBER_EXISTS', 'The staff member is already in this Outreach campaign');
        }
        throw adminRefusal(error, 'add members');
      }
    }, { isolationLevel: 'SERIALIZABLE' }));
  }

  /**
   * The governance answer (#222's endpoint, plan PR-4): how campaigns are
   * governed, and for an outreach group whether it is paused.
   * organiserStatus: 'not_outreach_group' at a hospital's facility;
   * 'unverified' (an outreach group that is not paused: its campaigns can go
   * live at once, and Health ID has not verified it, owner decision Q38),
   * 'suspended' (paused by Health ID), or 'unknown' when it cannot be read.
   * Free for now and with no per-organiser limits (owner decisions 2 and 6).
   */
  async campaignGovernance(context: DataAccessContext): Promise<{ rule: 'campaign_admins';
    organiserStatus: 'not_outreach_group' | 'unverified' | 'suspended' | 'unknown' }> {
    if (!isOutreachTenant(context)) return { rule: 'campaign_admins', organiserStatus: 'not_outreach_group' };
    try {
      const state = await this.database.withTransaction(context, async (client) =>
        // 0115's outreach.organiser_status() answers a scalar: 'suspended' for a paused group, another
        // state for one that is not paused, or null when the facility is not an outreach group.
        (await client.query<{ organiser_status: string | null }>('select outreach.organiser_status() as organiser_status'))
          .rows[0]?.organiser_status, { readOnly: true });
      const organiserStatus = state === 'suspended' ? 'suspended' as const
        : typeof state === 'string' && state.length > 0 ? 'unverified' as const : 'unknown' as const;
      return { rule: 'campaign_admins', organiserStatus };
    } catch {
      return { rule: 'campaign_admins', organiserStatus: 'unknown' };
    }
  }

  /**
   * Who is in a campaign, by name, and to its admins who could be added (0111's outreach.campaign_staff), with the
   * caller's own role in it. A non-member gets no one.
   */
  async listCampaignStaff(id: string, context: DataAccessContext): Promise<CampaignStaff> {
    return this.database.withTransaction(context, async (client) => {
      const exists = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!exists.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      const result = await client.query<{ membership_id: string; display_name: string; campaign_role: CampaignRole | null }>(
        `select membership_id, display_name, campaign_role from outreach.campaign_staff($1)`, [id]);
      const people = result.rows.map((row) => ({ membershipId: row.membership_id, name: row.display_name,
        campaignRole: row.campaign_role }));
      return { yourRole: people.find((person) => person.membershipId === context.membershipId)?.campaignRole ?? null, people };
    }, { readOnly: true });
  }

  /** The caller's own role in a campaign of its facility, or null. */
  private async campaignRole(client: PoolClient, campaignId: string, context: DataAccessContext): Promise<string | null> {
    const result = await client.query<{ role: string }>(`select role from outreach.campaign_members
      where campaign_id=$1 and facility_id=$2 and membership_id=$3`, [campaignId, context.facilityId, context.membershipId]);
    return result.rows[0]?.role ?? null;
  }

  private async replay(client: PoolClient, context: DataAccessContext, operation: string,
    key: string, digest: string): Promise<OutreachRegistrationCase | null> {
    const result = await client.query<IdempotencyRow>(`select request_sha256,registration_case_id
      from outreach.command_idempotency where requester_account_id=$1 and facility_id=$2
      and operation=$3 and idempotency_key=$4`,
    [context.actor.accountId, context.facilityId, operation, key]);
    const replay = result.rows[0];
    if (!replay) return null;
    if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
      'The Idempotency-Key belongs to a different Outreach request');
    return this.find(client, replay.registration_case_id);
  }

  /**
   * Requires the actor's membership in an active registration campaign, and
   * share-locks the campaign until the registration commits: a status change
   * locks it FOR UPDATE, so it waits for the registration, or the registration
   * for it. The membership row is read, not locked. The runtime role cannot
   * lock campaign_members (no UPDATE, 42501), and no API command changes or
   * deletes a membership. The registration trigger checks the membership
   * again at the insert, reading it as its owner and locking only the campaign
   * (0110: campaign_members forces row-level security and has no UPDATE
   * policy, so before 0110 its membership lock refused every campaign
   * registration under a migration owner without BYPASSRLS); its refusal
   * answers 403 like this check. The campaign lock needs the campaign UPDATE
   * policy, so it relies on every role with outreach.registration.write also
   * holding outreach.campaign.write (runtime-command-privileges.integration.sql
   * checks this); without it the lock returns no row and the request is refused.
   */
  private async assertCampaignAcceptsRegistration(client: PoolClient, campaignId: string,
    context: DataAccessContext): Promise<void> {
    const result = await client.query<{ status: string; services: string[];
      starts_at: Date | string; ends_at: Date | string | null }>(`select campaign.status,campaign.services,
        campaign.starts_at,campaign.ends_at from outreach.campaigns campaign
        join outreach.campaign_members member on member.campaign_id=campaign.id
          and member.facility_id=campaign.facility_id and member.membership_id=$3
        where campaign.id=$1 and campaign.facility_id=$2 for share of campaign`,
    [campaignId, context.facilityId, context.membershipId]);
    const campaign = result.rows[0];
    if (!campaign) throw new DomainProblem(403, 'OUTREACH_CAMPAIGN_ACCESS_DENIED',
      'Exact membership in this Outreach campaign is required');
    const now = Date.now();
    if (campaign.status !== 'active' || !campaign.services.includes('registration')
      || new Date(campaign.starts_at).getTime() > now
      || (campaign.ends_at && new Date(campaign.ends_at).getTime() <= now)) {
      throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS',
        'This Outreach campaign is not accepting registrations');
    }
  }

  private async find(client: PoolClient, id: string): Promise<OutreachRegistrationCase> {
    const result = await client.query<RegistrationRow>(
      `select registration_cases.*,${HAS_SCREENING} from outreach.registration_cases where id=$1`, [id]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
      'The Outreach registration case was not found');
    return registrationCase(row, (await registrationHealthIds(client, [row.id])).get(row.id) ?? null);
  }

  /**
   * Assisted Health ID (0119), email path: Identity sends the person a code.
   * SMS is not live yet: 503 before anything is asked of Identity.
   */
  async startHealthId(caseId: string, input: StartHealthIdDto, idempotencyKey: string, context: DataAccessContext) {
    if (input.channel === 'sms') {
      throw new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE',
        "Codes by SMS aren't available yet. Use the person's email.", undefined, { exposeDetail: true });
    }
    const email = input.email?.trim() ?? '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new DomainProblem(422, 'OUTREACH_HEALTH_ID_EMAIL_INVALID', 'Enter a valid email address.');
    }
    return this.identity.startHealthId(caseId, { channel: 'email', email }, idempotencyKey, context);
  }

  /** Assisted Health ID (0119): the person's code; 201 { healthId, registration } (a replay too). */
  async confirmHealthId(caseId: string, input: ConfirmHealthIdDto, context: DataAccessContext) {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      throw new DomainProblem(422, 'OUTREACH_HEALTH_ID_CODE_INVALID', "That code isn't right. Check the email and try again.");
    }
    const created = await this.identity.confirmHealthId(caseId, code, context);
    return { healthId: created.healthId, registration: await this.get(caseId, context) };
  }

  /**
   * No contact at all (0120): Identity creates the Health ID with no account
   * and a one-time claim code; 201 { healthId, claimCode, claimExpiresAt,
   * registration }. The claim code passes through and is never stored,
   * logged or audited here. A second call finds the Health ID created and
   * Identity answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED with it only.
   *
   * A code Identity returned is never thrown away: the registration is read
   * before Identity is asked, and if reading it again afterwards fails, the
   * 201 answers that earlier read with the new Health ID set on it.
   */
  async createUnverifiedHealthId(caseId: string, context: DataAccessContext) {
    // Each read is bounded so the whole call (read, Identity's 20 s, read)
    // ends well before the browser (45 s) and the gateway (60 s) give up: a
    // slow read before Identity is asked refuses 503 with nothing created; a
    // slow read after answers the earlier read with the new Health ID.
    const before = await withinBudget(this.get(caseId, context), OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS)
      .catch((error: unknown) => {
        if (error instanceof ReadBudgetExceeded) {
          throw new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE',
            "The Health ID can't be created right now. Try again in a few minutes.", undefined, { exposeDetail: true });
        }
        throw error;
      });
    const created = await this.identity.createUnclaimedHealthId(caseId, context);
    let registration: OutreachRegistrationCase;
    try {
      registration = await withinBudget(this.get(caseId, context), OUTREACH_HEALTH_ID_CREATE_READ_BUDGET_MS);
    } catch (error) {
      this.logger.warn({ event: 'outreach.health-id.create-unverified.reread-failed', caseId,
        correlationId: context.correlationId,
        exceptionType: error instanceof Error ? error.constructor.name : 'UnknownException' });
      registration = { ...before, healthId: created.healthId, healthIdCreatedByOutreach: true,
        healthIdStatus: 'unclaimed' };
    }
    return { healthId: created.healthId, claimCode: created.claimCode, claimExpiresAt: created.claimExpiresAt,
      registration };
  }

  private outbox(client: PoolClient, eventType: string, id: string, version: number,
    context: DataAccessContext, patientId: string | null, payload: Record<string, unknown>) {
    return client.query(`insert into outreach.outbox_events (
      event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [eventType, id, version, context.facilityId, patientId, context.correlationId, JSON.stringify(payload)]);
  }

  /**
   * The registration trigger (outreach.validate_registration_campaign_write,
   * 0045, 0110) checks the campaign again at the insert. Its refusals answer as
   * this service's own check does, not 500: a membership removed after the
   * check, or a campaign that stopped accepting registrations in between.
   */
  private translateCampaignRefusal(error: unknown): void {
    if (typeof error !== 'object' || error === null) return;
    const { code, message, constraint } = error as { code?: unknown; message?: unknown; constraint?: unknown };
    // MaxLength (validator.js) does not count variation selectors such as
    // U+FE0F and Postgres length() does, so a rare area passes the DTO and
    // fails the database check: a 422, not a 500.
    if (code === '23514' && constraint === 'registration_cases_area_ck') {
      throw new DomainProblem(422, 'OUTREACH_AREA_INVALID', 'Enter the area in 100 characters or fewer.');
    }
    if (code === '42501' && message === 'Exact Outreach campaign membership is required') {
      throw new DomainProblem(403, 'OUTREACH_CAMPAIGN_ACCESS_DENIED',
        'Exact membership in this Outreach campaign is required');
    }
    if (code === '23514' && message === 'Outreach campaign is not accepting registrations') {
      throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS',
        'This Outreach campaign is not accepting registrations');
    }
  }

  private translateConflict(error: unknown, problemCode: string, detail: string): void {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code : undefined;
    if (code === '23505') throw new DomainProblem(409, problemCode, detail);
  }
}
