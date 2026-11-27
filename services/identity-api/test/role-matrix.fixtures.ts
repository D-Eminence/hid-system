import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACILITY_MODULE_RULES, facilityModuleAccess, type FacilityModuleAccess, type FacilityModuleKey,
  type FacilityModuleRule }
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

/** A narrow role of owner decision Q137 B (0147): not a column; it is held only beside the roles named. */
export interface RoleMatrixNarrowRole {
  code: string;
  label: string;
  besides: string[];
  givesBack: string;
}

export interface RoleMatrixFixture {
  columns: RoleMatrixColumn[];
  rows: RoleMatrixRow[];
  narrowRoles: { about: string; roles: RoleMatrixNarrowRole[] };
  todayRolePermissions: Record<string, string[]>;
  todayDifferences: string[];
}

export const ROLE_MATRIX_PATH = join(__dirname, 'role-matrix.json');

export function readRoleMatrix(): RoleMatrixFixture {
  return JSON.parse(readFileSync(ROLE_MATRIX_PATH, 'utf8')) as RoleMatrixFixture;
}

const ROLE_ROW = /\(\s*'([a-z_]+)'\s*,\s*(?:'([a-z0-9.-]+)'|([a-z_][a-z0-9_]*))\s*\)/g;
const CODE_CONSTANT = /\b([a-z_][a-z0-9_]*)\s+constant\s+text\s*:=\s*'([a-z0-9.-]+)'\s*;/g;

/**
 * The (role, permission) pairs of one role-row statement whose body starts at
 * `at` in `text`. A permission is a quoted code ('admin', 'ocr.job.start') or,
 * as 0155 writes it, a constant of its block ('admin', new_code): the nearest
 * `new_code constant text := '...';` before the statement gives the code. A
 * name with no such declaration fails the test, so no role row is missed.
 * product-gate.spec.ts and product-gate-own-job.spec.ts read rows with it too.
 */
export function rolePermissionPairs(file: string, text: string, at: number, body: string): [string, string][] {
  return [...body.matchAll(ROLE_ROW)].map((row) => {
    const role = row[1] ?? '';
    if (row[2] !== undefined) return [role, row[2]];
    const declared = [...text.slice(0, at).matchAll(CODE_CONSTANT)].filter((constant) => constant[1] === row[3]).at(-1);
    if (!declared?.[2]) throw new Error(`${file}: a role row names ${row[3]}, which no constant before it declares`);
    return [role, declared[2]];
  });
}

/**
 * auth.role_permissions as the migrations leave it: every (role, permission)
 * pair they insert, read the same way as product-gate.spec.ts and
 * product-gate-own-job.spec.ts, less every pair a later
 * `delete from auth.role_permissions where (role_code, permission_code) in
 * (...)` removes (0136, the role-table changes of Q103 A, Q111 A and Q112 A),
 * in migration order and, within a file, statement order. 0084's one insert
 * by select gives platform.emergency-contact.manage to platform roles only,
 * which no column of Akos's table names.
 */
export function seededRolePermissions(): Map<string, string[]> {
  const directory = join(__dirname, '../../ehr-api/database/migrations');
  const grants = new Map<string, Set<string>>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const text = readFileSync(join(directory, file), 'utf8');
    const statements = [
      ...[...text.matchAll(/insert into auth\.role_permissions\s*\([^)]*\)([\s\S]*?);/gi)]
        .map((statement) => ({ at: statement.index ?? 0, kind: 'insert' as const, body: statement[1] ?? '' })),
      ...[...text.matchAll(/delete from auth\.role_permissions\s+where\s*\(\s*role_code\s*,\s*permission_code\s*\)\s+in\s*\(([\s\S]*?)\);/gi)]
        .map((statement) => ({ at: statement.index ?? 0, kind: 'delete' as const, body: statement[1] ?? '' })),
    ].sort((left, right) => left.at - right.at);
    for (const statement of statements) {
      for (const [role, permission] of rolePermissionPairs(file, text, statement.at, statement.body)) {
        const set = grants.get(role) ?? new Set<string>();
        if (statement.kind === 'insert') set.add(permission);
        else set.delete(permission);
        grants.set(role, set);
      }
    }
  }
  return new Map([...grants].map(([role, set]) => [role, [...set].sort()]));
}

/**
 * Today's level in words. The middle level is not "view only": an area is
 * shown when its show codes are held, and some show codes are writes (for
 * example identity.consent.write), so the line names the act codes missing.
 */
function todayText(today: FacilityModuleAccess, permissions: readonly string[], area: FacilityModuleRule): string {
  if (today !== 'view') return today;
  return `shown, without ${area.act.filter((code) => !permissions.includes(code)).join(' and ')}`;
}

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
          differences.push(`${role} (${column.label}), ${row.label}: ${kind}. Today ${todayText(today, permissions, area)}; Akos's table ${akosText(row, column)}.`);
        }
      }
    }
  }
  return differences;
}
