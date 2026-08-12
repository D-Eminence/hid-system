export type Gender = 'Male' | 'Female' | 'Other' | 'Unknown';
export type PatientStatus = 'active' | 'admitted' | 'emergency' | 'discharged' | 'inactive' | 'unknown';

export interface EmergencyContact {
  name: string;
  rel: string;
  phone: string;
}

export interface Patient {
  /** Canonical patient UUID owned by HID Identity. Required for API-backed clinical actions. */
  patientId?: string;
  /** True only when the active authorization decision is emergency read-only access. */
  breakGlass?: boolean;
  hid: string;
  mrn?: string;
  nin?: string;
  firstName?: string;
  lastName?: string;
  fullName: string;
  dob?: string;
  age?: number;
  sex?: Gender;
  bloodGroup?: string;
  phone?: string;
  address?: string;
  emergencyContact?: EmergencyContact;
  registrationDate?: string;
  lastVisit?: string;
  status: PatientStatus;
  dept?: string;
  assignedProvider?: string;
  wardBed?: string;
}

export interface VitalSign {
  id: string;
  date: string;
  bp: string;
  pulse: number;
  temp: number;
  rr: number;
  spo2: number;
  weight: number;
  height: number;
  bmi: number;
  recordedBy: string;
}

export interface Allergy {
  id: string;
  substance: string;
  type: 'Drug' | 'Environmental' | 'Food';
  severity: 'Mild' | 'Moderate' | 'Severe';
  reaction: string;
  recorded: string;
  recordedBy: string;
}

export interface Problem {
  id: string;
  icd: string;
  desc: string;
  onset: string;
  status: 'active' | 'resolved';
  severity: 'Mild' | 'Moderate' | 'Severe';
}

export interface PrescriptionLine {
  id: string | number;
  drug: string;
  form: string;
  dosage: string;
  route: string;
  frequency: string;
  duration: string;
  indication: string;
  qty: string;
}

export interface Prescription {
  id: string;
  lines: PrescriptionLine[];
  prescribedBy: string;
  prescribedDate: string;
  status: 'active' | 'inactive';
  dispensed: boolean;
}

export interface LabResultItem {
  test: string;
  value: number | string;
  unit: string;
  ref: string;
  flag: 'H' | 'L' | null;
}

export interface LabOrder {
  id: string;
  panel: string;
  ordered: string;
  resulted?: string | null;
  orderedBy: string;
  status: 'pending' | 'processing' | 'resulted' | 'cancelled';
  lab: string;
  results: LabResultItem[];
}

export interface Encounter {
  id: string;
  date: string;
  type: 'Outpatient' | 'Inpatient' | 'Emergency' | 'Telehealth';
  dept: string;
  provider: string;
  chiefComplaint: string;
  diagnosis: string[];
  notes: string;
  followUp?: string | null;
  status: 'completed' | 'in-progress' | 'cancelled';
}

export interface StaffRole {
  key: string;
  label: string;
  who: string;
  initials: string;
  tier: number;
  tierLabel: string;
  focus: string;
  home: string;
  nav: string[];
}

export type EhrNavId = 'dashboard' | 'patients' | 'identity_link' | 'modules' | 'setup';

export interface EhrNavItem {
  id: EhrNavId;
  label: string;
  icon: string;
}

export interface EhrStaffRole {
  key: string;
  label: string;
  who: string;
  initials: string;
  focus: string;
  home: EhrNavId;
  nav: EhrNavId[];
}

export interface EhrFacilityContext {
  id: string;
  name: string;
  code: string;
  type: string;
  departments: string[];
}
