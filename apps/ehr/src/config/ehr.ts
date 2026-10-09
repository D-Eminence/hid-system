import type {
  EhrFacilityContext,
  EhrNavId,
  EhrNavItem,
  EhrStaffRole,
} from '@/types/ehr.types';

const rolePolicy = (
  key: string,
  label: string,
  focus: string,
  home: EhrNavId,
  nav: EhrNavId[],
): EhrStaffRole => ({ key, label, focus, home, nav, who: '', initials: '' });

/** Presentation policies only. Actor identity and authorization always come from the API session. */
export const ROLE_POLICIES: EhrStaffRole[] = [
  rolePolicy('physician', 'Physician', 'Longitudinal clinical care', 'patients', ['dashboard', 'patients', 'identity_link', 'modules']),
  rolePolicy('nurse', 'Nurse', 'Clinical observations and documentation', 'patients', ['dashboard', 'patients', 'identity_link', 'modules']),
  rolePolicy('lab_scientist', 'Laboratory Professional', 'EHR laboratory-request review', 'patients', ['dashboard', 'patients', 'identity_link', 'modules']),
  rolePolicy('pharmacist', 'Pharmacist', 'EHR medication-request review', 'patients', ['dashboard', 'patients', 'identity_link', 'modules']),
  rolePolicy('reception', 'Registration Coordinator', 'Authorized patient identity linking', 'identity_link', ['dashboard', 'patients', 'identity_link', 'modules']),
];

export const NAV_ITEMS: EhrNavItem[] = [
  { id: 'dashboard', label: 'EHR Overview', icon: 'home' },
  { id: 'patients', label: 'Patient Records', icon: 'clipboard' },
  { id: 'identity_link', label: 'Link Existing HID', icon: 'user' },
  { id: 'modules', label: 'All Modules', icon: 'grid' },
  { id: 'setup', label: 'Facility Setup', icon: 'settings' },
];

export const EMPTY_FACILITY_CONTEXT: EhrFacilityContext = {
  id: '',
  name: '',
  type: 'healthcare_facility',
  code: '',
  departments: [],
};
