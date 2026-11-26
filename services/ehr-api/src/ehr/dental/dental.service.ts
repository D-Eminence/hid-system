import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import type {
  DentalAnaestheticDto, DentalChartSaveDto, DentalFollowUpDto, DentalListFilter, DentalProcedureDoneDto,
  DentalProcedureRecordDto, DentalProcedureStatus, DentalSite, Dentition,
} from './dental.dto';
import { DENTAL_SITES } from './dental.dto';

/**
 * DEN-1 (0194, 0195): the dental clinic on an ordinary outpatient visit.
 *
 * Every route works through 0195's SECURITY DEFINER functions, which check the
 * caller (an active membership here, ehr.dental.read or ehr.dental.write,
 * direct care), the facility's seal, the patient's consent (0005's
 * ehr.context_allows, the clinical tables' own rule) and the visit, decide,
 * and audit in the request's transaction, refusals answered included. The
 * printed summary adds the visit's diagnoses and prescriptions with the
 * clinical record's existing read (ClinicalRepository, the same consent).
 *
 * Built at the recommended options, not yet answered by the owner: Q-DEN-1 A
 * (only dentists hold the dental codes), Q-DEN-2 A (no emergency access),
 * Q-DEN-3 A (the printed summary for patients), Q-DEN-4 A (only the signer
 * marks a done procedure entered in error), Q-DEN-5 A (procedures by name),
 * Q-DEN-6 A (a local anaesthetic, or none, on every done procedure).
 *
 * No Health ID or NIN is in any path, query, body or answer: the patient card
 * carries the last 4 characters of the Health ID only. Until the owner's
 * go-live, DENTAL_ENABLED is off in production and every route answers 503
 * DENTAL_NOT_AVAILABLE.
 */

/** The plain-words messages of the dental refusals. Staff screens show these and never the word "permission". */
export const DENTAL_MESSAGES = {
  notAvailable: 'The dental clinic is not switched on yet.',
  notAllowed: 'Only dentists of this facility can open or record the dental chart.',
  notSigner: 'Only the dentist who signed this procedure can mark it entered in error.',
  validation: 'Check the highlighted fields.',
  toothInvalid: 'Choose a tooth by its two-digit FDI number, for example 36.',
  surfacesInvalid: 'Choose surfaces from M, O, D, B and L, each once, only for a condition or procedure that takes surfaces.',
  conditionInvalid: 'Choose a condition from the dental list.',
  procedureInvalid: 'Choose a procedure from the dental list, or type its name.',
  siteInvalid: 'Say where this procedure was done: the tooth, the quadrant, the arch or the whole mouth, as the procedure needs.',
  anaestheticInvalid: 'Choose the local anaesthetic used, or No local anaesthetic.',
  doneTimeInvalid: 'The time it was done can be from the start of this visit to now.',
  followUpInvalid: 'Choose a follow-up date from tomorrow to two years ahead.',
  reasonRequired: 'Say why in at least 8 characters.',
  visitEncounterInvalid: 'Dental records go on an outpatient visit of this patient at this facility.',
  visitNotFound: 'No dental record was started on this visit.',
  chartNotFound: 'This chart version was not found.',
  procedureNotFound: 'This procedure was not found.',
  visitNotStarted: 'Start the dental record on this visit first.',
  visitClosed: 'This visit is finished. Open a new visit to record more.',
  chartChanged: 'Someone saved this chart after you opened it. Reload it to start from the newest chart.',
  chartNotLatest: 'Only the newest chart can be marked entered in error.',
  procedureNotPlanned: 'Only a planned procedure can be recorded as done or cancelled.',
  procedureNotDone: 'Only a done procedure can be marked entered in error.',
  versionConflict: 'Someone else changed this record. Reload it and try again.',
  consentRequired: 'Active consent and facility membership are required',
  encounterNotFound: 'Encounter was not found',
  keyReused: 'Idempotency-Key was already used with a different request',
  directCareOnly: 'X-Purpose-Of-Use must be direct-care for clinical access',
} as const;

/** At most this many items in one list answer (routes 5 and 13). */
export const DENTAL_LIST_LIMIT = 200;

/** The visit, every answer that names one. */
export interface DentalVisit {
  visitId: string;
  patientId: string;
  encounterId: string;
  encounterStatus: string;
  encounterStartedAt: string;
  startedAt: string;
  startedByMembershipId: string;
  stage: 'started' | 'assessed' | 'treated' | 'completed';
  followUpOn: string | null;
  followUpNote: string | null;
  rowVersion: number;
}

export interface DentalCorrection {
  at: string;
  byMembershipId: string;
  reason: string;
}

export interface DentalFinding {
  tooth: number;
  condition: string;
  surfaces: string | null;
  note: string | null;
}

export interface DentalChart {
  versionId: string;
  versionNo: number;
  basedOnVersionId: string | null;
  encounterId: string;
  dentition: Dentition;
  recordedAt: string;
  recordedByMembershipId: string;
  listVersion: string;
  listStatus: 'draft' | 'signed';
  findings: DentalFinding[];
  note: string | null;
  enteredInError: DentalCorrection | null;
}

