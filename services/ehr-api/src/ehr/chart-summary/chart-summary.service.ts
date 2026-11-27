import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { LabApiService } from '../../integrations/lab-api.service';
import { type LabOwnProgress, type PharmacyOwnProgress,
  WorkItemProgressService } from '../../integrations/work-item-progress.service';
import { emergencyAllergies, type EmergencyAllergies } from '../allergies/allergy-reader';
import { calendarDate } from '../shared/calendar-date';
import { ClinicalRepository } from '../shared/clinical.repository';
import { type LatestVitals, readLatestVitals } from '../vitals/vitals.service';

/*
 * EHR-C4 (Akos P1-1, N-11): GET ehr/patients/:patientId/chart-summary. One
 * call for what a doctor's chart opens with. Each section is read only when
 * the caller holds the permission its own route needs, under the same consent
 * check (ClinicalRepository.run: Identity decides, then row-level security
 * reads), with the same readers. Nothing here widens access: a section the
 * caller may not read is left out and listed in `leftOut`, with the reason.
 *
 * Direct care: every section the caller's permissions allow. Emergency
 * (break-glass): exactly what the emergency read (GET .../emergency-records)
 * shows today, its allergies and completed visits here, under the same
 * break-glass-only check; every other section is left out.
 *
 * The parts read from other services (the patient card from Identity, released
 * results from Lab, own pharmacy and laboratory progress) are read after the
 * EHR transaction, as the per-section routes read them, and never fail the
 * answer: a service that refuses leaves its section out as `permission`, one
 * that cannot be reached as `unavailable`.
 */

export const CHART_SECTIONS = ['demographics', 'problems', 'medications', 'allergies', 'latestVitals',
  'recentVisits', 'openLabRequests', 'recentResults'] as const;
export type ChartSection = (typeof CHART_SECTIONS)[number];

/** The permission each section's own route needs (unchanged; no new permission). */
export const CHART_SECTION_PERMISSIONS: Readonly<Record<ChartSection, string>> = Object.freeze({
  demographics: 'identity.patient.read',
  problems: 'ehr.diagnosis.read',
  medications: 'ehr.prescription.read',
  allergies: 'ehr.note.read',
  latestVitals: 'ehr.vital.read',
  recentVisits: 'ehr.encounter.read',
  openLabRequests: 'ehr.lab-request.read',
  recentResults: 'lab.result.released.read',
});

/** The route is open to anyone who may read at least one EHR section; each section is then checked on its own. */
export const CHART_SUMMARY_ROUTE_PERMISSIONS = ['ehr.encounter.read', 'ehr.diagnosis.read', 'ehr.prescription.read',
  'ehr.lab-request.read', 'ehr.vital.read', 'ehr.note.read'] as const;

/** The emergency read's permissions (GET .../emergency-records): both are needed. */
export const EMERGENCY_READ_PERMISSIONS = ['ehr.encounter.read', 'ehr.note.read'] as const;

/** The sections the emergency read already shows. */
export const EMERGENCY_SECTIONS: readonly ChartSection[] = ['allergies', 'recentVisits'];

/** Bounded sizes: each list answers at most this many, newest (or most serious) first. */
export const CHART_LIMITS = Object.freeze({
  recentVisits: 10,
  problems: 50,
  medications: 50,
  openLabRequests: 50,
  /** The allergy reader's own bound. */
  allergies: 200,
  recentResults: 10,
});

/** Released results are read from Lab page by page (200 a page); at most this many pages. */
export const RESULT_PAGE_LIMIT = 5;

export type LeftOutReason = 'permission' | 'unavailable';
export type LeftOutPart = ChartSection | 'medications.ownProgress' | 'openLabRequests.ownProgress';
export interface LeftOut { section: LeftOutPart; reason: LeftOutReason; message: string }

