import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACILITY_MODULE_RULES, facilityModuleAccess, type FacilityModuleAccess, type FacilityModuleKey }
  from '../src/auth/facility-modules';

/**
 * SX-1 (Akos N-2b, N-2e): Akos's proposed role table, checked in as
 * role-matrix.json, compared with the role rows the migrations seed today.
 * Test-only: no database, no network.
 */

/** A cell of Akos's table: Full, View, "With lab orders" / "With prescriptions", "View (audit)" or "—". */
export type AkosCell = 'full' | 'view' | 'scoped' | 'audit' | 'hidden';

export interface RoleMatrixColumn {
  id: string;
  label: string;
  /** The role codes (auth.roles) this column of Akos's table stands for. */
  roles: string[];
}

export interface RoleMatrixRow {
  label: string;
  /** The session area this row is compared through, or null when no area stands for it yet. */
  module: FacilityModuleKey | null;
  cells: Record<string, AkosCell>;
  scopedText?: Record<string, string>;
  derived?: string;
  notCompared?: string;
}

export interface RoleMatrixFixture {
  columns: RoleMatrixColumn[];
  rows: RoleMatrixRow[];
  todayRolePermissions: Record<string, string[]>;
  todayDifferences: string[];
}

export const ROLE_MATRIX_PATH = join(__dirname, 'role-matrix.json');

export function readRoleMatrix(): RoleMatrixFixture {
  return JSON.parse(readFileSync(ROLE_MATRIX_PATH, 'utf8')) as RoleMatrixFixture;
}

/**
 * auth.role_permissions as the migrations seed it: every (role, permission)
 * pair they insert, read the same way as product-gate.spec.ts and
 * product-gate-own-job.spec.ts. No migration removes a row (there is no
 * delete from auth.role_permissions); 0084's one insert by select gives
 * platform.emergency-contact.manage to platform roles only, which no column
 * of Akos's table names.
 */
export function seededRolePermissions(): Map<string, string[]> {
  const directory = join(__dirname, '../../ehr-api/database/migrations');
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
  return new Map([...grants].map(([role, set]) => [role, [...set].sort()]));
}

const TODAY_TEXT: Record<FacilityModuleAccess, string> = { hidden: 'hidden', view: 'view only', full: 'full' };

function akosText(row: RoleMatrixRow, column: RoleMatrixColumn): string {
  const cell = row.cells[column.id];
  if (cell === 'scoped') return row.scopedText?.[column.id] ?? 'limited';
  if (cell === 'audit') return 'through the audit trail only';
  if (cell === 'view') return 'view only';
  return cell ?? 'missing';
}

const RANK: Record<FacilityModuleAccess, number> = { hidden: 0, view: 1, full: 2 };

/**
 * Every place where a role's seeded permissions today give more ("wider") or
 * less ("narrower") than Akos's table, one plain sentence each, in the order
 * of the table's columns, roles and rows.
 */
export function roleMatrixDifferences(fixture: RoleMatrixFixture, permissionsOf: (role: string) => readonly string[]): string[] {
  const differences: string[] = [];
  for (const column of fixture.columns) {
    for (const role of column.roles) {
      const permissions = permissionsOf(role);
      for (const row of fixture.rows) {
        if (!row.module) continue;
        const area = FACILITY_MODULE_RULES.find((candidate) => candidate.key === row.module);
        if (!area) throw new Error(`No session area named ${row.module}`);
        const today = facilityModuleAccess(permissions, area);
        const cell = row.cells[column.id];
        if (!cell) throw new Error(`Row "${row.label}" has no cell for ${column.id}`);
        let kind: 'wider' | 'narrower' | undefined;
        if (cell === 'audit') {
          if (today !== 'hidden') kind = 'wider';
          else if (!permissions.includes('audit.read')) kind = 'narrower';
        } else {
          const wanted = cell === 'full' ? 2 : cell === 'hidden' ? 0 : 1;
          if (RANK[today] > wanted) kind = 'wider';
          else if (RANK[today] < wanted) kind = 'narrower';
        }
        if (kind) {
          differences.push(`${role} (${column.label}), ${row.label}: ${kind}. Today ${TODAY_TEXT[today]}; Akos's table ${akosText(row, column)}.`);
        }
      }
    }
  }
  return differences;
}