export interface DentalChartVersionSummary {
  versionId: string;
  versionNo: number;
  recordedAt: string;
  recordedByMembershipId: string;
  encounterId: string;
  enteredInError: boolean;
}

export interface DentalAnaesthetic {
  agentCode: string;
  agentName: string | null;
  agentOther: string | null;
  techniqueCode: string | null;
  techniqueName: string | null;
  cartridges: number | null;
}

export interface DentalProcedure {
  procedureId: string;
  patientId: string;
  procedureCode: string | null;
  procedureName: string;
  byName: boolean;
  listVersion: string | null;
  listStatus: 'draft' | 'signed' | null;
  site: DentalSite;
  tooth: number | null;
  surfaces: string | null;
  quadrant: number | null;
  arch: 'upper' | 'lower' | null;
  status: DentalProcedureStatus;
  plannedEncounterId: string | null;
  plannedAt: string | null;
  plannedByMembershipId: string | null;
  doneEncounterId: string | null;
  doneAt: string | null;
  performedByMembershipId: string | null;
  signedAt: string | null;
  anaesthetic: DentalAnaesthetic | null;
  notes: string | null;
  cancelled: DentalCorrection | null;
  enteredInError: DentalCorrection | null;
  rowVersion: number;
}

export interface DentalPatientCard {
  patientId: string;
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string;
}

export interface DentalListItem {
  code: string;
  label?: string;
  name?: string;
  takesSurfaces?: boolean;
  category?: string;
  site?: string;
}

export interface DentalList {
  version: string | null;
  status: 'draft' | 'signed' | null;
  items: DentalListItem[];
}

export interface DentalLists {
  toothConditions: DentalList;
  procedures: DentalList;
  anaesthetics: DentalList;
  techniques: DentalList;
  surfaces: readonly ['M', 'O', 'D', 'B', 'L'];
  photosAvailable: boolean;
}

export interface DentalVisitRecord {
  visit: DentalVisit;
  chart: DentalChart | null;
  chartVersionsThisVisit: Pick<DentalChartVersionSummary, 'versionId' | 'versionNo' | 'recordedAt' | 'enteredInError'>[];
  plannedProcedures: DentalProcedure[];
  doneThisVisit: DentalProcedure[];
}

export interface DentalSummaryDiagnosis {
  codeSystem: string | null;
  code: string | null;
  display: string;
  clinicalStatus: string;
}

export interface DentalSummaryPrescription {
  medicationDisplay: string;
  doseQuantity: number | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string | null;
  instructions: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;
}

export interface DentalSummary {
  patient: DentalPatientCard;
  facilityName: string;
  visit: DentalVisit;
  encounter: { startedAt: string; endedAt: string | null; status: string; chiefComplaint: string | null };
  chart: DentalChart | null;
  doneThisVisit: DentalProcedure[];
  plannedProcedures: DentalProcedure[];
  diagnoses: DentalSummaryDiagnosis[];
  prescriptions: DentalSummaryPrescription[];
  listStatus: 'draft' | 'signed';
  printedAt: string;
}

export const LISTS_SQL = `select kind, version_label, status, code, label, category, site, takes_surfaces, sort_order
  from ehr.dental_lists()`;
export const VISIT_START_SQL = 'select outcome, replayed, visit from ehr.dental_visit_start($1, $2, $3, $4)';
export const VISIT_READ_SQL = `select outcome, visit, chart, chart_versions_this_visit, planned_procedures, done_this_visit
  from ehr.dental_visit_read($1, $2)`;
export const FOLLOW_UP_SQL = `select outcome, replayed, visit
  from ehr.dental_visit_follow_up($1, $2, $3, $4, $5::date, $6, $7, $8, $9)`;
export const VISITS_LIST_SQL = 'select ord, patient, visit, hidden_count, has_more from ehr.dental_visits_list($1) order by ord';
export const CHART_READ_SQL = 'select outcome, chart, versions from ehr.dental_chart_read($1, $2)';
export const CHART_SAVE_SQL = `select outcome, replayed, chart
  from ehr.dental_chart_save($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`;
export const CHART_ERROR_SQL = 'select outcome, replayed, chart from ehr.dental_chart_entered_in_error($1, $2, $3, $4, $5)';
export const PROCEDURE_RECORD_SQL = `select outcome, replayed, procedure
  from ehr.dental_procedure_record($1, $2, $3, $4, $5, $6, $7::smallint, $8, $9::smallint, $10, $11::timestamptz, $12,
    $13, $14, $15::numeric, $16, $17, $18)`;
export const PROCEDURE_DONE_SQL = `select outcome, replayed, procedure
  from ehr.dental_procedure_done($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9::numeric, $10, $11, $12, $13, $14, $15)`;