export const LEFT_OUT_MESSAGES = Object.freeze({
  permission: 'You do not have permission to see this part of the chart.',
  emergency: 'Emergency access shows allergies and past visits only. This part of the chart is not shown.',
  unavailable: 'This part of the chart could not be loaded just now. Try again in a moment.',
  pharmacyProgress: 'Pharmacy progress could not be loaded just now. The medicines are shown without it.',
  labProgress: 'Laboratory progress could not be loaded just now. The lab requests are shown without it.',
});

interface VisitRow extends QueryResultRow {
  id: string; encounterNumber?: string | null; encounterType: string; status: string; startedAt: Date;
  endedAt: Date | null; chiefComplaint?: string | null; importedPaperRecords: boolean;
}
/** codeSystem and code are both null for a diagnosis saved by its name only (0156). */
interface ProblemRow extends QueryResultRow {
  id: string; encounterId: string; codeSystem: string | null; code: string | null; display: string; clinicalStatus: string;
  verificationStatus: string; onsetAt: Date | null; notes: string | null; createdAt: Date;
}
/** A current medicine as the summary answers it (dates as YYYY-MM-DD). */
export interface Medication {
  id: string; encounterId: string; medicationCodeSystem: string | null; medicationCode: string | null;
  medicationDisplay: string; doseQuantity: string | null; doseUnit: string | null; routeCode: string | null;
  frequency: string; instructions: string; startsOn: string | null; endsOn: string | null;
  status: 'active' | 'on_hold'; createdAt: Date;
}
interface MedicationRow extends QueryResultRow, Omit<Medication, 'startsOn' | 'endsOn'> {
  startsOn: Date | string | null; endsOn: Date | string | null;
}
/** testCodeSystem and testCode are both null for a test ordered by its name only (0156). */
interface LabRequestRow extends QueryResultRow {
  id: string; encounterId: string; testCodeSystem: string | null; testCode: string | null; testDisplay: string;
  priority: string;
  status: 'active' | 'on_hold'; specimenTypeCode: string | null; clinicalInformation: string | null; createdAt: Date;
}

export interface ChartList<Item> { items: Item[]; more: boolean }
export interface Demographics {
  patientId: string; fullName: string | null; firstName: string | null; lastName: string | null;
  dateOfBirth: string | null; gender: string | null;
}
export interface ReleasedResult {
  id: string; version: string; title: string; recordedAt: string; effectiveAt: string | null;
  fields: Record<string, unknown>;
}

export interface ChartSummary {
  patientId: string;
  facilityId: string;
  purposeOfUse: 'direct-care' | 'emergency';
  limits: typeof CHART_LIMITS;
  sections: {
    demographics?: Demographics;
    problems?: ChartList<ProblemRow>;
    medications?: ChartList<Medication & { ownProgress: PharmacyOwnProgress }>;
    allergies?: EmergencyAllergies;
    latestVitals?: LatestVitals;
    recentVisits?: ChartList<VisitRow>;
    openLabRequests?: ChartList<LabRequestRow & { ownProgress: LabOwnProgress }>;
    recentResults?: ChartList<ReleasedResult> & { complete: boolean };
  };
  leftOut: LeftOut[];
}

/** A visit entered in error hides everything recorded in it (EHR-C8a). */
const VISIT_NOT_IN_ERROR = (alias: string) => `not exists (select 1 from ehr.encounters e
     where e.id = ${alias}.encounter_id and e.patient_id = ${alias}.patient_id and e.facility_id = ${alias}.facility_id
       and e.status = 'entered_in_error')`;

/** $1 patient, $2 facility, $3 limit (+1 to tell whether there are more). Visits entered in error left out. */
export const RECENT_VISITS_SQL = `select id, encounter_number as "encounterNumber", encounter_type as "encounterType",
    status, started_at as "startedAt", ended_at as "endedAt", chief_complaint as "chiefComplaint",
    imported_paper_records as "importedPaperRecords"
  from ehr.encounters
  where patient_id = $1 and facility_id = $2 and status <> 'entered_in_error'
  order by started_at desc, id desc limit $3`;

