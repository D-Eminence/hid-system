import type { Request } from 'express';
import { DomainProblem } from './problem';

export interface FacilityAssignment {
  id: string;
  membershipId: string;
  organizationId: string;
  name: string;
  code?: string;
  roles: readonly string[];
  permissions: readonly string[];
  isPrimary: boolean;
}

export interface ActorContext {
  kind?: 'staff' | 'patient';
  patientId?: string;
  id: string;
  subject: string;
  accountId: string;
  sessionId?: string;
  email?: string;
  displayName?: string;
  roles: readonly string[];
  permissions: readonly string[];
  platformRoles?: readonly string[];
  platformPermissions?: readonly string[];
  facilityIds: readonly string[];
  facilities: readonly FacilityAssignment[];
  facility?: FacilityAssignment;
  role?: string;
  authenticationMethod: 'local' | 'oidc';
}

export interface HidRequest extends Request {
  correlationId: string;
  actor?: ActorContext;
  facilityId?: string;
  authTransport?: 'bearer' | 'cookie';
  purposeOfUse?: PurposeOfUse;
}

export type PurposeOfUse = 'direct-care' | 'emergency' | 'healthcare-operations';
const PURPOSES = new Set<PurposeOfUse>(['direct-care', 'emergency', 'healthcare-operations']);

export interface DataAccessContext {
  correlationId: string;
  actor: ActorContext;
  facilityId: string;
  membershipId: string;
  purposeOfUse: PurposeOfUse;
  authorization?: string;
  userCookie?: string;
  /** The browser request's method; Identity applies its browser-write check to a forwarded cookie only for a write. */
  requestMethod?: string;
  csrfToken?: string;
  origin?: string;
  /** Offline replay headers (contract §2.10 C3); present only when at least one was valid. */
  offline?: OfflineCommandContext;
}

export type OfflineClock = 'anchored' | 'wall' | 'suspect';

/** What a replayed offline write says about itself. Recorded in audit, never used to authorize. */
export interface OfflineCommandContext {
  commandId: string | null;
  capturedAt: string | null;
  clock: OfflineClock | null;
  capturedClamped: boolean;
}

const OFFLINE_COMMAND = /^off1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFLINE_CAPTURED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const OFFLINE_CLOCKS = new Set<OfflineClock>(['anchored', 'wall', 'suspect']);
const CAPTURE_PAST_MS = 24 * 3600_000;
const CAPTURE_FUTURE_MS = 5 * 60_000;

/**
 * Reads X-HID-Offline-Command, X-HID-Captured-At and X-HID-Clock. Each is
 * optional and an invalid one is ignored: these headers never refuse a
 * request. A capture time outside [now - 24 h, now + 5 min] is clamped into
 * that window and flagged.
 */
export function parseOfflineHeaders(request: Pick<HidRequest, 'header'>, now = Date.now()): OfflineCommandContext | undefined {
  const command = request.header('x-hid-offline-command')?.trim();
  const captured = request.header('x-hid-captured-at')?.trim();
  const clock = request.header('x-hid-clock')?.trim();
  const commandId = command && OFFLINE_COMMAND.test(command) ? command.toLowerCase() : null;
  const capturedMs = captured && OFFLINE_CAPTURED_AT.test(captured) ? Date.parse(captured) : Number.NaN;
  const validClock = clock && OFFLINE_CLOCKS.has(clock as OfflineClock) ? clock as OfflineClock : null;
  let capturedAt: string | null = null;
  let capturedClamped = false;
  if (Number.isFinite(capturedMs)) {
    const bounded = Math.min(Math.max(capturedMs, now - CAPTURE_PAST_MS), now + CAPTURE_FUTURE_MS);
    capturedClamped = bounded !== capturedMs;
    capturedAt = new Date(bounded).toISOString();
  }
  if (!commandId && !capturedAt && !validClock) return undefined;
  return { commandId, capturedAt, clock: validClock, capturedClamped };
}

/** The `details.offline` merged into a write's audit event, or nothing for an online write. */
export function offlineAuditDetails(context: Pick<DataAccessContext, 'offline'>): { offline?: OfflineCommandContext } {
  return context.offline ? { offline: { ...context.offline } } : {};
}

export function requireRequestContext(request: HidRequest, suppliedPurpose?: string): DataAccessContext {
  if (!request.actor || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by security guards');
  }
  // Clinical, consent and audit routes check their purpose first; the document
  // and internal OCR routes take it from the header, which the guard does not
  // check, so a missing or unknown one is the client's.
  const candidate = suppliedPurpose ?? request.header('x-purpose-of-use');
  if (!candidate || !PURPOSES.has(candidate as PurposeOfUse)) {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
      'X-Purpose-Of-Use must be direct-care, emergency or healthcare-operations');
  }
  const purposeOfUse = candidate as PurposeOfUse;
  request.purposeOfUse = purposeOfUse;
  const offline = parseOfflineHeaders(request);
  return {
    actor: request.actor,
    facilityId: request.facilityId,
    membershipId: request.actor.facility?.membershipId ?? '',
    correlationId: request.correlationId,
    purposeOfUse,
    authorization: request.header('authorization'),
    userCookie: request.header('cookie'),
    csrfToken: request.header('x-csrf-token'),
    origin: request.header('origin'),
    requestMethod: request.method,
    ...(offline ? { offline } : {}),
  };
}
