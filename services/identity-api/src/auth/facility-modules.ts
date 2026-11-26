import type { ActorContext, FacilityAssignment } from '../common/request-context';

/**
 * SX-1 (Akos N-2b, N-2e, P1-5): which product areas the staff screens show at
 * one facility. Each area is a pure function of that facility's permission
 * codes (auth.role_permissions, read by the session as today). Nothing is
 * read from the database and nothing is stored: the same permissions always
 * give the same map. The server still checks every route on its own; the map
 * only lets the screens hide what a membership cannot use.
 *
 * The areas follow the rows of Akos's role table ("Proposed role access", the
 * Doctor-role QA review of 17 November 2026). Each area needs every code in
 * `show` to be shown, and every code in `act` to be used in full. The codes
 * are the ones the routes of that area already require (RequirePermissions in
 * identity-api, ehr-api, lab-api, pharmacy-api, ocr-api and outreach-api).
 *
 * Akos's row "Nursing observations" has no area of its own: no permission
 * tells it apart from "Triage and vitals" today, so the screens use `triage`.
 */
export type FacilityModuleKey =
  | 'patients'
  | 'registration'
  | 'accessRequests'
  | 'emergencyAccess'
  | 'triage'
  | 'consultation'
  | 'orders'
  | 'lab'
  | 'labResults'
  | 'pharmacy'
  | 'prescriptions'
  | 'migrate'
  | 'outreach'
  | 'admin'
  | 'audit'
  | 'emergencyBoard';

export interface FacilityModuleRule {
  key: FacilityModuleKey;
  /** The row of Akos's role table this area stands for. */
  label: string;
  /** Every code needed to show the area. */
  show: readonly string[];
  /** Every code needed to use the area in full (always includes `show`). */
  act: readonly string[];
}

/** A facility's areas, every key present, in the order of FACILITY_MODULE_RULES. */
export type FacilityModules = Readonly<Record<FacilityModuleKey, boolean>>;

/** How far a membership can use one area: not shown, shown with some actions refused, or in full. */
export type FacilityModuleAccess = 'hidden' | 'view' | 'full';

const rule = (key: FacilityModuleKey, label: string, show: readonly string[], act: readonly string[] = show): FacilityModuleRule =>
  Object.freeze({ key, label, show: Object.freeze([...show]), act: Object.freeze([...new Set([...show, ...act])]) });

export const FACILITY_MODULE_RULES: readonly FacilityModuleRule[] = Object.freeze([
  // Staff Health ID lookup and patient cards (identity-api, RequirePermissions('identity.patient.read')).
  rule('patients', 'Find patient', ['identity.patient.read']),
  // Governed NIN registration (identity-api registration routes).
  rule('registration', 'Register and check in', ['identity.registration.write']),
  // Access requests (identity.consent.write); checking a patient's PIN also needs identity.patient-access-pin.verify.
  rule('accessRequests', 'Access requests and PIN', ['identity.consent.write'],
    ['identity.consent.write', 'identity.patient-access-pin.verify']),
  // Break-glass: the route needs both codes.
  rule('emergencyAccess', 'Emergency access', ['identity.consent.write', 'identity.break-glass.write']),
  rule('triage', 'Triage and vitals', ['ehr.vital.read'], ['ehr.vital.write']),
  rule('consultation', 'Consultation and diagnosis', ['ehr.diagnosis.read'], ['ehr.diagnosis.write', 'ehr.note.write']),
  // Ordering a lab test and prescribing are one area: both writes are needed.
  rule('orders', 'Order labs and prescribe', ['ehr.lab-request.write', 'ehr.prescription.write']),
  // The laboratory's own job (the same codes the product gate reads as lab's own job).
  rule('lab', 'Lab queue and results entry', ['lab.result.enter'], ['lab.work-item.accept']),
  rule('labResults', 'Lab results', ['lab.result.released.read'], ['lab.result.enter']),
  // The pharmacy's own job.
  rule('pharmacy', 'Dispense medicines', ['pharmacy.dispensing.create'], ['pharmacy.work-item.accept']),
  rule('prescriptions', 'Prescriptions', ['ehr.prescription.read'], ['ehr.prescription.write']),
  // Scanning paper records into the record (OCR jobs that can be published to a patient).
  rule('migrate', 'Scan paper records', ['ocr.job.read', 'ocr.publication.write'],
    ['ocr.job.write', 'ocr.validation.write']),
  rule('outreach', 'Outreach', ['outreach.campaign.read'], ['outreach.campaign.write']),
  // Facility profile and staff (P1-5: hidden from clinical roles, which never hold workforce.manage).
  rule('admin', 'Facility profile and staff', ['workforce.manage'], ['organization.manage']),
  // The facility's audit trail (Akos's "View (audit)" cells).
  rule('audit', 'Audit trail', ['audit.read']),
  // ED-1 (0168, 0169; Q-ED-2 A): the emergency department board (ehr-api's ed-board routes). Shown with the board;
  // used in full by those who can also triage and record where the patient goes next (clinicians and doctors).
  rule('emergencyBoard', 'Emergency department board', ['ehr.ed.read'],
    ['ehr.ed.arrive', 'ehr.ed.triage', 'ehr.ed.disposition']),
]);

/** How far a set of permission codes can use one area. */
export function facilityModuleAccess(permissions: readonly string[], area: FacilityModuleRule): FacilityModuleAccess {
  const held = new Set(permissions);
  if (!area.show.every((code) => held.has(code))) return 'hidden';
  return area.act.every((code) => held.has(code)) ? 'full' : 'view';
}

/** The areas a facility's permission codes show: true for 'view' and 'full', false for 'hidden'. */
export function facilityModules(permissions: readonly string[]): FacilityModules {
  const held = new Set(permissions);
  const modules = {} as Record<FacilityModuleKey, boolean>;
  for (const area of FACILITY_MODULE_RULES) modules[area.key] = area.show.every((code) => held.has(code));
  return Object.freeze(modules);
}

/** A facility as the session answer gives it: every existing field, then its areas. */
export type SessionFacility = FacilityAssignment & { modules: FacilityModules };

/** The actor as the session answer gives it: each facility, and the selected one, with its areas. */
export type SessionActor = Omit<ActorContext, 'facilities' | 'facility'> & {
  facilities: readonly SessionFacility[];
  facility?: SessionFacility;
};

/** A facility of the session answer, with its areas added after every existing field. */
export function withFacilityModules(facility: FacilityAssignment): SessionFacility {
  return { ...facility, modules: facilityModules(facility.permissions) };
}

/**
 * The actor of a session answer: the same fields in the same order, each
 * facility (and the selected one, when there is one) with its areas added.
 * A patient or account-only actor has no facility and comes back unchanged.
 */
export function sessionActorWithModules(actor: ActorContext): SessionActor {
  return {
    ...actor,
    facilities: actor.facilities.map(withFacilityModules),
    ...(actor.facility ? { facility: withFacilityModules(actor.facility) } : {}),
  } as SessionActor;
}
