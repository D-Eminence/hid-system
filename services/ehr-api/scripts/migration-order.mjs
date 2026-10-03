// Migration identity is the entire filename. Prefix collisions with retained
// staging migrations do not authorize renaming or changing applied files.
export function orderMigrations(migrations) {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  if (byVersion.size !== migrations.length) throw new Error('Duplicate migration filename');
  const prerequisites = new Map([
    ['0038_outreach_campaign_workspaces.sql', ['0042_outreach_campaign_membership_key.sql']],
  ]);
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(version) {
    if (visited.has(version)) return;
    if (visiting.has(version)) throw new Error(`Migration prerequisite cycle at ${version}`);
    const migration = byVersion.get(version);
    if (!migration) throw new Error(`Missing migration prerequisite ${version}`);
    visiting.add(version);
    for (const prerequisite of prerequisites.get(version) ?? []) visit(prerequisite);
    visiting.delete(version);
    visited.add(version);
    ordered.push(migration);
  }
  for (const migration of migrations) visit(migration.version);
  return ordered;
}
