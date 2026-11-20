import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Owner decision Q113 A (migration 0136): DevOps runs
// docs/rollback/0136_affected_staff_counts.sql against production before the
// owner signs, and 0136 counts again at apply and stops if more staff would
// be affected than the owner approved. The numbers can be compared only if
// both come from the same text, so 0136 carries the counts file's block
// do $count_0136$ ... $count_0136$; character for character.
// Both paths are built from __dirname and literals only, so the production
// selector's test scan (scripts/production-backend-build.test.mjs) sees the
// one file read from outside ehr-api; outsideTestInputs maps it to ehr-api.
const migration = readFileSync(
  join(__dirname, '../../database/migrations/0136_role_permission_changes.sql'), 'utf8');
const countsFile = readFileSync(join(__dirname, '../../../../docs/rollback/0136_affected_staff_counts.sql'), 'utf8');

function countBlock(text: string): string[] {
  return [...text.matchAll(/^do \$count_0136\$\n[\s\S]*?^\$count_0136\$;$/gm)].map((match) => match[0]);
}

describe('0136 counts (Q113 A)', () => {
  it('the migration carries the counts file\'s count block exactly, once each', () => {
    const fromFile = countBlock(countsFile);
    const fromMigration = countBlock(migration);
    expect(fromFile).toHaveLength(1);
    expect(fromMigration).toHaveLength(1);
    expect(fromMigration[0]).toBe(fromFile[0]);
  });

  it('the counts file only reads: a read-only session first, no write statement anywhere', () => {
    const code = countsFile.split('\n').filter((line) => !/^\s*(--|\\echo)/.test(line) && line.trim() !== '');
    expect(code[0]).toBe('set session characteristics as transaction read only;');
    const text = code.join('\n');
    expect(text).not.toMatch(/\b(insert into|update [a-z_]+\.[a-z_]+ set|delete from|create |alter |drop |grant |revoke |truncate )/i);
  });

  it('the migration lists the owner\'s maximums for lines 1 to 24 once each, numbers or "null"', () => {
    const section = /from \(values\n {6}-- line, at real facilities, staff logins at real facilities\n([\s\S]*?)\n {4}\) maximum\(line, real_count, logins\)/
      .exec(migration);
    expect(section).not.toBeNull();
    const rows = section![1]!.split('\n');
    expect(rows).toHaveLength(24);
    rows.forEach((row, index) => {
      const line = index + 1;
      // As the counts file's table 2 prints it (spacing may differ when pasted).
      const shape = new RegExp(`^\\s*\\(\\s*${line},\\s*(null|\\d+),\\s*(null|\\d+)\\)${line === 24 ? '' : ','}$`);
      expect(row).toMatch(shape);
    });
  });

  it('the stop runs after the count and before the change', () => {
    const at = (pattern: RegExp) => pattern.exec(migration)?.index ?? -1;
    const count = at(/^do \$count_0136\$$/m);
    const stop = at(/^do \$owner_maximums\$$/m);
    const change = at(/^insert into auth\.permissions/m);
    expect(count).toBeGreaterThan(at(/^select set_config\('zero136\.owner_maximums'/m));
    expect(at(/^select set_config\('zero136\.owner_maximums'/m)).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(count);
    expect(change).toBeGreaterThan(stop);
    expect(at(/^delete from auth\.role_permissions/m)).toBeGreaterThan(stop);
    expect(at(/^insert into auth\.role_permissions/m)).toBeGreaterThan(stop);
  });
});
