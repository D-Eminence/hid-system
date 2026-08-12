import React from 'react';
import { PATIENT } from './hospital-data';

/* ehr-data.jsx - enterprise records + ROLES + NAV + modular CONFIG */

// ---- ROLES (15 roles in 7 tiers) ----
const ROLES = [
  // L1 Platform
  { key: 'sys_admin', label: 'System Administrator', who: 'System Administrator', initials: 'SA', tier: 1, tierLabel: 'L1 Platform', focus: 'System configuration, logs, user management & security', home: 'setup', nav: ['dashboard', 'setup', 'staff', 'reports'] },
  { key: 'platform_mgr', label: 'Platform Manager', who: 'Platform Manager', initials: 'PM', tier: 1, tierLabel: 'L1 Platform', focus: 'Facility management, system metrics & integration', home: 'dashboard', nav: ['dashboard', 'setup', 'reports', 'quality'] },

  // L2 Clinical
  { key: 'physician', label: 'Attending Physician', who: 'Attending Physician', initials: 'AP', tier: 2, tierLabel: 'L2 Clinical', focus: 'Patient consultation, diagnosis, prescribing & lab ordering', home: 'patients', nav: ['dashboard', 'patients', 'triage', 'inpatient', 'appointments', 'maternity', 'surgery', 'telemedicine', 'referrals'] },
  { key: 'surgeon', label: 'Consultant Surgeon', who: 'Consultant Surgeon', initials: 'CS', tier: 2, tierLabel: 'L2 Clinical', focus: 'Surgical bookings, pre-op, intra-op & post-op care', home: 'surgery', nav: ['dashboard', 'patients', 'surgery', 'inpatient', 'emergency'] },
  { key: 'specialist', label: 'Specialist Consultant', who: 'Specialist Consultant', initials: 'SC', tier: 2, tierLabel: 'L2 Clinical', focus: 'Specialised consultations & multi-disciplinary care', home: 'patients', nav: ['dashboard', 'patients', 'inpatient', 'appointments', 'telemedicine'] },

  // L3 Nursing
  { key: 'head_nurse', label: 'Head Nurse / Matron', who: 'Head Nurse / Matron', initials: 'HN', tier: 3, tierLabel: 'L3 Nursing', focus: 'Ward management, nurse shift rostering, patient triage & bed allocation', home: 'triage', nav: ['dashboard', 'patients', 'triage', 'inpatient', 'maternity', 'shifts', 'blood_bank'] },
  { key: 'nurse', label: 'Staff Nurse', who: 'Staff Nurse', initials: 'SN', tier: 3, tierLabel: 'L3 Nursing', focus: 'Vitals capture, medication administration & bedside notes', home: 'triage', nav: ['patients', 'triage', 'inpatient', 'maternity', 'shifts'] },

  // L4 Paramedical
  { key: 'lab_scientist', label: 'Medical Lab Scientist', who: 'Medical Lab Scientist', initials: 'ML', tier: 4, tierLabel: 'L4 Paramedical', focus: 'Sample processing, result validation & lab inventory', home: 'lab', nav: ['dashboard', 'lab', 'blood_bank'] },
  { key: 'radiographer', label: 'Radiographer', who: 'Radiographer', initials: 'R', tier: 4, tierLabel: 'L4 Paramedical', focus: 'Medical imaging, DICOM scan management & reporting', home: 'radiology', nav: ['dashboard', 'radiology'] },
  { key: 'pharmacist', label: 'Lead Pharmacist', who: 'Lead Pharmacist', initials: 'LP', tier: 4, tierLabel: 'L4 Paramedical', focus: 'Prescription dispensing, drug interaction checks & stock POS', home: 'pharmacy', nav: ['dashboard', 'pharmacy', 'inventory'] },

  // L5 Operations
  { key: 'reception', label: 'Front Desk / Reception', who: 'Front Desk / Reception', initials: 'FD', tier: 5, tierLabel: 'L5 Operations', focus: 'Patient registration, appointment scheduling & check-in', home: 'registration', nav: ['registration', 'patients', 'appointments', 'ambulance'] },
  { key: 'billing_officer', label: 'Billing Officer', who: 'Billing Officer', initials: 'BO', tier: 5, tierLabel: 'L5 Operations', focus: 'Point of sale, patient invoices, payments & HMO claims', home: 'billing', nav: ['billing', 'patients', 'insurance'] },

  // L6 Management
  { key: 'hospital_owner', label: 'Hospital Director / Owner', who: 'Hospital Director / Owner', initials: 'HD', tier: 6, tierLabel: 'L6 Management', focus: 'Executive overview, financial performance & clinical governance', home: 'dashboard', nav: ['dashboard', 'reports', 'billing', 'hr', 'quality', 'setup'] },
  { key: 'dept_head', label: 'Head of Clinical Services', who: 'Head of Clinical Services', initials: 'HO', tier: 6, tierLabel: 'L6 Management', focus: 'Departmental performance, quality metrics & staffing', home: 'dashboard', nav: ['dashboard', 'patients', 'reports', 'quality', 'shifts'] },
  { key: 'hr_manager', label: 'HR Manager', who: 'HR Manager', initials: 'HM', tier: 6, tierLabel: 'L6 Management', focus: 'Staff credentials, shift rosters & personnel files', home: 'hr', nav: ['hr', 'staff', 'shifts'] },

  // L7 Finance
  { key: 'finance_officer', label: 'Chief Finance Officer', who: 'Chief Finance Officer', initials: 'CF', tier: 7, tierLabel: 'L7 Finance', focus: 'Revenue reconciliation, insurance claim audit & vendor ledgers', home: 'billing', nav: ['dashboard', 'billing', 'reports', 'insurance', 'inventory'] },
];

