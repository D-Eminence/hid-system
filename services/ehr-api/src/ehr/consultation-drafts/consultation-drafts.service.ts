import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { requireVisitOpenForWork } from '../shared/visit-guard';
import type { CreateConsultationDraftDto, SaveConsultationDraftDto } from './consultation-drafts.dto';

/** Owner decision Q126 A: a draft's content, at most 256 KB as UTF-8 JSON, 20 levels deep. */
export const DRAFT_MAX_BYTES = 262_144;
export const DRAFT_MAX_DEPTH = 20;
/** 60 saves per member per minute (per ehr-api task, as the other in-memory limits). */
export const DRAFT_SAVES_PER_MINUTE = 60;

export const DRAFT_MESSAGES = {
  tooLarge: 'This draft is too large to save (limit 256 KB). Remove pasted text or split the note.',
  notFound: 'This draft was not found. It may have been finished, discarded or kept for more than 7 days.',
  exists: 'You already have a saved draft for this visit. Open it to carry on.',
  changed: 'This draft was saved from another tab or device. Reload it before you carry on.',
  limited: 'Saving too often. Your draft will save again in a few seconds.',
  unavailable: 'Drafts cannot be saved right now. Keep this page open and try again.',
} as const;

const DRAFT_COLUMNS = `id::text as "draftId", encounter_id::text as "encounterId", form_version as "formVersion",
  row_version::text as "rowVersion", size_bytes as "sizeBytes", created_at as "createdAt", saved_at as "savedAt",
  expires_at as "expiresAt"`;

interface DraftRow {
  draftId: string;
  encounterId: string | null;
  formVersion: number;
  rowVersion: string;
  sizeBytes: number;
  createdAt: Date;
  savedAt: Date;
  expiresAt: Date;
  content?: Record<string, unknown>;
}

export interface ConsultationDraft {
  draftId: string;
  encounterId: string | null;
  formVersion: number;
  rowVersion: number;
  sizeBytes: number;
  createdAt: string;
  savedAt: string;
  expiresAt: string;
  content?: Record<string, unknown>;
}

interface MyDraftRow {
  draft_id: string | null;
  encounter_id: string | null;
  saved_at: Date | null;
  expires_at: Date | null;
  patient_id: string | null;
  full_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string | null;
  hidden_count: string | number | null;
}

function draftAnswer(row: DraftRow): ConsultationDraft {
  return {
    draftId: row.draftId,
    encounterId: row.encounterId ?? null,
    formVersion: Number(row.formVersion),
    rowVersion: Number(row.rowVersion),
    sizeBytes: Number(row.sizeBytes),
    createdAt: new Date(row.createdAt).toISOString(),
    savedAt: new Date(row.savedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    ...(row.content !== undefined ? { content: row.content } : {}),
  };
}

/** The content's size as the database stores it, and its depth; refuses what is over the limits. */
export function checkDraftContent(content: Record<string, unknown>): number {
  const depth = (value: unknown, level: number): number => {
    if (level > DRAFT_MAX_DEPTH + 1) return level;
    if (Array.isArray(value)) return value.reduce<number>((max, item) => Math.max(max, depth(item, level + 1)), level);
    if (value && typeof value === 'object') {
      return Object.values(value).reduce<number>((max, item) => Math.max(max, depth(item, level + 1)), level);
    }
    return level - 1;
  };
  if (depth(content, 1) > DRAFT_MAX_DEPTH) {
    throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      [{ field: 'content', messages: [`content must be at most ${DRAFT_MAX_DEPTH} levels deep`] }]);
  }
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  if (bytes > DRAFT_MAX_BYTES) throw new DomainProblem(400, 'CONSULTATION_DRAFT_TOO_LARGE', DRAFT_MESSAGES.tooLarge);
  return bytes;
}

function notFound(): DomainProblem {
  return new DomainProblem(404, 'CONSULTATION_DRAFT_NOT_FOUND', DRAFT_MESSAGES.notFound);
}

/** The table's or function's absence (a database without 0141) or any other failure: 503. */
function unavailable(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '22023' && message === 'CONSULTATION_DRAFT_TOO_LARGE') {
    return new DomainProblem(400, 'CONSULTATION_DRAFT_TOO_LARGE', DRAFT_MESSAGES.tooLarge);
  }
  if (code === '42501' && message === 'CONSULTATION_DRAFTS_NOT_PERMITTED') {
    return new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
  }
  if (code === '22023' && message === 'CONSULTATION_DRAFTS_DIRECT_CARE_ONLY') {
    return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care for drafts');
  }
  return new DomainProblem(503, 'CONSULTATION_DRAFTS_UNAVAILABLE', DRAFT_MESSAGES.unavailable);
}

/**
 * EHR-C6 (0141, owner decision Q126 A): consultation drafts saved on the
 * server. Author only (row-level security), deleted 7 days after the last
 * save (ConsultationDraftSweeper). Not part of the record. Every call needs
 * ehr.note.write; create and save need the patient's write_records consent,
 * list and read read_records; discard needs only authorship. The content is
 * never audited, logged or read.
 */