/** The emergency read's visits: completed ones at this facility, with the emergency read's columns. */
export const EMERGENCY_VISITS_SQL = `select id, encounter_type as "encounterType", status, started_at as "startedAt",
    ended_at as "endedAt", imported_paper_records as "importedPaperRecords"
  from ehr.encounters
  where patient_id = $1 and facility_id = $2 and status = 'completed'
  order by started_at desc, id desc limit $3`;

/** Active problems: active, recurring or relapsed; never refuted or entered in error. */
export const ACTIVE_PROBLEMS_SQL = `select d.id, d.encounter_id as "encounterId", d.code_system as "codeSystem", d.code,
    d.display, d.clinical_status as "clinicalStatus", d.verification_status as "verificationStatus",
    d.onset_at as "onsetAt", d.notes, d.created_at as "createdAt"
  from ehr.diagnoses d
  where d.patient_id = $1 and d.facility_id = $2
    and d.clinical_status in ('active', 'recurrence', 'relapse')
    and d.verification_status not in ('refuted', 'entered_in_error')
    and ${VISIT_NOT_IN_ERROR('d')}
  order by d.created_at desc, d.id desc limit $3`;

/** Current medicines: active or on hold, not ended before today (Lagos). */
export const CURRENT_MEDICATIONS_SQL = `select p.id, p.encounter_id as "encounterId",
    p.medication_code_system as "medicationCodeSystem", p.medication_code as "medicationCode",
    p.medication_display as "medicationDisplay", p.dose_quantity as "doseQuantity", p.dose_unit as "doseUnit",
    p.route_code as "routeCode", p.frequency, p.instructions, p.starts_on as "startsOn", p.ends_on as "endsOn",
    p.status, p.created_at as "createdAt"
  from ehr.prescriptions p
  where p.patient_id = $1 and p.facility_id = $2 and p.status in ('active', 'on_hold')
    and (p.ends_on is null or p.ends_on >= (now() at time zone 'Africa/Lagos')::date)
    and ${VISIT_NOT_IN_ERROR('p')}
  order by p.created_at desc, p.id desc limit $3`;

/** Open lab requests: active or on hold. */
export const OPEN_LAB_REQUESTS_SQL = `select l.id, l.encounter_id as "encounterId", l.test_code_system as "testCodeSystem",
    l.test_code as "testCode", l.test_display as "testDisplay", l.priority, l.status,
    l.specimen_type_code as "specimenTypeCode", l.clinical_information as "clinicalInformation",
    l.created_at as "createdAt"
  from ehr.lab_requests l
  where l.patient_id = $1 and l.facility_id = $2 and l.status in ('active', 'on_hold')
    and ${VISIT_NOT_IN_ERROR('l')}
  order by l.created_at desc, l.id desc limit $3`;

type LocalSections = Pick<ChartSummary['sections'], 'problems' | 'allergies' | 'latestVitals' | 'recentVisits'> & {
  medications?: ChartList<Medication>;
  openLabRequests?: ChartList<LabRequestRow>;
};

