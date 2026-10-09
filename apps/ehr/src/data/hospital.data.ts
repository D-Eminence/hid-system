import type { Patient, VitalSign, Allergy, Problem, LabOrder, Encounter } from '@/types/ehr.types';

// ---------------------------------------------------------------------------
// Extended types not in core ehr.types.ts
// ---------------------------------------------------------------------------

export interface Medication {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  route: string;
  indication: string;
  prescribed: string;
  expires: string;
  prescribedBy: string;
  status: 'active' | 'inactive';
  dispensed: boolean;
}

export interface Immunisation {
  id: string;
  vaccine: string;
  date: string;
  site: string;
  lot: string;
  givenBy: string;
  nextDue: string | null;
}

export interface DrugCatalogueItem {
  id: string;
  name: string;
  forms: string[];
  routes: string[];
  category: string;
}

export interface LabTestCatalogueItem {
  id: string;
  name: string;
  dept: string;
  tat: string;
  price: number;
}

export interface AuditLogEntry {
  id: string;
  ts: string;
  actor: string;
  role: string;
  action: string;
  resource: string;
  ip: string;
  breakGlass?: boolean;
  reason?: string;
}

export interface BreakGlassContract {
  fourPartContract: string[];
  allowedRoles: string[];
  notAllowed: string[];
  maxDurationMinutes: number;
}

// ---------------------------------------------------------------------------
// PATIENT RECORD
// ---------------------------------------------------------------------------

export const PATIENT: Patient & {
  nin?: string;
  address: string;
  occupation?: string;
  nationality?: string;
  state?: string;
  religion?: string;
  maritalStatus?: string;
  photo?: null;
} = {
  hid: '',
  fullName: '',
  status: 'unknown',
  address: '',
  photo: null,
};

// ---------------------------------------------------------------------------
// ALLERGIES
// ---------------------------------------------------------------------------

export const ALLERGIES: Allergy[] = [];

// ---------------------------------------------------------------------------
// MEDICATIONS
// ---------------------------------------------------------------------------

export const MEDICATIONS: Medication[] = [];

// ---------------------------------------------------------------------------
// VITALS HISTORY
// ---------------------------------------------------------------------------

export const VITALS_HISTORY: VitalSign[] = [];

// ---------------------------------------------------------------------------
// LAB RESULTS
// ---------------------------------------------------------------------------

export const LAB_RESULTS: LabOrder[] = [];

// ---------------------------------------------------------------------------
// ENCOUNTER HISTORY
// ---------------------------------------------------------------------------

export const ENCOUNTERS: Encounter[] = [];

// ---------------------------------------------------------------------------
// PROBLEM LIST
// ---------------------------------------------------------------------------

export const PROBLEM_LIST: Problem[] = [];

// ---------------------------------------------------------------------------
// IMMUNISATIONS
// ---------------------------------------------------------------------------

export const IMMUNISATIONS: Immunisation[] = [];

// ---------------------------------------------------------------------------
// DRUG CATALOGUE
// ---------------------------------------------------------------------------

export const DRUG_CATALOGUE: DrugCatalogueItem[] = [];

// ---------------------------------------------------------------------------
// LAB TEST CATALOGUE
// ---------------------------------------------------------------------------

export const LAB_TEST_CATALOGUE: LabTestCatalogueItem[] = [];

// ---------------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------------

export const AUDIT_LOG: AuditLogEntry[] = [];

// ---------------------------------------------------------------------------
// BREAK-GLASS CONTRACT
// ---------------------------------------------------------------------------

export const BREAK_GLASS_CONTRACT: BreakGlassContract = {
  fourPartContract: [
    'Requires a stated reason',
    'Notifies the patient',
    'Auto-expires (max 4 hours)',
    'Admin-reviewable audit trail',
  ],
  allowedRoles: ['Physician', 'Surgeon', 'Consultant', 'Medical Officer'],
  notAllowed: ['Pharmacist', 'Lab Scientist', 'Finance', 'Reception'],
  maxDurationMinutes: 240,
};