@Injectable()
export class ConsultationDraftsService {
  private readonly saves = new Map<string, number[]>();

  constructor(
    private readonly repository: ClinicalRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async create(context: DataAccessContext, patientId: string, input: CreateConsultationDraftDto, key: string) {
    checkDraftContent(input.content);
    const operation = 'consultation-draft.create';
    const digest = requestDigest(operation, { patientId, input });
    try {
      return draftAnswer(await this.repository.run(
        context, patientId, 'write_records',
        { action: 'ehr.consultation-draft.create', resourceType: 'consultation-draft' },
        (client) => this.repository.executeCreate(client, context, patientId, key, operation, digest, 'consultation-draft',
          async () => {
            if (input.encounterId !== undefined) await this.requireVisit(client, context, patientId, input.encounterId);
            await client.query('savepoint consultation_draft_create');
            let row: DraftRow | undefined;
            try {
              row = (await client.query<DraftRow>(
                `insert into ehr.consultation_drafts (patient_id, facility_id, account_id, membership_id, encounter_id,
                   form_version, content, size_bytes, expires_at)
                 values ($1, $2, $3, $4, $5, $6, $7::jsonb, 2, clock_timestamp())
                 returning ${DRAFT_COLUMNS}`,
                [patientId, context.facilityId, context.actor.accountId, context.membershipId, input.encounterId ?? null,
                  input.formVersion, JSON.stringify(input.content)],
              )).rows[0];
            } catch (error) {
              if ((error as { code?: unknown }).code !== '23505') throw error;
              await client.query('rollback to savepoint consultation_draft_create');
              const existing = (await client.query<{ id: string }>(
                `select id::text from ehr.consultation_drafts
                  where patient_id = $1 and facility_id = $2 and membership_id = $3
                    and encounter_id is not distinct from $4::uuid`,
                [patientId, context.facilityId, context.membershipId, input.encounterId ?? null],
              )).rows[0];
              throw new DomainProblem(409, 'CONSULTATION_DRAFT_EXISTS', DRAFT_MESSAGES.exists,
                undefined, existing ? { draftId: existing.id } : undefined);
            }
            if (!row) throw new Error('The draft was not stored');
            return { value: row, id: row.draftId, details: { sizeBytes: Number(row.sizeBytes) } };
          },
          (id) => this.find(client, context, patientId, id),
        ),
        (client) => input.encounterId === undefined ? Promise.resolve(true)
          : this.repository.encounterExists(client, input.encounterId, patientId, context.facilityId),
      ));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async save(context: DataAccessContext, patientId: string, draftId: string, input: SaveConsultationDraftDto) {
    checkDraftContent(input.content);
    this.admitSave(context.membershipId);
    try {
      return draftAnswer(await this.repository.run(
        context, patientId, 'write_records',
        { action: 'ehr.consultation-draft.update', resourceType: 'consultation-draft', resourceId: draftId },
        async (client) => {
          const current = (await client.query<DraftRow & { same: boolean }>(
            `select ${DRAFT_COLUMNS}, (content = $4::jsonb and form_version = $5) as same
               from ehr.consultation_drafts
              where id = $1 and patient_id = $2 and facility_id = $3
              for update`,
            [draftId, patientId, context.facilityId, JSON.stringify(input.content), input.formVersion],
          )).rows[0];
          if (!current) throw notFound();
          // A retry of a save that already went through answers the stored draft.
          if (current.same && Number(current.rowVersion) === input.expectedRowVersion + 1) {
            const { same: _same, ...stored } = current;
            return { value: stored, details: { sizeBytes: Number(stored.sizeBytes), retry: true } };
          }
          if (Number(current.rowVersion) !== input.expectedRowVersion) {
            throw new DomainProblem(409, 'CONSULTATION_DRAFT_CHANGED', DRAFT_MESSAGES.changed);
          }
          const saved = (await client.query<DraftRow>(
            `update ehr.consultation_drafts set content = $4::jsonb, form_version = $5
              where id = $1 and patient_id = $2 and facility_id = $3 and row_version = $6
              returning ${DRAFT_COLUMNS}`,
            [draftId, patientId, context.facilityId, JSON.stringify(input.content), input.formVersion,
              input.expectedRowVersion],
          )).rows[0];
          if (!saved) throw new DomainProblem(409, 'CONSULTATION_DRAFT_CHANGED', DRAFT_MESSAGES.changed);
          return { value: saved, details: { sizeBytes: Number(saved.sizeBytes) } };
        },
      ));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async read(context: DataAccessContext, patientId: string, draftId: string) {
    try {
      return draftAnswer(await this.repository.run(
        context, patientId, 'read_records',
        { action: 'ehr.consultation-draft.read', resourceType: 'consultation-draft', resourceId: draftId },
        async (client) => {
          const row = await this.find(client, context, patientId, draftId, true);
          if (!row) throw notFound();
          return { value: row, details: { sizeBytes: Number(row.sizeBytes) } };
        },
      ));
    } catch (error) {
      throw this.translate(error);
    }
  }

  async list(context: DataAccessContext, patientId: string) {
    try {
      return await this.repository.run(
        context, patientId, 'read_records',
        { action: 'ehr.consultation-draft.list', resourceType: 'consultation-draft' },
        async (client) => {
          const rows = (await client.query<DraftRow>(
            `select ${DRAFT_COLUMNS} from ehr.consultation_drafts
              where patient_id = $1 and facility_id = $2
              order by saved_at desc, id desc limit 20`,
            [patientId, context.facilityId],
          )).rows;
          return { value: { items: rows.map(draftAnswer) }, details: { resultCount: rows.length } };
        },
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Discard: authorship only (no consent check), safe to repeat. */
  async discard(context: DataAccessContext, patientId: string, draftId: string): Promise<void> {
    try {
      await this.database.withTransaction(context, async (client: PoolClient) => {
        const removed = (await client.query<{ size_bytes: number }>(
          `delete from ehr.consultation_drafts where id = $1 and patient_id = $2 and facility_id = $3
           returning size_bytes`,
          [draftId, patientId, context.facilityId],
        )).rows[0];
        await this.audit.recordWithClient(client, {
          correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, patientId,
          action: 'ehr.consultation-draft.discard', resourceType: 'consultation-draft', resourceId: draftId,
          outcome: 'success', purposeOfUse: context.purposeOfUse,
          details: removed ? { sizeBytes: Number(removed.size_bytes), discarded: true } : { discarded: false },
        });
      });
    } catch (error) {
      throw unavailable(error);
    }
  }

  /** GET /ehr/my-consultation-drafts: the author's drafts across patients (0141's definer decides and audits). */
  async mine(context: DataAccessContext) {
    let rows: MyDraftRow[];
    try {
      rows = await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<MyDraftRow>(`select draft_id::text, encounter_id::text, saved_at, expires_at,
           patient_id::text, full_name, sex, date_of_birth::text as date_of_birth, health_id_last4, hidden_count
           from ehr.list_my_consultation_drafts()`)).rows);
    } catch (error) {
      throw unavailable(error);
    }
    return {
      items: rows.filter((row) => row.draft_id !== null).map((row) => ({
        draftId: String(row.draft_id),
        encounterId: row.encounter_id ?? null,
        savedAt: new Date(row.saved_at as Date).toISOString(),
        expiresAt: new Date(row.expires_at as Date).toISOString(),
        patient: { patientId: String(row.patient_id), fullName: String(row.full_name), sex: row.sex ?? null,
          dateOfBirth: row.date_of_birth ?? null, healthIdLast4: row.health_id_last4 ?? null },
      })),
      hiddenCount: Number(rows[0]?.hidden_count ?? 0),
    };
  }

  /** 60 saves per member per minute (429), in this task's memory. */
  private admitSave(membershipId: string, now: number = Date.now()): void {
    const recent = (this.saves.get(membershipId) ?? []).filter((at) => at > now - 60_000);
    if (recent.length >= DRAFT_SAVES_PER_MINUTE) {
      this.saves.set(membershipId, recent);
      throw new DomainProblem(429, 'CONSULTATION_DRAFT_SAVE_LIMITED', DRAFT_MESSAGES.limited);
    }
    recent.push(now);
    this.saves.set(membershipId, recent);
    if (this.saves.size > 10_000) {
      for (const [key, times] of this.saves) if (times.every((at) => at <= now - 60_000)) this.saves.delete(key);
    }
  }

  /** A visit of this patient here (the caller's lookup gives 404), and not entered in error (409). */
  private async requireVisit(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string) {
    await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId, { lock: false });
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, draftId: string,
    withContent = false): Promise<DraftRow | undefined> {
    return (await client.query<DraftRow>(
      `select ${DRAFT_COLUMNS}${withContent ? ', content' : ''} from ehr.consultation_drafts
        where id = $1 and patient_id = $2 and facility_id = $3`,
      [draftId, patientId, context.facilityId],
    )).rows[0];
  }

  private translate(error: unknown): unknown {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === '42P01' || code === '42883' || code === '22023') return unavailable(error);
    return error;
  }
}

/**
 * Deletes drafts 7 days after their last save (owner decision Q126 A) every
 * 10 minutes, through 0141's sweeper (which writes one expire audit row per
 * draft). Expired drafts are unreadable the moment they expire (row-level
 * security); this removes them for good. Not started in tests. Failures are
 * logged once with no identifier and tried again next time.
 */
@Injectable()
export class ConsultationDraftSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsultationDraftSweeper.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.sweep(); }, 10 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    try {
      return await this.database.withSystemTransaction(`consultation-draft-sweep-${randomUUID()}`, async (client) =>
        Number((await client.query<{ swept: number }>('select ehr.sweep_consultation_drafts(500) as swept')).rows[0]?.swept ?? 0));
    } catch {
      this.logger.warn({ event: 'ehr.consultation_draft.sweep_unavailable' });
      return 0;
    }
  }
}
