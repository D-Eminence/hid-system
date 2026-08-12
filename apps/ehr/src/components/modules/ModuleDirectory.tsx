import React from 'react';
import { Badge, Button, Icon, PageHead } from '@/components/ui/Primitives';
import type { IconName } from '@/components/ui/Primitives';
import {
  AppointmentsModule,
  EmergencyModule,
  InpatientModule,
  MaternityModule,
  SurgeryModule,
  TriageModule,
} from '@/ehr-clinical';
import {
  BillingModule,
  PharmacyModule,
  RadiologyModule,
  ReportsModule,
  StaffModule,
} from '@/ehr-ops';
import {
  AmbulanceModule,
  BloodBankModule,
  HRModule,
  InsuranceModule,
  InventoryModule,
  QualityModule,
  ReferralsModule,
  ShiftsModule,
  TelemedicineModule,
} from '@/ehr-extra';
import type { EhrNavId } from '@/types/ehr.types';

export type GatedModuleId =
  | 'triage'
  | 'inpatient'
  | 'appointments'
  | 'emergency'
  | 'maternity'
  | 'surgery'
  | 'radiology'
  | 'pharmacy'
  | 'billing'
  | 'reports'
  | 'staff'
  | 'shifts'
  | 'hr'
  | 'quality'
  | 'insurance'
  | 'inventory'
  | 'ambulance'
  | 'blood_bank'
  | 'telemedicine'
  | 'referrals';

interface ModuleEntry {
  id: EhrNavId | GatedModuleId | 'laboratory' | 'ocr_operations';
  label: string;
  description: string;
  icon: IconName;
  available: boolean;
  externalHref?: string;
}

interface ModuleGroup {
  title: string;
  entries: ModuleEntry[];
}

const MODULE_GROUPS: ModuleGroup[] = [
  {
    title: 'Core EHR',
    entries: [
      { id: 'dashboard', label: 'EHR Overview', description: 'Permission-derived clinical workspace overview and access status.', icon: 'home', available: true },
      { id: 'patients', label: 'Patient Records', description: 'Authorized HID lookup, encounters, notes, observations, diagnoses, requests, and documents.', icon: 'clipboard', available: true },
      { id: 'identity_link', label: 'Identity Linking', description: 'Verify and link an existing HID through the governed Identity boundary.', icon: 'user', available: true },
      { id: 'setup', label: 'Facility Setup', description: 'Configure facility type, departments, roles, branches, and operating settings.', icon: 'settings', available: true },
    ],
  },
  {
    title: 'Clinical Workflows',
    entries: [
      { id: 'triage', label: 'Triage & Vitals', description: 'Clinical intake and observation workflow.', icon: 'activity', available: false },
      { id: 'inpatient', label: 'Inpatient & Wards', description: 'Admissions, wards, beds, and inpatient workflow.', icon: 'bed', available: false },
      { id: 'appointments', label: 'Appointments', description: 'Consultation scheduling and check-in.', icon: 'calendar', available: false },
      { id: 'emergency', label: 'Emergency & A&E', description: 'Emergency and break-glass care workflow.', icon: 'zap', available: false },
      { id: 'maternity', label: 'Maternity & ANC', description: 'Antenatal, maternity, and child-health workflow.', icon: 'heart', available: false },
      { id: 'surgery', label: 'Surgery & Theatre', description: 'Pre-op, theatre, and post-op workflow.', icon: 'scissors', available: false },
      { id: 'telemedicine', label: 'Telemedicine', description: 'Remote clinical consultation workflow.', icon: 'phone', available: false },
      { id: 'referrals', label: 'Referrals & Outreach', description: 'Referral and field-care coordination.', icon: 'map', available: false },
    ],
  },
  {
    title: 'Diagnostics & Medicines',
    entries: [
      { id: 'laboratory', label: 'Laboratory', description: 'Open the facility-scoped accession, custody, execution, and result workflow.', icon: 'flask', available: true, externalHref: '/lab/' },
      { id: 'radiology', label: 'Radiology', description: 'Imaging requests, DICOM workflow, and reports.', icon: 'eye', available: false },
      { id: 'pharmacy', label: 'Pharmacy', description: 'Open the governed prescription acceptance, dispensing, and reversal workspace.', icon: 'pill', available: true, externalHref: '/pharmacy/' },
      { id: 'ocr_operations', label: 'OCR Operations', description: 'Open the governed extraction job, retry, validation-state, and publication workspace.', icon: 'fileText', available: true, externalHref: '/ocr/' },
      { id: 'blood_bank', label: 'Blood Bank', description: 'Blood products and transfusion workflow.', icon: 'droplet', available: false },
    ],
  },
  {
    title: 'Facility Operations',
    entries: [
      { id: 'billing', label: 'Billing & Payments', description: 'Invoices, receipts, claims, and operational ledgers.', icon: 'dollar', available: false },
      { id: 'insurance', label: 'HMO & Insurance', description: 'Coverage, authorization, and claim workflow.', icon: 'fileText', available: false },
      { id: 'inventory', label: 'Inventory & Stores', description: 'Stock, supplies, and facility stores.', icon: 'package', available: false },
      { id: 'ambulance', label: 'Ambulance & Dispatch', description: 'Transport requests and dispatch coordination.', icon: 'truck', available: false },
      { id: 'staff', label: 'Staff Directory', description: 'Facility staff and role assignments.', icon: 'users', available: false },
      { id: 'hr', label: 'Human Resources', description: 'Credentials, personnel, and workforce records.', icon: 'award', available: false },
      { id: 'shifts', label: 'Shifts & Rosters', description: 'Staff scheduling and duty rosters.', icon: 'clock', available: false },
      { id: 'quality', label: 'Quality & Governance', description: 'Clinical quality, audit, and governance.', icon: 'shield', available: false },
      { id: 'reports', label: 'Reports & Analytics', description: 'Authorized operational and clinical aggregates.', icon: 'barChart', available: false },
    ],
  },
];