export const PROCEDURE_CANCEL_SQL = 'select outcome, replayed, procedure from ehr.dental_procedure_cancel($1, $2, $3, $4, $5, $6)';
export const PROCEDURE_ERROR_SQL = `select outcome, replayed, procedure
  from ehr.dental_procedure_entered_in_error($1, $2, $3, $4, $5, $6)`;
export const PROCEDURES_LIST_SQL = 'select outcome, items, has_more from ehr.dental_procedures_list($1, $2)';
export const SUMMARY_SQL = `select outcome, patient, facility_name, visit, encounter, chart, done_this_visit,
  planned_procedures, list_status, printed_at from ehr.dental_summary_read($1, $2)`;

export function dentalEnabled(): boolean {
  return getEnvironment().DENTAL_ENABLED;
}

export function dentalPhotosEnabled(): boolean {
  return getEnvironment().DENTAL_PHOTOS_ENABLED;
}

export function notAvailable(): DomainProblem {
  return new DomainProblem(503, 'DENTAL_NOT_AVAILABLE', DENTAL_MESSAGES.notAvailable);
}

/** The session's dental code at this facility (the database checks it again): read, or read and write. */
export function requireDentalAccess(request: HidRequest, access: 'read' | 'write'): void {
  const held = new Set(request.actor?.permissions ?? []);
  if (!held.has('ehr.dental.read') || (access === 'write' && !held.has('ehr.dental.write'))) {
    throw new DomainProblem(403, 'DENTAL_NOT_ALLOWED', DENTAL_MESSAGES.notAllowed);
  }
}

const problem = (status: number, code: string, message: string) => new DomainProblem(status, code, message);
const toothInvalid = () => problem(400, 'DENTAL_TOOTH_INVALID', DENTAL_MESSAGES.toothInvalid);
const surfacesInvalid = () => problem(400, 'DENTAL_SURFACES_INVALID', DENTAL_MESSAGES.surfacesInvalid);
const siteInvalid = () => problem(400, 'DENTAL_SITE_INVALID', DENTAL_MESSAGES.siteInvalid);
const anaestheticInvalid = () => problem(400, 'DENTAL_ANAESTHETIC_INVALID', DENTAL_MESSAGES.anaestheticInvalid);
const reasonRequired = () => problem(400, 'DENTAL_REASON_REQUIRED', DENTAL_MESSAGES.reasonRequired);
const validation = (field: string, message: string) =>
  new DomainProblem(400, 'VALIDATION_FAILED', DENTAL_MESSAGES.validation, [{ field, messages: [message] }]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const SURFACE_ORDER = 'MODBL';

/** An FDI two-digit tooth (ISO 3950): permanent 11-18 ... 41-48, primary 51-55 ... 81-85. */
export function fdiTooth(tooth: number): boolean {
  if (!Number.isInteger(tooth)) return false;
  const quadrant = Math.floor(tooth / 10);
  const position = tooth % 10;
  return (quadrant >= 1 && quadrant <= 4 && position >= 1 && position <= 8)
    || (quadrant >= 5 && quadrant <= 8 && position >= 1 && position <= 5);
}

/** A tooth of the chosen dentition: permanent teeth, primary teeth, or both for mixed. */
export function toothInDentition(tooth: number, dentition: Dentition): boolean {
  const primary = Math.floor(tooth / 10) >= 5;
  return dentition === 'mixed' || (dentition === 'primary') === primary;
}

/** 1-5 of M, O, D, B, L, each once (any case, any order), in MODBL order; undefined when not. */
export function canonicalSurfaces(value: string): string | undefined {
  const letters = value.toUpperCase();
  if (!/^[MODBL]{1,5}$/.test(letters) || new Set(letters).size !== letters.length) return undefined;
  return [...letters].sort((left, right) => SURFACE_ORDER.indexOf(left) - SURFACE_ORDER.indexOf(right)).join('');
}

/** A reason of 8-500 characters (trimmed), with no control character. */
export function reasonValid(reason: string | undefined): reason is string {
  return reason !== undefined && reason.length >= 8 && reason.length <= 500 && !CONTROL.test(reason);
}

/** Free text of 1 to max characters (trimmed) or nothing; '' is nothing. */
function optionalText(value: string | null | undefined, max: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value.length > max || CONTROL.test(value)) throw validation(field, `${field} must be at most ${max} characters with no control characters`);
  return value;
}

