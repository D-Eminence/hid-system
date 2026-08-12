/**
 * ============================================================================
 *  CONSENT KEYSTONE - INTERFACE CONTRACT (frozen)
 * ============================================================================
 *  This file is the SINGLE SOURCE OF TRUTH for the data boundary between the
 *  UI (Claude) and the backend (DeepSeek/Codex) for the consent flow.
 *
 *  RULES (both sides):
 *   1. IMPORT these types. Do NOT redefine, regenerate, or "clean up" them.
 *   2. If a type is missing/wrong, RAISE IT - do not invent a value. Anything
 *      marked `⚠ UNRESOLVED` blocks both sides until a human decides it.
 *   3. Every shape here was extracted from the real backend (migration
 *      20260407130000 + src/lib/hidApi.ts), not assumed. Citations inline.
 *   4. Traceability: tags like [D2] point to DECISIONS.md decisions this
 *      shape enforces. The contract may not contradict DECISIONS.md.
 *
 *  CONVENTION WARNING (do not normalize): the boundary is intentionally mixed.
 *   - Edge function REQUEST bodies are camelCase  (e.g. requestId)
 *   - RPC RESULTS + direct table reads are snake_case (e.g. grant_id, created_at)
 *  The UI must consume these AS-IS. Do not map one side to the other "to be
 *  consistent" - that remapping is the #1 cause of seam drift.
 * ============================================================================
 */

/* ---- ENUMS (DB enums; exact values) --------------------------------------
 * Source: migration 20260407130000 lines 24/31/38. */
export type AccessScope = 'read_records' | 'write_records' | 'break_glass';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';
export type GrantStatus = 'active' | 'revoked' | 'expired';

/* ---- READ MODEL: pending/au­dited requests the PATIENT sees ----------------
 * Source: src/lib/hidApi.ts:1034 - direct RLS-scoped select on
 * `hid_access_requests`. RLS guarantees the patient only ever receives rows
 * addressed to them [D2: no cold lookup; empty-until-relevant].
 * These are the EXACT columns selected - do not add columns to the UI read
 * without adding them here first. */
export interface AccessRequestRow {
  id: string;                          // uuid - pass to approve/deny as requestId
  requester_staff_account_id: string;  // uuid (UI rarely needs; prefer display name)
  staff_display_name: string | null;   // display label presented to the patient [D2]
  scope: AccessScope;
  status: RequestStatus;
  reason: string;                      // not null in DB
  break_glass: boolean;                // true => emergency/clinical-only path [D3]
  created_at: string;                  // ISO 8601 timestamptz
  approved_at: string | null;          // ISO 8601 | null
}

/* ---- READ MODEL: currently-active grants (who has access now) -------------
 * Source: src/lib/hidApi.ts:1040 - direct RLS-scoped select on
 * `hid_access_grants`. Used for the patient's "who can see my records" +
 * revoke surface. expires_at drives the live countdown [D1: time-bound]. */
export interface AccessGrantRow {
  id: string;                  // uuid - pass to revoke/close
  request_id: string | null;   // uuid | null (null for direct/PIN/break-glass)
  staff_account_id: string;    // uuid
  staff_display_name: string | null;
  scope: AccessScope;
  status: GrantStatus;
  reason: string;
  starts_at: string;           // ISO 8601
  expires_at: string;          // ISO 8601 - auto-expiry clock [D1]
}

/* ---- ENDPOINT: approve a pending request (PATIENT action) ------------------
 * POST access-request-approve. Source: function handler + RPC
 * hid_approve_access_request. The RPC enforces "only the patient can approve"
 * and "only pending" - the UI must NOT assume its own check is security [D2]. */
export interface ApproveAccessRequestBody {
  requestId: string;            // = AccessRequestRow.id
  durationMinutes?: number;     // optional; clamped server-side to 5..1440, default 60 [D1]
}
export interface ApproveAccessRequestResult {
  grant_id: string;             // uuid (snake_case - RPC result)
  request_id: string;           // uuid
}

/* ---- ENDPOINT: deny a pending request (PATIENT action) --------------------
 * POST access-request-deny. Source: function handler + RPC
 * hid_deny_access_request(p_request_id, p_reason). */
export interface DenyAccessRequestBody {
  requestId: string;
  reason?: string | null;       // optional patient note
}
/** ⚠ UNRESOLVED - backend confirm exact return keys of hid_deny_access_request.
 *  Likely `{ request_id: string; status: 'denied' }` but NOT verified in code.
 *  UI must not depend on this shape until confirmed. */
export type DenyAccessRequestResult = unknown; // ⚠ replace once backend confirms

/* ---- RESPONSE ENVELOPES (every edge function) -----------------------------
 * Source: _shared/http.ts. Success: json({ data }, 2xx). Error: json({ error,
 * details:null }, status) with a SANITIZED, user-safe message string.
 * NOTE: src/lib/hidApi.ts `edgeRequest<T>` already UNWRAPS `.data` and throws
 * `HidApiError(status, message)` on the error envelope - UI code calls the
 * hidApi.ts wrappers, not fetch directly, so it receives T (unwrapped). */
export interface EdgeSuccess<T> { data: T }
export interface EdgeError { error: string; details: null }

/* ---- EXISTING FRONTEND WRAPPERS (call these, don't re-implement) ----------
 * Source: src/lib/hidApi.ts:1678/1690. Signatures are FROZEN:
 *   approveAccessRequest(requestId: string): Promise<{ grant_id: string; request_id: string }>
 *   denyAccessRequest(requestId: string, reason?: string): Promise<unknown ⚠>
 * The UI imports these; it does not build edge calls by hand. */

/* ---- REALTIME (already wired) ---------------------------------------------
 * Source: src/lib/accessRealtime.ts. The consent screen subscribes and
 * re-fetches on change - it does NOT mutate local state from the payload. */
export const REALTIME_CHANNEL = 'hid-access-shared' as const;
export const REALTIME_TABLES = ['hid_access_requests', 'hid_access_grants'] as const;

/* ---- ENDPOINT NAME CONSTANTS (avoid stringly-typed drift) ------------------ */
export const ENDPOINTS = {
  approve: 'access-request-approve',
  deny: 'access-request-deny',
  // hospital/admin side (documented for the full picture; not patient UI):
  create: 'access-request-create',
  breakGlass: 'break-glass',
  grantRevoke: 'access-grant-revoke',
  grantClose: 'access-grant-close',
} as const;

/* ---- DURATION BOUNDS (server-enforced; mirror in UI for inline validation) - */
export const GRANT_DURATION = { min: 5, max: 1440, default: 60 } as const; // minutes [D1]

/* ============================================================================
 *  ROLE VISIBILITY (UI reflects, backend enforces) - see INTERFACE_CONTRACT.md
 *  Patient: sees only their own requests/grants (RLS). Approves/denies/revokes.
 *  Institution/staff: sees NOTHING about a patient until a grant exists [D2].
 *  Break-glass requests (break_glass=true) only originate clinical-side [D3].
 *  The UI hiding a control is UX ONLY and is never a security boundary.
 * ============================================================================
 */
