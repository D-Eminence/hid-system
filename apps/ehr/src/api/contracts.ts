export interface ApiProblemDocument {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  correlationId?: string;
  errors?: unknown;
}

export interface AuthActor {
  id: string;
  email?: string;
  displayName: string;
  roles: string[];
  roleLabel?: string;
  permissions?: string[];
}

export interface AuthFacility {
  id: string;
  name: string;
  code?: string;
  type?: string;
  departments?: string[];
}

export interface AuthSession {
  actor: AuthActor;
  facility: AuthFacility;
  expiresAt?: string;
}

export interface LoginResponse extends AuthSession {
  /** Transitional only. Production deployments should use an HttpOnly session cookie. */
  accessToken?: string;
  csrfToken?: string;
}

export interface IdentityPatientSummary {
  patientId: string;
  hid: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  dateOfBirth?: string;
  sex?: 'Male' | 'Female' | 'Other' | 'Unknown';
  bloodGroup?: string;
  phone?: string;
  mrn?: string;
  registrationDate?: string;
  lastVisit?: string;
  status?: 'active' | 'admitted' | 'emergency' | 'discharged' | 'inactive';
}

export interface PatientAuthorizationDecision {
  decision: 'allow' | 'deny';
  expiresAt?: string;
  consentId?: string;
  breakGlass?: boolean;
}

export type AuthorizedPatientResponse =
  | {
    patient: IdentityPatientSummary;
    authorization: PatientAuthorizationDecision & { decision: 'allow' };
  }
  | {
    patient?: never;
    authorization: PatientAuthorizationDecision & { decision: 'deny' };
  };

export interface TimelinePage<Item> {
  items: Item[];
  nextCursor: string | null;
}

export interface EncounterRecord {
  id: string;
  patientId: string;
  facilityId: string;
  encounterNumber: string | null;
  encounterType: 'ambulatory' | 'emergency' | 'inpatient' | 'home' | 'virtual' | 'other';
  status: 'planned' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled' | 'entered_in_error';
  startedAt: string;
  endedAt: string | null;
  chiefComplaint: string | null;
  rowVersion: string;
}

export interface CreateEncounterInput {
  encounterType: EncounterRecord['encounterType'];
  status: EncounterRecord['status'];
  startedAt: string;
  chiefComplaint?: string;
}

export interface CreateClinicalNoteInput {
  noteType: string;
  title: string;
  status: 'draft' | 'signed';
  content: string;
}

export interface CreateVitalInput {
  recordedAt: string;
  source: 'manual';
  heightCm?: number;
  weightKg?: number;
  temperatureC?: number;
  pulseBpm?: number;
  respiratoryRate?: number;
  systolicMmhg?: number;
  diastolicMmhg?: number;
  oxygenSaturationPercent?: number;
}

export interface CreateDiagnosisInput {
  codeSystem: string;
  code: string;
  display: string;
  clinicalStatus: 'active' | 'recurrence' | 'relapse' | 'inactive' | 'remission' | 'resolved';
  verificationStatus: 'unconfirmed' | 'provisional' | 'differential' | 'confirmed' | 'refuted';
  onsetAt?: string;
  notes?: string;
}

export interface CreatePrescriptionInput {
  medicationCodeSystem?: string;
  medicationCode?: string;
  medicationDisplay: string;
  doseQuantity?: number;
  doseUnit?: string;
  routeCode?: string;
  frequency: string;
  instructions: string;
  startsOn?: string;
  endsOn?: string;
  status: 'draft' | 'active';
}

export interface CreateLabRequestInput {
  testCodeSystem: string;
  testCode: string;
  testDisplay: string;
  priority: 'routine' | 'urgent' | 'asap' | 'stat';
  status: 'draft' | 'active';
  specimenTypeCode?: string;
  clinicalInformation?: string;
  externalOrderReference?: string;
}

export interface DocumentUploadOptions {
  classification: 'phi' | 'restricted' | 'internal';
  retentionClass: 'clinical-10y' | 'clinical-permanent' | 'legal-hold';
}

export interface ClinicalCreateResult {
  id: string;
}
export interface LabRequestCreateResult extends ClinicalCreateResult {
  labWorkItem: null | { id: string; sourceEhrOrderId: string; sourceEhrOrderVersion: number; status: 'accepted'; acceptedAt: string };
}

export type {
  OcrCandidateType,
  OcrPatientConfirmationInput,
  OcrPublicationInput,
  OcrPublicationResult,
  OcrTargetDomain,
  OcrValidationInput,
} from '../../../../packages/api-client/src/ocr';

export interface ClinicalDocumentRecord {
  id: string;
  patientId: string;
  encounterId: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  status: string;
  scanStatus: string;
  version: number;
  createdAt: string;
}

export type {
  OcrExtraction,
  OcrJob,
  OcrPatientConfirmation,
  OcrValidation,
} from '../../../../packages/api-client/src/ocr';

interface ClinicalRecordBase {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  rowVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClinicalNoteRecord extends ClinicalRecordBase {
  noteType: string;
  title: string;
  status: 'draft' | 'signed' | 'amended' | 'entered_in_error';
  currentRevisionNo: number;
  signedAt: string | null;
}

export interface VitalRecord extends ClinicalRecordBase {
  recordedAt: string;
  heightCm: number | null;
  weightKg: number | null;
  temperatureC: number | null;
  pulseBpm: number | null;
  respiratoryRate: number | null;
  systolicMmhg: number | null;
  diastolicMmhg: number | null;
  oxygenSaturationPercent: number | null;
  source: 'manual' | 'device' | 'import';
}

export interface DiagnosisRecord extends ClinicalRecordBase {
  codeSystem: string;
  code: string;
  display: string;
  clinicalStatus: string;
  verificationStatus: string;
  onsetAt: string | null;
  abatementAt: string | null;
  notes: string | null;
}

export interface PrescriptionRecord extends ClinicalRecordBase {
  medicationDisplay: string;
  doseQuantity: number | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string;
  instructions: string;
  startsOn: string | null;
  endsOn: string | null;
  status: 'draft' | 'active' | 'on_hold' | 'completed' | 'cancelled' | 'entered_in_error';
}

export interface LabRequestRecord extends ClinicalRecordBase {
  testCodeSystem: string;
  testCode: string;
  testDisplay: string;
  priority: 'routine' | 'urgent' | 'asap' | 'stat';
  status: 'draft' | 'active' | 'on_hold' | 'completed' | 'cancelled' | 'entered_in_error';
  specimenTypeCode: string | null;
  clinicalInformation: string | null;
}

export type ClinicalRecordKind = 'note' | 'vitals' | 'diagnosis' | 'prescription' | 'lab';

export interface ClinicalRecordSummary {
  id: string;
  kind: ClinicalRecordKind;
  title: string;
  detail: string;
  status?: string;
  occurredAt: string;
}