/** The anaesthetic of a done procedure, as the contract's rules (Q-DEN-6 A); the database checks the lists. */
function anaestheticOf(anaesthetic: DentalAnaestheticDto | null | undefined) {
  if (!anaesthetic) throw anaestheticInvalid();
  const agent = anaesthetic.agentCode;
  const other = anaesthetic.agentOther === undefined || anaesthetic.agentOther === null || anaesthetic.agentOther === ''
    ? null : anaesthetic.agentOther;
  const technique = anaesthetic.techniqueCode ?? null;
  const cartridges = anaesthetic.cartridges ?? null;
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(agent)
      || (agent === 'none' && (technique !== null || cartridges !== null || other !== null))
      || (agent !== 'none' && (technique === null || cartridges === null))
      || ((agent === 'other') !== (other !== null))
      || (other !== null && (other.length < 2 || other.length > 120 || CONTROL.test(other)))
      || (technique !== null && !/^[a-z][a-z0-9_]{1,39}$/.test(technique))
      || (cartridges !== null && (cartridges < 0.5 || cartridges > 10 || !Number.isInteger(cartridges * 2)))) {
    throw anaestheticInvalid();
  }
  return { agent, other, technique, cartridges };
}

/** doneAt as the database takes it, or 400 when it is not a real instant. */
function doneAtOf(doneAt: string | null | undefined): string | null {
  if (doneAt === undefined || doneAt === null) return null;
  if (!Number.isFinite(Date.parse(doneAt))) throw problem(400, 'DENTAL_DONE_TIME_INVALID', DENTAL_MESSAGES.doneTimeInvalid);
  return doneAt;
}

interface WriteRow extends QueryResultRow {
  outcome: string;
  replayed: boolean | null;
}

@Injectable()
export class DentalService {
  constructor(private readonly database: DatabaseService, private readonly repository: ClinicalRepository) {}

  /** Route 1: the active lists and whether photos may be attached (DENTAL_PHOTOS_ENABLED). */
  async lists(context: DataAccessContext): Promise<DentalLists> {
    const rows = await this.query<{ kind: string; version_label: string; status: 'draft' | 'signed'; code: string;
      label: string; category: string | null; site: string | null; takes_surfaces: boolean | null }>(context, LISTS_SQL, []);
    const list = (kind: string, item: (row: (typeof rows)[number]) => DentalListItem): DentalList => {
      const ofKind = rows.filter((row) => row.kind === kind);
      return { version: ofKind[0]?.version_label ?? null, status: ofKind[0]?.status ?? null, items: ofKind.map(item) };
    };
    return {
      toothConditions: list('tooth_condition', (row) => ({ code: row.code, label: row.label,
        takesSurfaces: row.takes_surfaces === true })),
      procedures: list('procedure', (row) => ({ code: row.code, name: row.label, category: row.category ?? 'other',
        site: row.site ?? 'whole_mouth' })),
      anaesthetics: list('anaesthetic', (row) => ({ code: row.code, name: row.label })),
      techniques: list('anaesthetic_technique', (row) => ({ code: row.code, name: row.label })),
      surfaces: ['M', 'O', 'D', 'B', 'L'] as const,
      photosAvailable: dentalPhotosEnabled(),
    };
  }

  /** Route 2: start the dental record on this outpatient visit. */
  async startVisit(context: DataAccessContext, patientId: string, encounterId: string, idempotencyKey: string) {
    const digest = requestDigest('dental.visit.start', { patientId, encounterId });
    const row = await this.one<WriteRow & { visit: DentalVisit | null }>(context, VISIT_START_SQL,
      [patientId, encounterId, idempotencyKey, digest]);
    if ((row?.outcome === 'started' || row?.outcome === 'already_started') && row.visit) {
      return { outcome: row.outcome as 'started' | 'already_started', visit: row.visit, replayed: row.replayed === true };
    }
    throw refusal(row?.outcome);
  }

  /** Route 3: the visit's dental record. */
  async readVisit(context: DataAccessContext, patientId: string, encounterId: string): Promise<DentalVisitRecord> {
    const row = await this.one<{ outcome: string; visit: DentalVisit | null; chart: DentalChart | null;
      chart_versions_this_visit: DentalChartVersionSummary[] | null; planned_procedures: DentalProcedure[] | null;
      done_this_visit: DentalProcedure[] | null }>(context, VISIT_READ_SQL, [patientId, encounterId]);
    if (row?.outcome !== 'found' || !row.visit) throw refusal(row?.outcome);
    return {
      visit: row.visit,
      chart: row.chart ?? null,
      chartVersionsThisVisit: (row.chart_versions_this_visit ?? []).map((version) => ({ versionId: version.versionId,
        versionNo: version.versionNo, recordedAt: version.recordedAt, enteredInError: version.enteredInError })),
      plannedProcedures: row.planned_procedures ?? [],
      doneThisVisit: row.done_this_visit ?? [],
    };
  }