@Injectable()
export class ChartSummaryService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly identity: IdentityApiService,
    private readonly lab: LabApiService,
    private readonly progress: WorkItemProgressService,
  ) {}

  async read(context: DataAccessContext, patientId: string): Promise<ChartSummary> {
    const emergency = context.purposeOfUse === 'emergency';
    if (context.purposeOfUse !== 'direct-care' && !emergency) {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be direct-care or emergency');
    }
    const permissions = context.actor.permissions;
    // Emergency: the emergency read's own permissions, both of them, as its route requires.
    if (emergency && EMERGENCY_READ_PERMISSIONS.some((permission) => !permissions.includes(permission))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    const leftOut: LeftOut[] = [];
    const wanted = new Set<ChartSection>();
    for (const section of CHART_SECTIONS) {
      if (emergency && !EMERGENCY_SECTIONS.includes(section)) {
        leftOut.push({ section, reason: 'permission', message: LEFT_OUT_MESSAGES.emergency });
      } else if (!permissions.includes(CHART_SECTION_PERMISSIONS[section])) {
        leftOut.push({ section, reason: 'permission', message: LEFT_OUT_MESSAGES.permission });
      } else {
        wanted.add(section);
      }
    }

    // One consent check and one audit row (ehr.chart-summary.read), as every EHR read; a refusal
    // is 403 CONSENT_REQUIRED, audited as denied, and reads nothing. Counts only, never values.
    const local = await this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.chart-summary.read', resourceType: 'chart-summary', resourceId: patientId,
        ...(emergency ? { breakGlassOnly: true } : {}),
        details: { sections: [...wanted] } },
      async (client) => {
        const value = await this.readLocal(client, context, patientId, wanted, emergency);
        return { value, details: { counts: localCounts(value) } };
      },
    );

    // After the transaction, as the per-section routes do. None of these throws.
    const [demographics, recentResults, medicationProgress, labProgress] = await Promise.all([
      wanted.has('demographics') ? this.demographics(context, patientId) : undefined,
      wanted.has('recentResults') ? this.recentResults(context, patientId) : undefined,
      local.medications ? this.progress.pharmacy(context, patientId, local.medications.items) : undefined,
      local.openLabRequests ? this.progress.lab(context, patientId, local.openLabRequests.items) : undefined,
    ]);

    const sections: ChartSummary['sections'] = {};
    if (demographics && 'value' in demographics) sections.demographics = demographics.value;
    else if (demographics) leftOut.push(demographics.leftOut);
    if (local.problems) sections.problems = local.problems;
    if (local.medications && medicationProgress) {
      sections.medications = { ...local.medications,
        items: local.medications.items.map((item) => ({ ...item, ownProgress: medicationProgress.get(item.id)! })) };
      if ([...medicationProgress.values()].some((value) => value.status === 'unknown')) {
        leftOut.push({ section: 'medications.ownProgress', reason: 'unavailable', message: LEFT_OUT_MESSAGES.pharmacyProgress });
      }
    }
    if (local.allergies) sections.allergies = local.allergies;
    if (local.latestVitals) sections.latestVitals = local.latestVitals;
    if (local.recentVisits) sections.recentVisits = local.recentVisits;
    if (local.openLabRequests && labProgress) {
      sections.openLabRequests = { ...local.openLabRequests,
        items: local.openLabRequests.items.map((item) => ({ ...item, ownProgress: labProgress.get(item.id)! })) };
      if ([...labProgress.values()].some((value) => value.status === 'unknown')) {
        leftOut.push({ section: 'openLabRequests.ownProgress', reason: 'unavailable', message: LEFT_OUT_MESSAGES.labProgress });
      }
    }
    if (recentResults && 'value' in recentResults) sections.recentResults = recentResults.value;
    else if (recentResults) leftOut.push(recentResults.leftOut);

    return { patientId, facilityId: context.facilityId, purposeOfUse: emergency ? 'emergency' : 'direct-care',
      limits: CHART_LIMITS, sections, leftOut };
  }

  /** The EHR's own sections, inside the one authorized transaction (row-level security applies). */
  private async readLocal(client: PoolClient, context: DataAccessContext, patientId: string,
    wanted: ReadonlySet<ChartSection>, emergency: boolean): Promise<LocalSections> {
    const facilityId = context.facilityId;
    const list = async <Row extends QueryResultRow>(sql: string, limit: number): Promise<ChartList<Row>> => {
      const rows = (await client.query<Row>(sql, [patientId, facilityId, limit + 1])).rows;
      return { items: rows.slice(0, limit), more: rows.length > limit };
    };
    const value: LocalSections = {};
    if (wanted.has('recentVisits')) {
      value.recentVisits = await list<VisitRow>(emergency ? EMERGENCY_VISITS_SQL : RECENT_VISITS_SQL,
        CHART_LIMITS.recentVisits);
    }
    if (wanted.has('allergies')) value.allergies = await emergencyAllergies(client, patientId, facilityId);
    if (emergency) return value;
    if (wanted.has('problems')) value.problems = await list<ProblemRow>(ACTIVE_PROBLEMS_SQL, CHART_LIMITS.problems);
    if (wanted.has('medications')) {
      const page = await list<MedicationRow>(CURRENT_MEDICATIONS_SQL, CHART_LIMITS.medications);
      value.medications = { ...page, items: page.items.map((row) => ({ ...row,
        startsOn: calendarDate(row.startsOn) ?? null, endsOn: calendarDate(row.endsOn) ?? null })) };
    }
    if (wanted.has('latestVitals')) value.latestVitals = await readLatestVitals(client, patientId, facilityId);
    if (wanted.has('openLabRequests')) {
      value.openLabRequests = await list<LabRequestRow>(OPEN_LAB_REQUESTS_SQL, CHART_LIMITS.openLabRequests);
    }
    return value;
  }

  /** The patient card Identity gives the EHR (name, date of birth, gender); never the Health ID. */
  private async demographics(context: DataAccessContext, patientId: string):
    Promise<{ value: Demographics } | { leftOut: LeftOut }> {
    try {
      const profile = await this.identity.staffPatientProfile(patientId, context);
      if (profile.patientId !== patientId) return { leftOut: left('demographics', 'unavailable') };
      return { value: { patientId, fullName: text(profile.fullName), firstName: text(profile.firstName),
        lastName: text(profile.lastName), dateOfBirth: text(profile.dateOfBirth), gender: text(profile.gender) } };
    } catch (error) {
      return { leftOut: left('demographics', reasonFor(error)) };
    }
  }

  /** The newest released results Lab gives the EHR for this patient (Lab checks the access and audits the read). */
  private async recentResults(context: DataAccessContext, patientId: string):
    Promise<{ value: ChartList<ReleasedResult> & { complete: boolean } } | { leftOut: LeftOut }> {
    try {
      const records: ReleasedResult[] = [];
      let cursor: string | undefined;
      let complete = false;
      for (let page = 0; page < RESULT_PAGE_LIMIT; page++) {
        const answer = await this.lab.staffReleasedResults(context, patientId, cursor);
        records.push(...(answer.records as ReleasedResult[]));
        if (!answer.nextCursor || answer.nextCursor === cursor) { complete = !answer.nextCursor; break; }
        cursor = answer.nextCursor;
      }
      const newest = [...records].sort((a, b) => resultTime(b) - resultTime(a) || (a.id < b.id ? 1 : -1));
      return { value: { items: newest.slice(0, CHART_LIMITS.recentResults),
        more: newest.length > CHART_LIMITS.recentResults || !complete, complete } };
    } catch (error) {
      return { leftOut: left('recentResults', reasonFor(error)) };
    }
  }
}

