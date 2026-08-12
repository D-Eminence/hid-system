import type {
  AuthorizedPatientResponse,
  ClinicalNoteRecord,
  ClinicalCreateResult,
  CreateClinicalNoteInput,
  CreateDiagnosisInput,
  CreateEncounterInput,
  CreateLabRequestInput,
  CreatePrescriptionInput,
  CreateVitalInput,
  DiagnosisRecord,
  EncounterRecord,
  LabRequestRecord,
  PrescriptionRecord,
  TimelinePage,
  VitalRecord,
} from './contracts';

/* Compatibility stub. The maintained EHR client never substitutes simulated records for API responses. */

export const demoApiEnabled = false;

const unavailable = (): never => {
  throw new Error('Local simulated clinical data is disabled. Connect the authorized EHR API.');
};

export const demoApi = {
  lookupPatientByHid(_hid: string): AuthorizedPatientResponse { return unavailable(); },
  listEncounters(_patientId: string): TimelinePage<EncounterRecord> { return unavailable(); },
  createEncounter(_patientId: string, _input: CreateEncounterInput): EncounterRecord { return unavailable(); },
  listNotes(_encounterId: string): TimelinePage<ClinicalNoteRecord> { return unavailable(); },
  createNote(_patientId: string, _encounterId: string, _input: CreateClinicalNoteInput): ClinicalCreateResult { return unavailable(); },
  listVitals(_encounterId: string): TimelinePage<VitalRecord> { return unavailable(); },
  createVital(_patientId: string, _encounterId: string, _input: CreateVitalInput): ClinicalCreateResult { return unavailable(); },
  listDiagnoses(_encounterId: string): TimelinePage<DiagnosisRecord> { return unavailable(); },
  createDiagnosis(_patientId: string, _encounterId: string, _input: CreateDiagnosisInput): ClinicalCreateResult { return unavailable(); },
  listPrescriptions(_encounterId: string): TimelinePage<PrescriptionRecord> { return unavailable(); },
  createPrescription(_patientId: string, _encounterId: string, _input: CreatePrescriptionInput): ClinicalCreateResult { return unavailable(); },
  listLabRequests(_encounterId: string): TimelinePage<LabRequestRecord> { return unavailable(); },
  createLabRequest(_patientId: string, _encounterId: string, _input: CreateLabRequestInput): ClinicalCreateResult { return unavailable(); },
  uploadDocument(_patientId: string): ClinicalCreateResult { return unavailable(); },
};
