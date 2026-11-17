import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { FacilityAssignment } from '../common/request-context';
import { facilityAdmittedOnProduct, productsForFacilities, type StaffProduct } from './product-gate';

// Owner decision Q97 ("Q97 A"): each staff site for its own job. Pinned in a
// file of its own, apart from product-gate.spec.ts, so that a merge of that
// spec (it is also changed by other gate decisions, such as Q90) can never
// drop these answers unnoticed: a doctor, clinician, nurse or receptionist
// is admitted on ehr. and migrate. only, a hospital administrator (and the
// review-pending administrator) on every site, and every caller of the gate
// uses facilityAdmittedOnProduct, which applies Q97's rule.

/** auth.role_permissions as the migrations seed it. */
function seededRolePermissions(): Map<string, Set<string>> {
  const directory = join(__dirname, '../../../ehr-api/database/migrations');
  const grants = new Map<string, Set<string>>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const text = readFileSync(join(directory, file), 'utf8');
    for (const statement of text.matchAll(/insert into auth\.role_permissions\s*\([^)]*\)([\s\S]*?);/gi)) {
      for (const pair of (statement[1] ?? '').matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z0-9.-]+)'\s*\)/g)) {
        const [, role, permission] = pair as unknown as [string, string, string];
        const set = grants.get(role) ?? new Set<string>();
        set.add(permission);
        grants.set(role, set);
      }
    }
  }
  return grants;
}

const SEEDS = seededRolePermissions();
const permissionsOf = (role: string) => [...(SEEDS.get(role) ?? [])].sort();
const PRODUCTS: StaffProduct[] = ['ehr', 'lab', 'pharmacy', 'migrate', 'outreach'];

function hospital(role: string, extra: Partial<FacilityAssignment> = {}): FacilityAssignment {
  return { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Fictional General Hospital', roles: [role],
    permissions: permissionsOf(role), isPrimary: true, ...extra };
}

const admittedOn = (facility: FacilityAssignment) => PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product));

describe('each staff site for its own job (Q97)', () => {
  it.each(['doctor', 'clinician', 'nurse', 'receptionist'])('a hospital %s is admitted on ehr. and migrate. only', (role) => {
    // The seeds also give these roles reading codes lab., pharmacy. or outreach. name (0018, 0023, 0024, 0038).
    expect(permissionsOf(role)).toEqual(expect.arrayContaining(['ehr.encounter.write', 'outreach.registration.read']));
    expect(admittedOn(hospital(role))).toEqual(['ehr', 'migrate']);
    expect(productsForFacilities([hospital(role)])).toEqual(['ehr', 'migrate']);
  });

  it.each(['admin', 'org_admin'])('a hospital %s is admitted on every site', (role) => {
    expect(admittedOn(hospital(role))).toEqual(PRODUCTS);
  });

  it('the review-pending administrator of a self-signed-up hospital is admitted on every site', () => {
    const pending = hospital('org_admin', { permissions: permissionsOf('org_admin_awaiting_review'),
      selfService: { review: 'pending', organizationType: 'hospital' } });
    expect(admittedOn(pending)).toEqual(PRODUCTS);
  });

  it.each([['lab', ['lab']], ['pharmacist', ['pharmacy']]] as const)('a %s keeps %j only', (role, expected) => {
    expect(admittedOn(hospital(role))).toEqual(expected);
  });

  it('every caller of the gate applies Q97 (facilityAdmittedOnProduct, never facilityFitsProduct alone)', () => {
    for (const file of ['auth.controller.ts', 'current-staff-context.service.ts', 'token.service.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/facilityFitsProduct\s*\(/);
    }
    const controller = readFileSync(join(__dirname, 'auth.controller.ts'), 'utf8');
    const context = readFileSync(join(__dirname, 'current-staff-context.service.ts'), 'utf8');
    expect(controller).toMatch(/facilityAdmittedOnProduct\(candidate, product\)/);
    expect(context).toMatch(/facilityAdmittedOnProduct\(facility, product\)/);
  });
});