// ---- NAV MODULE CATALOGUE ----
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'patients', label: 'Patients', icon: 'users' },
  { id: 'registration', label: 'Registration', icon: 'user' },
  { id: 'triage', label: 'Triage / Vitals', icon: 'activity' },
  { id: 'inpatient', label: 'Inpatient / Wards', icon: 'bed' },
  { id: 'appointments', label: 'Appointments', icon: 'calendar' },
  { id: 'emergency', label: 'Emergency / A&E', icon: 'zap' },
  { id: 'maternity', label: 'Maternity / ANC', icon: 'heart' },
  { id: 'surgery', label: 'Surgery / OT', icon: 'scissors' },
  { id: 'lab', label: 'Laboratory', icon: 'flask' },
  { id: 'radiology', label: 'Radiology', icon: 'eye' },
  { id: 'pharmacy', label: 'Pharmacy POS', icon: 'pill' },
  { id: 'billing', label: 'Billing & Payments', icon: 'dollar' },
  { id: 'reports', label: 'Reports & Analytics', icon: 'barChart' },
  { id: 'staff', label: 'Staff Directory', icon: 'award' },
  { id: 'hr', label: 'HR & Rosters', icon: 'users' },
  { id: 'quality', label: 'Quality & Audit', icon: 'shield' },
  { id: 'insurance', label: 'HMO / Insurance', icon: 'fileText' },
  { id: 'inventory', label: 'Inventory & Stores', icon: 'package' },
  { id: 'ambulance', label: 'Ambulance & Dispatch', icon: 'ambulance' },
  { id: 'blood_bank', label: 'Blood Bank', icon: 'droplet' },
  { id: 'telemedicine', label: 'Telemedicine', icon: 'phone' },
  { id: 'referrals', label: 'Referrals & Outreach', icon: 'map' },
  { id: 'shifts', label: 'Shifts & Roster', icon: 'clock' },
  { id: 'setup', label: 'Hospital Setup', icon: 'settings' },
];

// ---- DEPARTMENTS CATALOGUE ----
const DEPARTMENTS = {
  outpatient: { id: 'outpatient', label: 'Outpatient Clinic (OPD)', core: true, icon: 'users', modules: ['patients', 'appointments', 'triage', 'telemedicine', 'referrals'], roles: ['physician', 'specialist', 'nurse', 'reception'] },
  emergency: { id: 'emergency', label: 'Accident & Emergency (A&E)', core: true, icon: 'zap', modules: ['emergency', 'triage', 'ambulance'], roles: ['physician', 'surgeon', 'nurse'] },
  nursing: { id: 'nursing', label: 'Nursing Services', core: true, icon: 'activity', modules: ['triage', 'shifts'], roles: ['head_nurse', 'nurse'] },
  administration: { id: 'administration', label: 'Hospital Administration', core: true, icon: 'building', modules: ['dashboard', 'setup', 'staff', 'reports'], roles: ['sys_admin', 'platform_mgr', 'hospital_owner'] },
  laboratory: { id: 'laboratory', label: 'Laboratory Services (LIS)', core: false, icon: 'flask', modules: ['lab'], roles: ['lab_scientist'] },
  radiology: { id: 'radiology', label: 'Radiology & Imaging', core: false, icon: 'eye', modules: ['radiology'], roles: ['radiographer'] },
  pharmacy: { id: 'pharmacy', label: 'Pharmacy & Dispensary', core: false, icon: 'pill', modules: ['pharmacy', 'inventory'], roles: ['pharmacist'] },
  surgery: { id: 'surgery', label: 'Operating Theatre (OT)', core: false, icon: 'scissors', modules: ['surgery'], roles: ['surgeon'] },
  maternity: { id: 'maternity', label: 'Maternity & Child Health', core: false, icon: 'heart', modules: ['maternity'], roles: ['physician', 'nurse'] },
  inpatient: { id: 'inpatient', label: 'Inpatient Wards (IPD)', core: false, icon: 'bed', modules: ['inpatient'], roles: ['head_nurse', 'nurse', 'physician'] },
  hr: { id: 'hr', label: 'Human Resources', core: false, icon: 'users', modules: ['hr', 'shifts'], roles: ['hr_manager'] },
  finance: { id: 'finance', label: 'Finance & Billing', core: false, icon: 'dollar', modules: ['billing', 'reports'], roles: ['billing_officer', 'finance_officer'] },
  insurance: { id: 'insurance', label: 'HMO & Health Insurance', core: false, icon: 'fileText', modules: ['insurance'], roles: ['billing_officer', 'finance_officer'] },
  blood_bank: { id: 'blood_bank', label: 'Blood Transfusion Service', core: false, icon: 'droplet', modules: ['blood_bank'], roles: ['lab_scientist', 'head_nurse'] },
  telemedicine: { id: 'telemedicine', label: 'Telehealth & Remote Care', core: false, icon: 'phone', modules: ['telemedicine'], roles: ['physician', 'specialist'] },
  ambulance: { id: 'ambulance', label: 'Ambulance & Emergency Transport', core: false, icon: 'ambulance', modules: ['ambulance'], roles: ['reception'] },
};