  /** Route 4: the follow-up date (tomorrow to two years ahead, Lagos) and recall note; at least one. */
  async followUp(context: DataAccessContext, patientId: string, encounterId: string, input: DentalFollowUpDto,
    idempotencyKey: string) {
    const setOn = input.followUpOn !== undefined;
    const setNote = input.followUpNote !== undefined;
    if (!setOn && !setNote) throw validation('followUpOn', 'send followUpOn, followUpNote or both');
    const followUpOn = input.followUpOn ?? null;
    if (followUpOn !== null && !followUpWindow(followUpOn)) {
      throw problem(400, 'DENTAL_FOLLOW_UP_INVALID', DENTAL_MESSAGES.followUpInvalid);
    }
    const note = setNote ? optionalText(input.followUpNote, 500, 'followUpNote') : null;
    const digest = requestDigest('dental.visit.follow-up', { patientId, encounterId,
      expectedRowVersion: input.expectedRowVersion, followUpOn: setOn ? followUpOn : '(unchanged)',
      followUpNote: setNote ? note : '(unchanged)' });
    const row = await this.one<WriteRow & { visit: DentalVisit | null }>(context, FOLLOW_UP_SQL, [patientId, encounterId,
      input.expectedRowVersion, setOn, followUpOn, setNote, note, idempotencyKey, digest]);
    if (row?.outcome === 'updated' && row.visit) return { visit: row.visit, replayed: row.replayed === true };
    throw refusal(row?.outcome);
  }

  /** Route 5: this facility's dental visits of the last `days` Lagos days; the rest counted. */
  async listVisits(context: DataAccessContext, days: number) {
    const rows = await this.query<{ ord: string; patient: DentalPatientCard | null; visit: DentalVisit | null;
      hidden_count: number; has_more: boolean }>(context, VISITS_LIST_SQL, [days]);
    return {
      items: rows.filter((row) => row.patient && row.visit)
        .map((row) => ({ patient: row.patient as DentalPatientCard, visit: row.visit as DentalVisit })),
      hiddenCount: Number(rows[0]?.hidden_count ?? 0),
      hasMore: rows.some((row) => row.has_more === true),
      limit: DENTAL_LIST_LIMIT,
    };
  }

  /** Route 6: the newest chart at this facility (or one version) and the versions, newest first. */
  async readChart(context: DataAccessContext, patientId: string, versionId: string | undefined) {
    const row = await this.one<{ outcome: string; chart: DentalChart | null; versions: DentalChartVersionSummary[] | null }>(
      context, CHART_READ_SQL, [patientId, versionId ?? null]);
    if (row?.outcome !== 'found') throw refusal(row?.outcome);
    return { chart: row.chart ?? null, versions: row.versions ?? [] };
  }