const GATED_COMPONENTS: Record<GatedModuleId, React.ComponentType> = {
  triage: TriageModule,
  inpatient: InpatientModule,
  appointments: AppointmentsModule,
  emergency: EmergencyModule,
  maternity: MaternityModule,
  surgery: SurgeryModule,
  radiology: RadiologyModule,
  pharmacy: PharmacyModule,
  billing: BillingModule,
  reports: ReportsModule,
  staff: StaffModule,
  shifts: ShiftsModule,
  hr: HRModule,
  quality: QualityModule,
  insurance: InsuranceModule,
  inventory: InventoryModule,
  ambulance: AmbulanceModule,
  blood_bank: BloodBankModule,
  telemedicine: TelemedicineModule,
  referrals: ReferralsModule,
};

interface ModuleDirectoryProps {
  onNavigate: (nav: EhrNavId) => void;
  onOpenModule: (moduleId: GatedModuleId) => void;
  canConfigureFacility: boolean;
}

export const ModuleDirectory: React.FC<ModuleDirectoryProps> = ({ onNavigate, onOpenModule, canConfigureFacility }) => (
  <div className="fade-in ehr-module-directory">
    <PageHead title="All EHR Modules" sub="Every retained EHR workflow is discoverable from this directory; gated modules remain read-only until their backend contracts are audited." />
    {MODULE_GROUPS.map((group) => (
      <section key={group.title} className="ehr-module-section">
        <h2>{group.title}</h2>
        <div className="ehr-module-grid">
          {group.entries.map((entry) => {
            const setupRestricted = entry.id === 'setup' && !canConfigureFacility;
            const enabled = entry.available && !setupRestricted;
            return (
              <button
                type="button"
                key={entry.id}
                className="ehr-module-card"
                disabled={setupRestricted}
                title={setupRestricted ? 'Facility setup requires an authorized facility administrator.' : undefined}
                onClick={() => {
                  if (entry.externalHref) {
                    window.location.assign(entry.externalHref);
                    return;
                  }
                  if (entry.id in GATED_COMPONENTS) {
                    onOpenModule(entry.id as GatedModuleId);
                    return;
                  }
                  if (!enabled) {
                    if (!entry.available) onOpenModule(entry.id as GatedModuleId);
                    return;
                  }
                  onNavigate(entry.id as EhrNavId);
                }}
              >
                <span className="ehr-module-icon"><Icon name={entry.icon} size={20} /></span>
                <span className="ehr-module-copy">
                  <strong>{entry.label}</strong>
                  <span>{entry.description}</span>
                </span>
                <Badge variant={setupRestricted || !entry.available ? 'neutral' : 'blue'}>
                  {setupRestricted ? 'Restricted' : entry.available ? 'Available' : 'Gated'}
                </Badge>
                <Icon name={setupRestricted ? 'lock' : 'chevronRight'} size={18} />
              </button>
            );
          })}
        </div>
      </section>
    ))}
  </div>
);

interface ModuleWorkspaceProps {
  moduleId: GatedModuleId;
  onBack: () => void;
}

export const ModuleWorkspace: React.FC<ModuleWorkspaceProps> = ({ moduleId, onBack }) => {
  const Component = GATED_COMPONENTS[moduleId];
  return (
    <div className="fade-in">
      <Button variant="ghost" icon="arrowLeft" onClick={onBack} style={{ marginBottom: 'var(--space-400)' }}>
        All Modules
      </Button>
      <Component />
    </div>
  );
};