function left(section: ChartSection, reason: LeftOutReason): LeftOut {
  return { section, reason, message: reason === 'permission' ? LEFT_OUT_MESSAGES.permission : LEFT_OUT_MESSAGES.unavailable };
}

/** A refusal (403) is the caller's permission; anything else (down, slow, malformed, 401 between services) is unavailable. */
function reasonFor(error: unknown): LeftOutReason {
  return error instanceof DomainProblem && error.getStatus() === 403 ? 'permission' : 'unavailable';
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Newest released first (recordedAt is when the laboratory released it). */
function resultTime(result: ReleasedResult): number {
  const time = Date.parse(result.recordedAt);
  return Number.isFinite(time) ? time : 0;
}

function localCounts(value: LocalSections): Record<string, number> {
  const counts: Record<string, number> = {};
  if (value.recentVisits) counts.recentVisits = value.recentVisits.items.length;
  if (value.allergies) counts.allergies = value.allergies.recorded.length;
  if (value.problems) counts.problems = value.problems.items.length;
  if (value.medications) counts.medications = value.medications.items.length;
  if (value.latestVitals) counts.latestVitals = Object.keys(value.latestVitals.measures).length;
  if (value.openLabRequests) counts.openLabRequests = value.openLabRequests.items.length;
  return counts;
}