  /** Route 7: save a new chart version, based on the newest one. */
  async saveChart(context: DataAccessContext, patientId: string, encounterId: string, input: DentalChartSaveDto,
    idempotencyKey: string) {
    const findings = input.findings.map((finding, index) => {
      if (!fdiTooth(finding.tooth) || !toothInDentition(finding.tooth, input.dentition)) throw toothInvalid();
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(finding.condition)) {
        throw problem(400, 'DENTAL_CONDITION_INVALID', DENTAL_MESSAGES.conditionInvalid);
      }
      let surfaces: string | null = null;
      if (finding.surfaces !== undefined && finding.surfaces !== null) {
        surfaces = canonicalSurfaces(finding.surfaces) ?? null;
        if (surfaces === null) throw surfacesInvalid();
      }
      return { tooth: finding.tooth, condition: finding.condition, surfaces,
        note: optionalText(finding.note, 200, `findings.${index}.note`) };
    });
    const pairs = new Set(findings.map((finding) => `${finding.tooth}/${finding.condition}`));
    if (pairs.size !== findings.length) throw validation('findings', 'one finding per tooth and condition');
    const note = optionalText(input.note, 1000, 'note');
    const basedOn = input.basedOnVersionId ?? null;
    const digest = requestDigest('dental.chart.save', { patientId, encounterId, basedOnVersionId: basedOn,
      dentition: input.dentition, findings, note });
    const row = await this.one<WriteRow & { chart: DentalChart | null }>(context, CHART_SAVE_SQL, [patientId, encounterId,
      basedOn, input.dentition, JSON.stringify(findings), note, idempotencyKey, digest]);
    if (row?.outcome === 'saved' && row.chart) return { chart: row.chart, replayed: row.replayed === true };
    throw refusal(row?.outcome);
  }

  /** Route 8: mark the newest chart version entered in error; the answer is the newest chart after it. */
  async chartEnteredInError(context: DataAccessContext, patientId: string, versionId: string, reason: string | undefined,
    idempotencyKey: string) {
    if (!reasonValid(reason)) throw reasonRequired();
    const digest = requestDigest('dental.chart.entered-in-error', { patientId, versionId, reason });
    const row = await this.one<WriteRow & { chart: DentalChart | null }>(context, CHART_ERROR_SQL,
      [patientId, versionId, reason, idempotencyKey, digest]);
    if (row?.outcome === 'updated') return { chart: row.chart ?? null, replayed: row.replayed === true };
    throw refusal(row?.outcome);
  }

  /** Route 9: plan a procedure, or record one done (signed by the caller). */
  async recordProcedure(context: DataAccessContext, patientId: string, encounterId: string,
    input: DentalProcedureRecordDto, idempotencyKey: string) {
    const code = input.procedureCode ?? null;
    const name = input.procedureName === undefined || input.procedureName === null || input.procedureName === ''
      ? null : input.procedureName;
    if ((code === null) === (name === null) || (code !== null && !/^DEN-\d{3}$/.test(code))
        || (name !== null && (name.length < 2 || name.length > 120 || CONTROL.test(name)))) {
      throw problem(400, 'DENTAL_PROCEDURE_INVALID', DENTAL_MESSAGES.procedureInvalid);
    }
    const site = input.site ?? null;
    if ((site !== null && !(DENTAL_SITES as readonly string[]).includes(site)) || (name !== null && site === null)) {
      throw siteInvalid();
    }
    const tooth = input.tooth ?? null;
    if (tooth !== null && !fdiTooth(tooth)) throw toothInvalid();
    let surfaces: string | null = null;
    if (input.surfaces !== undefined && input.surfaces !== null) {
      surfaces = canonicalSurfaces(input.surfaces) ?? null;
      if (surfaces === null) throw surfacesInvalid();
    }
    const quadrant = input.quadrant ?? null;
    const arch = input.arch ?? null;
    if ((quadrant !== null && (quadrant < 1 || quadrant > 4)) || (arch !== null && arch !== 'upper' && arch !== 'lower')) {
      throw siteInvalid();
    }
    // A site chosen here (by name) must have exactly its columns; a listed procedure's site is checked by the database.
    if (site !== null && ((site === 'tooth' || site === 'tooth_surfaces') !== (tooth !== null)
        || (site === 'tooth_surfaces') !== (surfaces !== null) || (site === 'quadrant') !== (quadrant !== null)
        || (site === 'arch') !== (arch !== null))) {
      throw siteInvalid();
    }
    const done = input.status === 'done';
    if (!done && ((input.anaesthetic !== undefined && input.anaesthetic !== null)
        || (input.doneAt !== undefined && input.doneAt !== null))) {
      throw anaestheticInvalid();
    }
    const anaesthetic = done ? anaestheticOf(input.anaesthetic) : null;
    const doneAt = done ? doneAtOf(input.doneAt) : null;
    const notes = optionalText(input.notes, 1000, 'notes');
    const digest = requestDigest('dental.procedure.record', { patientId, encounterId, status: input.status,
      procedureCode: code, procedureName: name, site, tooth, surfaces, quadrant, arch, doneAt, anaesthetic, notes });
    return this.procedureWrite(context, PROCEDURE_RECORD_SQL, [patientId, encounterId, input.status, code, name, site,
      tooth, surfaces, quadrant, arch, doneAt, anaesthetic?.agent ?? null, anaesthetic?.other ?? null,
      anaesthetic?.technique ?? null, anaesthetic?.cartridges ?? null, notes, idempotencyKey, digest], 'recorded');
  }

  /** Route 10: record a planned procedure as done in this visit (signed by the caller). */
  async procedureDone(context: DataAccessContext, patientId: string, encounterId: string, procedureId: string,
    input: DentalProcedureDoneDto, idempotencyKey: string) {
    const anaesthetic = anaestheticOf(input.anaesthetic);
    const doneAt = doneAtOf(input.doneAt);
    let surfaces: string | null = null;
    if (input.surfaces !== undefined) {
      surfaces = canonicalSurfaces(input.surfaces) ?? null;
      if (surfaces === null) throw surfacesInvalid();
    }
    const setNotes = input.notes !== undefined;
    const notes = setNotes ? optionalText(input.notes, 1000, 'notes') : null;
    const digest = requestDigest('dental.procedure.done', { patientId, encounterId, procedureId,
      expectedRowVersion: input.expectedRowVersion, doneAt, anaesthetic, surfaces: surfaces ?? '(unchanged)',
      notes: setNotes ? notes : '(unchanged)' });
    return this.procedureWrite(context, PROCEDURE_DONE_SQL, [patientId, encounterId, procedureId,
      input.expectedRowVersion, doneAt, anaesthetic.agent, anaesthetic.other, anaesthetic.technique,
      anaesthetic.cartridges, surfaces !== null, surfaces, setNotes, notes, idempotencyKey, digest], 'updated');
  }

  /** Route 11: cancel a planned procedure, with a reason. */
  async cancelProcedure(context: DataAccessContext, patientId: string, procedureId: string, expectedRowVersion: number,
    reason: string | undefined, idempotencyKey: string) {
    if (!reasonValid(reason)) throw reasonRequired();
    const digest = requestDigest('dental.procedure.cancel', { patientId, procedureId, expectedRowVersion, reason });
    return this.procedureWrite(context, PROCEDURE_CANCEL_SQL,
      [patientId, procedureId, expectedRowVersion, reason, idempotencyKey, digest], 'updated');
  }

  /** Route 12: mark a done procedure entered in error, with a reason; only its signer (Q-DEN-4 A). */
  async procedureEnteredInError(context: DataAccessContext, patientId: string, procedureId: string,
    expectedRowVersion: number, reason: string | undefined, idempotencyKey: string) {
    if (!reasonValid(reason)) throw reasonRequired();
    const digest = requestDigest('dental.procedure.entered-in-error', { patientId, procedureId, expectedRowVersion,
      reason });
    return this.procedureWrite(context, PROCEDURE_ERROR_SQL,
      [patientId, procedureId, expectedRowVersion, reason, idempotencyKey, digest], 'updated');
  }

  /** Route 13: the patient's dental procedures at this facility, newest first. */
  async listProcedures(context: DataAccessContext, patientId: string, status: DentalListFilter) {
    const row = await this.one<{ outcome: string; items: DentalProcedure[] | null; has_more: boolean | null }>(context,
      PROCEDURES_LIST_SQL, [patientId, status]);
    if (row?.outcome !== 'found') throw refusal(row?.outcome);
    return { items: row.items ?? [], hasMore: row.has_more === true, limit: DENTAL_LIST_LIMIT };
  }

  /**
   * Route 14: the printable visit summary. The dental part, and its print audit row, from the database; the visit's
   * diagnoses and prescriptions (entered-in-error and cancelled ones left out) with the clinical record's own read.
   */
  async summary(context: DataAccessContext, patientId: string, encounterId: string): Promise<DentalSummary> {
    const row = await this.one<{ outcome: string; patient: DentalPatientCard | null; facility_name: string | null;
      visit: DentalVisit | null; encounter: DentalSummary['encounter'] | null; chart: DentalChart | null;
      done_this_visit: DentalProcedure[] | null; planned_procedures: DentalProcedure[] | null;
      list_status: 'draft' | 'signed' | null; printed_at: Date | null }>(context, SUMMARY_SQL, [patientId, encounterId]);
    if (row?.outcome !== 'found' || !row.patient || !row.visit || !row.encounter) throw refusal(row?.outcome);
    const orders = await this.repository.run(context, patientId, 'read_records',
      { action: 'ehr.dental.summary.orders', resourceType: 'encounter', resourceId: encounterId },
      async (client: PoolClient) => {
        const diagnoses = (await client.query<DentalSummaryDiagnosis>(
          `select code_system as "codeSystem", code, display, clinical_status as "clinicalStatus"
             from ehr.diagnoses
            where encounter_id = $1 and patient_id = $2 and facility_id = $3
              and verification_status <> 'entered_in_error'
            order by created_at, id`, [encounterId, patientId, context.facilityId])).rows;
        const prescriptions = (await client.query<DentalSummaryPrescription & { doseQuantity: string | number | null }>(
          `select medication_display as "medicationDisplay", dose_quantity as "doseQuantity", dose_unit as "doseUnit",
                  route_code as "routeCode", frequency, instructions, starts_on::text as "startsOn",
                  ends_on::text as "endsOn", status
             from ehr.prescriptions
            where encounter_id = $1 and patient_id = $2 and facility_id = $3
              and status not in ('cancelled', 'entered_in_error')
            order by created_at, id`, [encounterId, patientId, context.facilityId])).rows
          .map((prescription) => ({ ...prescription,
            doseQuantity: prescription.doseQuantity === null ? null : Number(prescription.doseQuantity) }));
        return { value: { diagnoses, prescriptions },
          details: { diagnosisCount: diagnoses.length, prescriptionCount: prescriptions.length } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId));
    return {
      patient: row.patient,
      facilityName: row.facility_name ?? '',
      visit: row.visit,
      encounter: row.encounter,
      chart: row.chart ?? null,
      doneThisVisit: row.done_this_visit ?? [],
      plannedProcedures: row.planned_procedures ?? [],
      diagnoses: orders.diagnoses,
      prescriptions: orders.prescriptions,
      listStatus: row.list_status === 'signed' ? 'signed' : 'draft',
      printedAt: new Date(row.printed_at ?? Date.now()).toISOString(),
    };
  }

  private async procedureWrite(context: DataAccessContext, sql: string, values: readonly unknown[], success: string) {
    const row = await this.one<WriteRow & { procedure: DentalProcedure | null }>(context, sql, values);
    if (row?.outcome === success && row.procedure) return { procedure: row.procedure, replayed: row.replayed === true };
    throw refusal(row?.outcome);
  }

  private async one<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row | undefined> {
    return (await this.query<Row>(context, sql, values))[0];
  }

  private async query<Row extends QueryResultRow>(context: DataAccessContext, sql: string,
    values: readonly unknown[]): Promise<Row[]> {
    try {
      return await this.database.withTransaction(context, async (client: PoolClient) =>
        (await client.query<Row>(sql, [...values])).rows);
    } catch (error) {
      throw translate(error);
    }
  }
}

