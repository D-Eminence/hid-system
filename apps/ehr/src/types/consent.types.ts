export type AccessScope = 'read_records' | 'write_records' | 'break_glass';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';
export type GrantStatus = 'active' | 'revoked' | 'expired';

export interface AccessRequestRow {
  id: string;
  requester_staff_account_id: string;
  staff_display_name: string | null;
  scope: AccessScope;
  status: RequestStatus;
  reason: string;
  break_glass: boolean;
  created_at: string;
  approved_at: string | null;
}

export interface AccessGrantRow {
  id: string;
  request_id: string | null;
  staff_account_id: string;
  staff_display_name: string | null;
  scope: AccessScope;
  status: GrantStatus;
  reason: string;
  starts_at: string;
  expires_at: string;
}

export interface ApproveAccessRequestBody {
  requestId: string;
  durationMinutes?: number;
}

export interface ApproveAccessRequestResult {
  grant_id: string;
  request_id: string;
}

export interface DenyAccessRequestBody {
  requestId: string;
  reason?: string | null;
}

export interface BreakGlassSession {
  reason: string;
  staffName: string;
  durationMinutes: number;
  ts: string;
  patientHid: string;
}

export const GRANT_DURATION = { min: 5, max: 1440, default: 60 } as const;
