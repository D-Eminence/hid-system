import { FACILITY_MODULE_RULES } from './facility-modules';
import { readRoleMatrix, roleMatrixDifferences, seededRolePermissions } from '../../test/role-matrix.fixtures';

// SX-1 (Akos N-2b, N-2e): Akos's proposed role table (test/role-matrix.json)
// against the role rows the migrations seed today. This test is documentation:
// it passes today because todayDifferences records every current difference,
// one per test name below (wider = today gives more than the table, narrower =
// less). It fails when a migration adds or removes a role_permissions row for
// a role of the table without the same pull request updating the fixture.

const FIXTURE = readRoleMatrix();
const SEEDS = seededRolePermissions();
const permissionsOf = (role: string): readonly string[] => SEEDS.get(role) ?? [];
const ROLES = FIXTURE.columns.flatMap((column) => column.roles);

describe('Akos\'s role table against today\'s role rows (SX-1)', () => {
  it('names each column\'s roles once, and every role is seeded today', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
    for (const role of ROLES) expect(SEEDS.has(role)).toBe(true);
  });

  it('keeps every row of Akos\'s table, and compares each session area exactly once', () => {
    expect(FIXTURE.rows.filter((row) => !row.derived).map((row) => row.label)).toEqual([
      'Find patient', 'Register and check in', 'Access requests and PIN', 'Emergency access', 'Triage and vitals',
      'Nursing observations', 'Consultation and diagnosis', 'Order labs and prescribe', 'Lab queue and results entry',
      'Lab results', 'Dispense medicines', 'Prescriptions', 'Scan paper records', 'Outreach', 'Facility profile and staff',
    ]);
    const compared = FIXTURE.rows.flatMap((row) => (row.module ? [row.module] : []));
    expect(compared).toEqual(FACILITY_MODULE_RULES.map((area) => area.key));
    expect(FIXTURE.rows.filter((row) => !row.module).map((row) => row.label)).toEqual(['Nursing observations']);
    for (const row of FIXTURE.rows) {
      expect(Object.keys(row.cells).sort()).toEqual(FIXTURE.columns.map((column) => column.id).sort());
    }
  });

  it.each(ROLES)('pins every permission the migrations seed for %s', (role) => {
    expect(permissionsOf(role)).toEqual(FIXTURE.todayRolePermissions[role]);
  });

  const differences = roleMatrixDifferences(FIXTURE, permissionsOf);

  it.each(FIXTURE.todayDifferences)('%s', (difference) => {
    expect(differences).toContain(difference);
  });

  it('finds no difference other than the recorded ones, in the same order', () => {
    expect(differences).toEqual(FIXTURE.todayDifferences);
  });

  it('says wider or narrower in every recorded difference, and never names a Health ID or NIN', () => {
    for (const difference of FIXTURE.todayDifferences) {
      expect(difference).toMatch(/: (wider|narrower)\. Today (hidden|view only|full); Akos's table /);
      expect(difference).not.toMatch(/HID-|\bNIN\b/);
    }
  });

  it('records P1-5 today: no clinical role sees the facility profile and staff, and a facility admin does', () => {
    expect(FIXTURE.todayDifferences.filter((difference) => difference.includes('Facility profile and staff'))).toEqual([]);
  });
});