/** A follow-up date from tomorrow to two years ahead, in Lagos days (the database checks it again). */
export function followUpWindow(date: string, now: Date = new Date()): boolean {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const asked = Date.UTC(year, month - 1, day);
  const check = new Date(asked);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return false;
  // Lagos is UTC+1 all year.
  const lagos = new Date(now.getTime() + 3600_000);
  const today = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate());
  const latest = Date.UTC(lagos.getUTCFullYear() + 2, lagos.getUTCMonth(), lagos.getUTCDate());
  return asked > today && asked <= latest;
}

/** An answer that refuses, in plain words. */
export function refusal(outcome: string | undefined): DomainProblem {
  switch (outcome) {
    case 'consent_required':
      return problem(403, 'CONSENT_REQUIRED', DENTAL_MESSAGES.consentRequired);
    case 'encounter_not_found':
      return problem(404, 'ENCOUNTER_NOT_FOUND', DENTAL_MESSAGES.encounterNotFound);
    case 'visit_encounter_invalid':
      return problem(400, 'DENTAL_VISIT_ENCOUNTER_INVALID', DENTAL_MESSAGES.visitEncounterInvalid);
    case 'visit_closed':
      return problem(409, 'DENTAL_VISIT_CLOSED', DENTAL_MESSAGES.visitClosed);
    case 'visit_not_started':
      return problem(409, 'DENTAL_VISIT_NOT_STARTED', DENTAL_MESSAGES.visitNotStarted);
    case 'visit_not_found':
      return problem(404, 'DENTAL_VISIT_NOT_FOUND', DENTAL_MESSAGES.visitNotFound);
    case 'chart_not_found':
      return problem(404, 'DENTAL_CHART_NOT_FOUND', DENTAL_MESSAGES.chartNotFound);
    case 'chart_changed':
      return problem(409, 'DENTAL_CHART_CHANGED', DENTAL_MESSAGES.chartChanged);
    case 'chart_not_latest':
      return problem(409, 'DENTAL_CHART_NOT_LATEST', DENTAL_MESSAGES.chartNotLatest);
    case 'procedure_not_planned':
      return problem(409, 'DENTAL_PROCEDURE_NOT_PLANNED', DENTAL_MESSAGES.procedureNotPlanned);
    case 'procedure_not_done':
      return problem(409, 'DENTAL_PROCEDURE_NOT_DONE', DENTAL_MESSAGES.procedureNotDone);
    case 'not_signer':
      return problem(403, 'DENTAL_NOT_SIGNER', DENTAL_MESSAGES.notSigner);
    case 'version_conflict':
      return problem(412, 'DENTAL_VERSION_CONFLICT', DENTAL_MESSAGES.versionConflict);
    case 'key_reused':
      return problem(409, 'IDEMPOTENCY_KEY_REUSED', DENTAL_MESSAGES.keyReused);
    default:
      return problem(404, 'DENTAL_PROCEDURE_NOT_FOUND', DENTAL_MESSAGES.procedureNotFound);
  }
}

