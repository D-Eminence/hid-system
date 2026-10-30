import { DomainProblem } from '../../common/problem';
import { isCalendarTimestamp, type OfflineClock } from '../../common/request-context';

export const MAX_AUDIT_EVENTS = 20;
/** `seq` fits Postgres int4, and so does the gap query's max - min + 1 (§2.11). */
export const MIN_AUDIT_SEQ = 1;
export const MAX_AUDIT_SEQ = 2_147_483_647;

export const OFFLINE_AUDIT_ACTIONS = [
  'ehr.record.read', 'ehr.offline.unlock', 'ehr.offline.wipe', 'ehr.offline.command.discarded',
] as const;
export type OfflineAuditAction = typeof OFFLINE_AUDIT_ACTIONS[number];

export const OFFLINE_AUDIT_SECTIONS = new Set([
  'consent', 'encounters', 'encounter', 'clinical-notes', 'vitals', 'diagnoses', 'prescriptions', 'lab-requests',
  'documents', 'note-revisions', 'vital-corrections', 'reported-health', 'lab-results', 'summary',
]);

/** `ehr.offline.wipe` carries its reason in `section` (contracts.ts WipeReason). */
export const OFFLINE_WIPE_REASONS = new Set(['sign-out', 'failed-unlocks', 'lease', 'membership', 'kill-switch', 'account']);

export type OfflineAuditRejection = 'INVALID_ACTION' | 'PATIENT_NOT_FOUND' | 'INVALID_EVENT';

/** C2 request body. Events are checked one by one: a bad event is rejected, not the batch. */
export interface AuditEventsDto {
  vaultId: string;
  events: readonly unknown[];
}

export interface OfflineAuditEventInput {
  eventId: string;
  seq: number;
  action: OfflineAuditAction;
  patientId: string | null;
  section: string | null;
  resourceId: string | null;
  occurredAt: string;
  occurredMs: number;
  clock: OfflineClock;
  grantExpiresAt: string | null;
  discarded?: { op: string; reason: string; bodySha256: string; capturedAt: string };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION = /^[a-z][a-z0-9.-]{2,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLOCKS = new Set(['anchored', 'wall', 'suspect']);
const EVENT_FIELDS = new Set(['eventId', 'seq', 'action', 'patientId', 'section', 'resourceId', 'occurredAt',
  'clock', 'grantExpiresAt', 'details']);
const DISCARD_FIELDS = ['op', 'reason', 'bodySha256', 'capturedAt'];

/**
 * The envelope: a vault UUID and 1 to 20 objects that each carry a UUID
 * eventId (needed to report a rejection). Anything else is 400.
 */
export function parseAuditEvents(body: unknown): AuditEventsDto {
  if (!isRecord(body)) throw invalidBatch();
  const { vaultId, events } = body;
  if (Object.keys(body).some((field) => field !== 'vaultId' && field !== 'events')
    || typeof vaultId !== 'string' || !UUID.test(vaultId)
    || !Array.isArray(events) || events.length < 1 || events.length > MAX_AUDIT_EVENTS
    || events.some((event) => !isRecord(event) || typeof event.eventId !== 'string' || !UUID.test(event.eventId))) {
    throw invalidBatch();
  }
  return { vaultId: vaultId.toLowerCase(), events };
}

/** One event, normalized, or the contract's rejection code. */
export function parseAuditEvent(value: unknown): { event: OfflineAuditEventInput } | { rejected: OfflineAuditRejection } {
  if (!isRecord(value) || typeof value.eventId !== 'string' || !UUID.test(value.eventId)) return { rejected: 'INVALID_EVENT' };
  const action = value.action;
  if (typeof action !== 'string' || !(OFFLINE_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return { rejected: 'INVALID_ACTION' };
  }
  if (Object.keys(value).some((field) => !EVENT_FIELDS.has(field))) return { rejected: 'INVALID_EVENT' };
  // Only a discard carries details; on any other action they would be dropped unseen.
  if (action !== 'ehr.offline.command.discarded' && value.details !== undefined && value.details !== null) {
    return { rejected: 'INVALID_EVENT' };
  }
  const { seq, patientId, section, resourceId, occurredAt, clock, grantExpiresAt } = value;
  const occurredMs = timestamp(occurredAt);
  if (!Number.isSafeInteger(seq) || (seq as number) < MIN_AUDIT_SEQ || (seq as number) > MAX_AUDIT_SEQ
    || !isNullable(patientId, (id) => UUID.test(id))
    || !isNullable(section, () => true)
    || !isNullable(resourceId, (id) => RESOURCE_ID.test(id))
    || occurredMs === undefined
    || typeof clock !== 'string' || !CLOCKS.has(clock)
    || !isNullable(grantExpiresAt, (at) => timestamp(at) !== undefined)) {
    return { rejected: 'INVALID_EVENT' };
  }
  const patient = (patientId as string | null | undefined) ?? null;
  const chartSection = (section as string | null | undefined) ?? null;
  const patientEvent = action === 'ehr.record.read' || action === 'ehr.offline.command.discarded';
  // Chart events name a patient; session events never do, so they stay out of a patient's access log.
  if (patientEvent !== (patient !== null)) return { rejected: 'INVALID_EVENT' };
  const sectionAllowed = action === 'ehr.record.read' ? chartSection !== null && OFFLINE_AUDIT_SECTIONS.has(chartSection)
    : action === 'ehr.offline.wipe' ? chartSection !== null && OFFLINE_WIPE_REASONS.has(chartSection)
      : action === 'ehr.offline.unlock' ? chartSection === null
        : chartSection === null || OFFLINE_AUDIT_SECTIONS.has(chartSection);
  if (!sectionAllowed) return { rejected: 'INVALID_EVENT' };
  const event: OfflineAuditEventInput = {
    eventId: value.eventId,
    seq: seq as number,
    action: action as OfflineAuditAction,
    patientId: patient,
    section: chartSection,
    resourceId: (resourceId as string | null | undefined) ?? null,
    occurredAt: occurredAt as string,
    occurredMs,
    clock: clock as OfflineClock,
    grantExpiresAt: (grantExpiresAt as string | null | undefined) ?? null,
  };
  if (action !== 'ehr.offline.command.discarded') return { event };
  const details = value.details;
  if (!isRecord(details) || Object.keys(details).length !== DISCARD_FIELDS.length
    || DISCARD_FIELDS.some((field) => !(field in details))) return { rejected: 'INVALID_EVENT' };
  const { op, reason, bodySha256, capturedAt } = details;
  if (typeof op !== 'string' || !OPERATION.test(op)
    || typeof reason !== 'string' || reason.trim().length < 1 || reason.length > 500
    || typeof bodySha256 !== 'string' || !SHA256.test(bodySha256)
    || timestamp(capturedAt) === undefined) {
    return { rejected: 'INVALID_EVENT' };
  }
  return { event: { ...event, discarded: { op, reason: reason.trim(), bodySha256, capturedAt: capturedAt as string } } };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || !isCalendarTimestamp(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNullable(value: unknown, valid: (text: string) => boolean): boolean {
  return value === undefined || value === null || (typeof value === 'string' && valid(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidBatch(): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED',
    `vaultId must be a UUID and events 1 to ${MAX_AUDIT_EVENTS} objects, each with a UUID eventId`);
}
