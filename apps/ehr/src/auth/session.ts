import type { EhrNavId, EhrStaffRole } from '@/types/ehr.types';
import type { AuthSession } from '@/api/contracts';
import { ROLE_POLICIES } from '@/config/ehr';

const normalizeRoleKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s-]+/g, '_');

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  doctor: 'physician',
  clinician: 'physician',
  medical_officer: 'physician',
  lab: 'lab_scientist',
  laboratory: 'lab_scientist',
  lab_technician: 'lab_scientist',
  receptionist: 'reception',
  front_desk: 'reception',
};

const PERMISSION_NAVIGATION: Readonly<Record<string, readonly EhrNavId[]>> = {
  'identity.patient.read': ['patients', 'identity_link'],
  'ehr.encounter.read': ['patients'],
  'ehr.encounter.write': ['patients'],
};

export const deriveStaffRole = (session: AuthSession): EhrStaffRole => {
  const supportedRoleKeys = new Set(ROLE_POLICIES.map((role) => role.key));
  const derivedRoleKeys = new Set(
    session.actor.roles
      .map(normalizeRoleKey)
      .map((role) => ROLE_ALIASES[role] ?? role)
      .filter((role) => supportedRoleKeys.has(role)),
  );
  if (derivedRoleKeys.size !== 1) {
    throw new Error('Your assigned roles do not resolve to one supported EHR role. Contact an administrator.');
  }
  const [roleKey] = derivedRoleKeys;
  const rolePolicy = ROLE_POLICIES.find((candidate) => candidate.key === roleKey);
  if (!rolePolicy) {
    throw new Error('Your assigned role is not enabled for this EHR application.');
  }

  if (!session.actor.permissions?.length) {
    throw new Error('Your session does not include an authorization scope. Contact an administrator.');
  }
  const permittedNavigation = new Set(
    session.actor.permissions.flatMap((permission) => PERMISSION_NAVIGATION[permission] ?? []),
  );
  const nav = rolePolicy.nav.filter((item) => permittedNavigation.has(item));
  if (nav.length === 0) {
    throw new Error('Your assigned permissions do not enable an EHR workflow. Contact an administrator.');
  }
  if (rolePolicy.nav.includes('dashboard')) nav.unshift('dashboard');
  if (rolePolicy.nav.includes('modules')) nav.push('modules');

  return {
    ...rolePolicy,
    label: session.actor.roleLabel ?? rolePolicy.label,
    who: session.actor.displayName,
    initials: session.actor.displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join(''),
    nav,
    home: nav.includes(rolePolicy.home) ? rolePolicy.home : nav[0],
  };
};