/** The database's own refusals, in plain words; anything else is passed on. */
export function translate(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (code === '42501' && message === 'DENTAL_NOT_ALLOWED') {
    return problem(403, 'DENTAL_NOT_ALLOWED', DENTAL_MESSAGES.notAllowed);
  }
  if (code === '22023') {
    switch (message) {
      case 'DENTAL_DIRECT_CARE_ONLY':
        return problem(400, 'PURPOSE_OF_USE_REQUIRED', DENTAL_MESSAGES.directCareOnly);
      case 'DENTAL_IDEMPOTENCY_KEY_INVALID':
        return problem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters');
      case 'DENTAL_TOOTH_INVALID':
        return toothInvalid();
      case 'DENTAL_SURFACES_INVALID':
        return surfacesInvalid();
      case 'DENTAL_CONDITION_INVALID':
        return problem(400, 'DENTAL_CONDITION_INVALID', DENTAL_MESSAGES.conditionInvalid);
      case 'DENTAL_PROCEDURE_INVALID':
        return problem(400, 'DENTAL_PROCEDURE_INVALID', DENTAL_MESSAGES.procedureInvalid);
      case 'DENTAL_SITE_INVALID':
        return siteInvalid();
      case 'DENTAL_ANAESTHETIC_INVALID':
        return anaestheticInvalid();
      case 'DENTAL_DONE_TIME_INVALID':
        return problem(400, 'DENTAL_DONE_TIME_INVALID', DENTAL_MESSAGES.doneTimeInvalid);
      case 'DENTAL_FOLLOW_UP_INVALID':
        return problem(400, 'DENTAL_FOLLOW_UP_INVALID', DENTAL_MESSAGES.followUpInvalid);
      case 'DENTAL_REASON_REQUIRED':
        return reasonRequired();
      default:
        return new DomainProblem(400, 'VALIDATION_FAILED', DENTAL_MESSAGES.validation);
    }
  }
  if (code === '40P01') {
    return problem(412, 'DENTAL_VERSION_CONFLICT', DENTAL_MESSAGES.versionConflict);
  }
  if (code === '42883' || code === '42P01') {
    // A new image on a schema without 0195: the routes stay closed until the migration is applied.
    return notAvailable();
  }
  return error;
}
