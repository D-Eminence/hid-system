import { DomainProblem } from '../common/problem';

/**
 * GET /api/v1/identity/me/access-log (0093's identity.patient_self_access_log;
 * owner decision of 2026-10-28): who viewed or changed the patient's record
 * and when, newest first. The cursor is opaque to the browser: base64url of
 * the keyset (occurred_at with microseconds, sequence_id) the database
 * answered, checked here before it reaches SQL.
 */
export const ACCESS_LOG_ACTIONS = ['viewed', 'changed', 'access_granted', 'access_ended', 'emergency_access'] as const;
export const ACCESS_LOG_ACTOR_KINDS = ['clinician', 'facility', 'patient', 'support', 'system'] as const;

export interface AccessLogEvent {
  id: string;
  at: string;
  action: typeof ACCESS_LOG_ACTIONS[number];
  actorKind: typeof ACCESS_LOG_ACTOR_KINDS[number];
  actorName: string | null;
  facilityName: string | null;
}

export interface AccessLogPage {
  events: AccessLogEvent[];
  nextBefore: string | null;
}

export interface AccessLogCursor {
  occurredAt: string;
  sequenceId: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_SEQUENCE = /^[1-9]\d{0,18}$/;
const EVENT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidCursor(): DomainProblem {
  return new DomainProblem(400, 'INVALID_ACCESS_LOG_CURSOR', 'The access log cursor is invalid');
}

export function encodeAccessLogCursor(cursor: AccessLogCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.occurredAt, s: cursor.sequenceId }), 'utf8').toString('base64url');
}

export function decodeAccessLogCursor(value: string): AccessLogCursor {
  if (value.length < 1 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalidCursor();
  const { t, s, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || typeof t !== 'string' || typeof s !== 'string'
    || !CURSOR_TIME.test(t) || Number.isNaN(Date.parse(t)) || !CURSOR_SEQUENCE.test(s)) {
    throw invalidCursor();
  }
  return { occurredAt: t, sequenceId: s };
}

/** A name as the patient's page shows it: text without control characters, at most 200 characters, or null. */
function shownName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, 200) : null;
}

/** The database's answer as the route publishes it; anything unexpected is dropped, never passed through. */
export function publishAccessLog(value: unknown): AccessLogPage {
  const answer = (typeof value === 'object' && value !== null ? value : {}) as { events?: unknown; next?: unknown };
  const events = (Array.isArray(answer.events) ? answer.events : []).flatMap((entry: unknown): AccessLogEvent[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.at !== 'string' || !EVENT_TIME.test(row.at)
      || !ACCESS_LOG_ACTIONS.includes(row.action as AccessLogEvent['action'])
      || !ACCESS_LOG_ACTOR_KINDS.includes(row.actorKind as AccessLogEvent['actorKind'])) return [];
    return [{
      id: row.id, at: row.at, action: row.action as AccessLogEvent['action'],
      actorKind: row.actorKind as AccessLogEvent['actorKind'],
      actorName: shownName(row.actorName), facilityName: shownName(row.facilityName),
    }];
  });
  const next = answer.next as { occurredAt?: unknown; sequenceId?: unknown } | null | undefined;
  const occurredAt = typeof next?.occurredAt === 'string' ? next.occurredAt : undefined;
  const sequenceId = typeof next?.sequenceId === 'number' || typeof next?.sequenceId === 'string'
    ? String(next.sequenceId) : undefined;
  const nextBefore = occurredAt && sequenceId && CURSOR_TIME.test(occurredAt) && CURSOR_SEQUENCE.test(sequenceId)
    ? encodeAccessLogCursor({ occurredAt, sequenceId }) : null;
  return { events, nextBefore };
}
