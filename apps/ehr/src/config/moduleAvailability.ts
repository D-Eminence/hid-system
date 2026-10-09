export type MigratingModuleId =
  | 'laboratory'
  | 'radiology'
  | 'pharmacy'
  | 'billing'
  | 'reports'
  | 'staff';

interface ModuleAvailability {
  title: string;
  description: string;
  migrationNote: string;
  available: false;
}

export const MODULE_AVAILABILITY: Record<MigratingModuleId, ModuleAvailability> = {
  laboratory: {
    title: 'Laboratory Information System (LIS)',
    description: 'Sample processing, test validation, and result reporting',
    migrationNote: 'Laboratory results remain unavailable until the LIS integration has a versioned, audited API contract.',
    available: false,
  },
  radiology: {
    title: 'Radiology & Diagnostic Imaging',
    description: 'Imaging request workflow and reporting',
    migrationNote: 'Radiology access remains unavailable until the imaging service API and DICOM authorization boundary are connected.',
    available: false,
  },
  pharmacy: {
    title: 'Pharmacy POS & Dispensing',
    description: 'Prescription fulfillment and dispensing workflow',
    migrationNote: 'Dispensing remains unavailable until the pharmacy service can enforce prescriptions, inventory, facility access, and audit logging.',
    available: false,
  },
  billing: {
    title: 'Billing & Operational Revenue Ledger',
    description: 'Patient billing, receipts, and claim tracking',
    migrationNote: 'Billing remains unavailable until its backend ownership and access-control contract are migrated.',
    available: false,
  },
  reports: {
    title: 'Hospital Operational Analytics & Reports',
    description: 'Authorized operational and clinical reporting',
    migrationNote: 'Reports remain unavailable until aggregate endpoints prevent row-level patient data exposure.',
    available: false,
  },
  staff: {
    title: 'Staff Directory & Role Assignments',
    description: 'Facility staff and role administration',
    migrationNote: 'Staff administration remains owned by Identity and is unavailable here until its audited API is connected.',
    available: false,
  },
};
