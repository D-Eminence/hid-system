import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { patientEntriesEnabled } from '../patient-entries/patient-entries.flag';
import { readPatientEntries } from '../patient-entries/patient-entries.query';
import { readImportedHealthProfile, readImportedRecords } from '../patient-records/imported-records.query';
import { cardLinksEnabled } from './card-links.flag';

const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIEW_SECRET = /^[A-Za-z0-9_-]{43}$/;

export type CardShareScope = 'card' | 'card_and_records';

/** 410 CARD_SHARE_VIEW_ENDED: the view is gone, timed out, closed, replaced or its link ended. Never 401. */
export function cardShareViewEnded(): DomainProblem {
  return new DomainProblem(410, 'CARD_SHARE_VIEW_ENDED', 'This card is no longer shared with you.');
}

/**
 * The records a live card-link view shows (0118), read in a card-share
 * transaction (DatabaseService.withCardShareTransaction: the view context
 * audits the read, then the transaction turns read only) where
 * only ehr.card_share_read_context's policies admit rows: "Card only" the
 * blood group, genotype and allergies the patient entered; "Card and records"
 * also completed visits, signed notes (current revision), the imported
 * history and profile, all the health information the patient entered, and
 * the records the patient added (while PATIENT_ENTRIES_ENABLED is on). Every
 * key is always present; imported files carry a name and type only (no
 * downloads in v1).
 */
@Injectable()
export class CardShareRecordsService {
  constructor(private readonly database: DatabaseService) {}

  async read(request: HidRequest) {
    if (!cardLinksEnabled()) throw new NotFoundException();
    const viewId = String(request.header('x-card-view') ?? '').toLowerCase();
    if (!VIEW_ID.test(viewId)) throw cardShareViewEnded();
    const cookies = (request as HidRequest & { cookies?: Record<string, unknown> }).cookies ?? {};
    const secret = cookies[`hid_cv_${viewId.replace(/-/g, '')}`];
    if (typeof secret !== 'string' || !VIEW_SECRET.test(secret)) throw cardShareViewEnded();
    const digest = createHash('sha256').update(secret).digest('hex');
    try {
      return await this.database.withCardShareTransaction(digest, request.correlationId, async (client, context) => {
        if (context.view_id !== viewId) throw cardShareViewEnded();
        return context.scope === 'card_and_records'
          ? this.records(client, context.patient_id)
          : this.cardOnly(client, context.patient_id);
      });
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
      if (code === '55000' || code === '42501') throw cardShareViewEnded();
      throw error;
    }
  }

  private async cardOnly(client: PoolClient, patientId: string) {
    const profile = (await client.query<{ blood_group: string | null; genotype: string | null; allergies: string | null }>(
      `select blood_group, genotype, allergies from ehr.patient_reported_health_profiles where patient_id = $1`,
      [patientId])).rows[0];
    return { scope: 'card' as const, encounters: [], notes: [], importedRecords: [], importedHealthProfile: null,
      healthProfile: profile ? { bloodGroup: profile.blood_group, genotype: profile.genotype, allergies: profile.allergies }
        : null,
      patientEntries: [], patientEntriesMore: false, ...EMPTY };
  }

  private async records(client: PoolClient, patientId: string) {
    const encounters = await client.query(`select id, facility_id as "facilityId", encounter_type as "encounterType",
      status, started_at as "startedAt", ended_at as "endedAt" from ehr.encounters
      where patient_id = $1 and status = 'completed' order by started_at desc, id desc limit 50`, [patientId]);
    const notes = await client.query(`select n.id, n.encounter_id as "encounterId", n.facility_id as "facilityId",
      n.note_type as "noteType", n.title, n.status, n.current_revision_no as "revisionNo", r.content, n.signed_at as "signedAt"
      from ehr.clinical_notes n join ehr.clinical_note_revisions r
        on r.clinical_note_id = n.id and r.revision_no = n.current_revision_no
        and r.patient_id = n.patient_id and r.facility_id = n.facility_id
      where n.patient_id = $1 and n.status in ('signed', 'amended')
      order by n.signed_at desc, n.id desc limit 50`, [patientId]);
    const imported = (await readImportedRecords(client, patientId)) as Array<Record<string, unknown>>;
    const profile = (await client.query<{ blood_group: string | null; genotype: string | null; allergies: string | null;
      current_medications: string | null; chronic_conditions: string | null; medical_notes: string | null }>(
      `select blood_group, genotype, allergies, current_medications, chronic_conditions, medical_notes
         from ehr.patient_reported_health_profiles where patient_id = $1`, [patientId])).rows[0];
    const entries = patientEntriesEnabled() ? await readPatientEntries(client, patientId) : undefined;
    return {
      scope: 'card_and_records' as const,
      encounters: encounters.rows,
      notes: notes.rows,
      importedRecords: imported.map((record) => ({ ...record,
        files: (Array.isArray(record.files) ? record.files as Array<Record<string, unknown>> : [])
          .map((file) => ({ id: file.id, fileName: file.fileName, mediaType: file.mediaType })) })),
      importedHealthProfile: await readImportedHealthProfile(client, patientId),
      healthProfile: profile ? { bloodGroup: profile.blood_group, genotype: profile.genotype, allergies: profile.allergies,
        chronicConditions: profile.chronic_conditions, medications: profile.current_medications,
        notes: profile.medical_notes } : null,
      patientEntries: entries?.items ?? [],
      patientEntriesMore: entries?.more ?? false,
      ...EMPTY,
    };
  }
}

/** Kept for the answer's shape: card links never show these in v1. */
const EMPTY = { diagnoses: [], prescriptions: [], labRequests: [], vitals: [], documents: [], limit: 50 } as const;