// ---- FACILITY TYPES & PRESETS ----
const FACILITY_TYPES = [
  { id: 'clinic', label: 'Outpatient Clinic / Primary Center', desc: 'Basic outpatient care, vitals, pharmacy and essential laboratory.' },
  { id: 'district_hospital', label: 'General / District Hospital', desc: 'Comprehensive secondary care including Inpatient Wards, Emergency, Maternity & Surgery.' },
  { id: 'specialist_hospital', label: 'Specialist Hospital', desc: 'Specialized clinical care with advanced diagnostic imaging, LIS and Blood Bank.' },
  { id: 'teaching_hospital', label: 'Tertiary / Teaching Hospital', desc: 'Full enterprise footprint across all 16 clinical and operational departments.' },
];

const TYPE_PRESETS = {
  clinic: ['outpatient', 'administration', 'pharmacy', 'laboratory', 'finance'],
  district_hospital: ['outpatient', 'emergency', 'nursing', 'administration', 'laboratory', 'radiology', 'pharmacy', 'surgery', 'maternity', 'inpatient', 'finance', 'insurance'],
  specialist_hospital: ['outpatient', 'emergency', 'nursing', 'administration', 'laboratory', 'radiology', 'pharmacy', 'surgery', 'inpatient', 'finance', 'insurance', 'blood_bank', 'telemedicine'],
  teaching_hospital: ['outpatient', 'emergency', 'nursing', 'administration', 'laboratory', 'radiology', 'pharmacy', 'surgery', 'maternity', 'inpatient', 'hr', 'finance', 'insurance', 'blood_bank', 'telemedicine', 'ambulance'],
};

// ---- CORE DEFAULTS ----
const CORE_MODULES = ['dashboard', 'patients', 'registration', 'triage', 'setup', 'reports'];
const CORE_ROLES = ['sys_admin', 'physician', 'nurse', 'reception', 'hospital_owner'];

// Helper to compute enabled modules based on active department IDs
const enabledModules = (deptIds = []) => {
  const mods = new Set(CORE_MODULES);
  deptIds.forEach(did => {
    const dept = DEPARTMENTS[did];
    if (dept && dept.modules) {
      dept.modules.forEach(m => mods.add(m));
    }
  });
  return mods;
};

// Helper to compute enabled role keys based on active department IDs
const enabledRoleKeys = (deptIds = []) => {
  const rkeys = new Set(CORE_ROLES);
  deptIds.forEach(did => {
    const dept = DEPARTMENTS[did];
    if (dept && dept.roles) {
      dept.roles.forEach(r => rkeys.add(r));
    }
  });
  return rkeys;
};

// ---- LIVE CONFIG DEFAULT ----
const HOSPITAL_CONFIG = {
  name: '',
  type: '',
  departments: [],
  multiBranch: false,
  branches: [],
  currency: '',
  timezone: '',
  hmoIntegrated: false,
};

// ---- PATIENT RECORDS LIST ----
const PATIENTS_LIST = [];

// ---- APPOINTMENTS ----
const APPOINTMENTS = [];

// ---- INPATIENT BEDS ----
const INPATIENT_BEDS = [];

// ---- BILLING QUEUE ----
const BILLING_QUEUE = [];



export { ROLES, NAV, DEPARTMENTS, FACILITY_TYPES, TYPE_PRESETS, CORE_MODULES, CORE_ROLES, enabledModules, enabledRoleKeys, HOSPITAL_CONFIG, PATIENTS_LIST, APPOINTMENTS, INPATIENT_BEDS, BILLING_QUEUE };
