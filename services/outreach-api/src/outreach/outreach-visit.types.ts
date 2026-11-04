import type { VisitKind } from './dto/create-visit.dto';

export interface OutreachCaseVisit {
  id: string;
  registrationCaseId: string;
  kind: VisitKind;
  occurredOn: string;
  followUpOn: string | null;
  referredTo: string | null;
  notes: string | null;
  recordedByMembershipId: string;
  createdAt: string;
}

/** Dates are selected as text (YYYY-MM-DD) so no time zone can move them. */
export interface VisitRow {
  id: string;
  registration_case_id: string;
  kind: VisitKind;
  occurred_on: string;
  follow_up_on: string | null;
  referred_to: string | null;
  notes: string | null;
  recorded_by_membership_id: string;
  request_sha256: string;
  created_at: Date | string;
}

export const VISIT_COLUMNS = `id,registration_case_id,kind,occurred_on::text as occurred_on,
  follow_up_on::text as follow_up_on,referred_to,notes,recorded_by_membership_id,request_sha256,created_at`;

export function caseVisit(row: VisitRow): OutreachCaseVisit {
  return {
    id: row.id,
    registrationCaseId: row.registration_case_id,
    kind: row.kind,
    occurredOn: row.occurred_on,
    followUpOn: row.follow_up_on,
    referredTo: row.referred_to,
    notes: row.notes,
    recordedByMembershipId: row.recorded_by_membership_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface OutreachLinkPreview {
  patient: { fullName: string; dateOfBirth: string | null; healthIdLast4: string };
  canLink: boolean;
}
