import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  analyseLocks, databaseModel, databaseScripts, effectiveRoles, inspectServices, lockingStatements,
  lockPermission, scanLiterals, unfollowedForms,
} from '../verify-runtime-locking-privileges.mjs';

const repository = resolve(import.meta.dirname, '../..');
const realScripts = () => databaseScripts().map((path) => [relative(repository, path), readFileSync(path, 'utf8')]);
const realModel = databaseModel(realScripts());

test('scans string and template literals outside comments and regular expressions', () => {
  const source = [
    "// select * from a.b for update",
    "/* 'unterminated in a comment */",
    "const pattern = /['`]/g;",
    "const ratio = total / count / 2;",
    "const sql = `select ${columns(`x`)} from a.b where id = $1${lock ? ' for update' : ''}`;",
  ].join('\n');
  const literals = scanLiterals(source);
  assert.deepEqual(literals.map((literal) => literal.kind), ['template', 'template', 'string', 'string']);
  assert.deepEqual(literals[0].expressions, ['columns(`x`)', "lock ? ' for update' : ''"]);
  assert.throws(() => scanLiterals('const sql = `select'), /Unterminated template literal/);
});

test('expands constants and conditional lock fragments into every variant', () => {
  const source = `
    const SELECT_JOB = \`select * from ocr.jobs\`;
    const PROJECTION = 'id, status';
    async function find(lock = false) {
      return query(\`\${SELECT_JOB} where id = $1\${lock ? ' for update' : ''}\`);
    }
    async function read() { return query(\`select \${PROJECTION} from lab.results where id=$1 for update\`); }
    async function other(operation) {
      const table = operation === 'verify' ? 'lab.result_verifications' : 'lab.result_releases';
      return query(\`select 1 from \${table} where id = $1 for share\`);
    }`;
  const statements = lockingStatements(source);
  assert.deepEqual(statements.map((statement) => statement.sql), [
    'select * from ocr.jobs where id = $1 for update',
    'select id, status from lab.results where id=$1 for update',
    'select 1 from lab.result_verifications where id = $1 for share',
    'select 1 from lab.result_releases where id = $1 for share',
  ]);
  assert.equal(statements[0].line, 5);
});

test('reports lock text it cannot place in a statement instead of skipping it', () => {
  const statements = lockingStatements(`
    function lockClause() { return 'for update'; }
    const message = 'Reload the record before you update it';
    query(\`select * from a.b where id = $1 \${lockClause()}\`);`);
  assert.deepEqual(statements, [{ line: 2, sql: 'for update', unassembled: true,
    reason: 'lock text that is not part of a statement this check can assemble' }]);
});

// Each shape below reintroduces a Stage 8 lock in a file that also has a
// valid lock, so the lock text appears in a statement elsewhere in the file;
// the check must still report it (Phase 4 Stage 9 review).
test('reports lock text a statement elsewhere in the file also contains', () => {
  const valid = 'const job = () => query(`select id from ocr.jobs where id=$1 for update`);';
  const unplaced = (code) => lockingStatements(`${valid}\n${code}`).filter((statement) => statement.unassembled)
    .map((statement) => statement.sql);
  // A lock clause passed as an argument.
  assert.deepEqual(unplaced(`function find(id, lockClause = '') { return query(\`select * from ocr.validations where id=$1 \${lockClause}\`); }
    find(id, 'for update');`), ['for update']);
  // Concatenation.
  assert.deepEqual(unplaced("query('select * from lab.accessions where id=$1' + ' for update');"), ['for update']);
  // A map lookup, and a class field.
  assert.deepEqual(unplaced("const LOCKS = { strong: ' for update' }; query(`select * from lab.accessions where id=$1${LOCKS[mode]}`);"),
    ['for update']);
  assert.deepEqual(unplaced("class A { private lock = ' for update'; f() { return query(`select * from lab.accessions${this.lock}`); } }"),
    ['for update']);
  // A constant used as a whole interpolation of a locking statement is placed;
  // the same constant also concatenated elsewhere is not.
  const fragment = "const LOCK = ' for update';\nquery(`select id from lab.specimens where id=$1${LOCK}`);";
  assert.deepEqual(unplaced(fragment), []);
  assert.deepEqual(unplaced(`${fragment}\nquery('select id from lab.accessions where id=$1' + LOCK);`), ['for update']);
});

test('resolves or reports an interpolated lock strength', () => {
  const typed = lockingStatements(`const strength: 'update' | 'share' = 'update';
    query(\`select * from pharmacy.dispensing_reversals where dispensing_id=$1 for \${strength}\`);`);
  assert.deepEqual(typed.map((statement) => statement.sql), ['select * from pharmacy.dispensing_reversals where dispensing_id=$1 for update']);
  assert.match(lockPermission(realModel, 'hid_pharmacy_api_runtime', 'pharmacy.dispensing_reversals').reason, /no UPDATE privilege/);
  const parameter = lockingStatements(`function find(lock?: 'update' | 'share') {
    return query(\`select * from pharmacy.dispensing_reversals where id=$1\${lock ? \` for \${lock}\` : ''}\`); }`);
  assert.deepEqual(parameter.map(({ sql, unassembled }) => [sql, Boolean(unassembled)]), [['for «»', true]]);
  // A keyword assembled from parts is not taken for its first part.
  const assembled = lockingStatements(`const lock = 'FOR' + ' UPDATE';
    query(\`select * from pharmacy.dispensings where id=$1 \${lock}\`);`);
  assert.deepEqual(assembled.map(({ sql, unassembled }) => [sql, unassembled]), [['FOR', true]]);
  const direct = lockingStatements('function find(strength) { return query(`select * from lab.accessions where id=$1 for ${strength}`); }');
  assert.deepEqual(direct.map(({ unassembled, reason }) => [unassembled, reason]),
    [[true, 'the lock strength is an interpolation this check cannot resolve']]);
});

test('does not resolve a name that is also a parameter, a reassigned variable or a non-literal declaration', () => {
  const tables = (source) => lockingStatements(source).flatMap((statement) => analyseLocks(statement.sql))
    .map((clause) => [clause.tables, clause.defects]);
  const shadowing = `function pick(operation) { const table = operation === 'verify' ? 'lab.result_verifications' : 'lab.result_releases'; return table; }
    function lockRow(table, id) { return query(\`select 1 from \${table} where id=$1 for update\`); }`;
  assert.deepEqual(tables(shadowing), [[[], ['locks a FROM item that is not a schema-qualified table: «table»']]]);
  assert.deepEqual(tables(`let table = 'lab.specimens'; table = other;
    query(\`select 1 from \${table} where id=$1 for update\`);`), [[[], ['locks a FROM item that is not a schema-qualified table: «table»']]]);
  assert.deepEqual(tables(`const table = 'lab.specimens'; function f() { const table = choose(); return query(\`select 1 from \${table} for update\`); }`),
    [[[], ['locks a FROM item that is not a schema-qualified table: «table»']]]);
});

test('reads lock text as the JavaScript string and SQL it becomes (Phase 4 Stage 9 final review)', () => {
  const tables = (source) => lockingStatements(source).flatMap((statement) => statement.unassembled ? [['unassembled', statement.sql]]
    : analyseLocks(statement.sql).map((clause) => [clause.tables, clause.defects]));
  // Escape sequences: the runtime SQL is '...$4<newline>for update'.
  assert.deepEqual(tables("query('select * from pharmacy.dispensing_reversals\\nwhere dispensing_id=$4\\nfor update');"),
    [[['pharmacy.dispensing_reversals'], []]]);
  assert.deepEqual(tables("query(`select * from lab.accessions where id=$1 for\\u0020update`);"), [[['lab.accessions'], []]]);
  // A comment between FOR and the strength is whitespace to PostgreSQL.
  assert.deepEqual(tables('query(`select * from ocr.validations where id=$1 for /* replay */ update`);'), [[['ocr.validations'], []]]);
  assert.deepEqual(tables('query(`select * from ocr.validations where id=$1 for -- serialize\nupdate`);'), [[['ocr.validations'], []]]);
  // `--` inside a SQL string is not a comment.
  assert.deepEqual(tables("query(`select * from pharmacy.dispensing_reversals where coalesce(reason, '--') <> '' for update`);"),
    [[['pharmacy.dispensing_reversals'], []]]);
  // Lock text only inside a SQL string is not a lock.
  assert.deepEqual(tables("query(`select id from lab.results where note = 'for update'`);"), []);
});

test('does not place an exported lock constant, a lock in a ternary condition, or an interpolation after OF', () => {
  const unplaced = (source) => lockingStatements(source).filter((statement) => statement.unassembled).map((statement) => statement.sql);
  assert.deepEqual(unplaced(`export const ROW_LOCK = ' for update';
    query(\`select id from lab.specimens where id=$1\${ROW_LOCK}\`);`), ['for update']);
  assert.deepEqual(unplaced(`const ROW_LOCK = ' for update';
    query(\`select id from lab.specimens where id=$1\${ROW_LOCK}\`);
    export { ROW_LOCK };`), ['for update']);
  assert.deepEqual(unplaced(`let clause = '';
    query(\`select id from lab.specimens where id=$1\${(clause = ' for update') ? ' for update' : ''}\`);
    query('select * from lab.accessions where id=$1' + clause);`), ['for update']);
  const [statement] = lockingStatements('function f(extra) { return query(`select * from lab.specimens s join lab.accessions a on true where s.id=$1 for update of s${extra}`); }');
  assert.deepEqual(analyseLocks(statement.sql).flatMap((clause) => clause.defects),
    ['FOR UPDATE is followed by an interpolation this check cannot resolve']);
});

test('does not resolve a name that is also destructured, a loop variable or assigned by destructuring', () => {
  const defects = (source) => lockingStatements(source).flatMap((statement) => analyseLocks(statement.sql)).flatMap((clause) => clause.defects);
  const refused = ['locks a FROM item that is not a schema-qualified table: «table»'];
  assert.deepEqual(defects(`const table = 'lab.specimens';
    async function lockRow(client, { table, id }) { return client.query(\`select id from \${table} where id=$1 for update\`, [id]); }`), refused);
  assert.deepEqual(defects(`const table = 'lab.specimens';
    for (const [, table] of Object.entries(targets)) query(\`select id from \${table} where id=$1 for update\`);`), refused);
  assert.deepEqual(defects(`let table = 'lab.specimens'; [table] = ['lab.accessions'];
    query(\`select id from \${table} where id=$1 for update\`);`), refused);
});

test('reports a statement with more variants than it expands', () => {
  const filters = Array.from({ length: 6 }, (_, index) => `\${f${index} ? ' and c${index}=$2' : ''}`).join('');
  const [statement] = lockingStatements(`const table = kind ? 'lab.results' : 'lab.accessions';
    query(\`select * from \${table} where id=$1${filters} for update\`);`);
  assert.deepEqual([statement.unassembled, statement.reason], [true, 'more than 64 variants']);
});

test('resolves the tables each lock clause locks', () => {
  const tables = (sql) => analyseLocks(sql).map((clause) => ({ tables: clause.tables, defects: clause.defects }));
  assert.deepEqual(tables('select * from lab.specimens s join lab.accessions a on a.id = s.accession_id where s.id = $1 for update of s'),
    [{ tables: ['lab.specimens'], defects: [] }]);
  assert.deepEqual(tables('select * from ocr.validations validation join ocr.jobs job on job.id = validation.job_id for update'),
    [{ tables: ['ocr.validations', 'ocr.jobs'], defects: [] }]);
  assert.deepEqual(tables('select c.status from outreach.campaigns c, outreach.campaign_members m where m.campaign_id = c.id for share of c,m'),
    [{ tables: ['outreach.campaigns', 'outreach.campaign_members'], defects: [] }]);
  // A correlated sub-select in the select list is not locked; a lock inside a
  // sub-select applies to its own FROM list.
  assert.deepEqual(tables(`select r.id, (select count(*) from identity.registration_case_candidates c where c.case_id = r.id)
    from identity.registration_cases r where r.id = $1 for update`), [{ tables: ['identity.registration_cases'], defects: [] }]);
  assert.deepEqual(tables('select * from a.b where id in (select id from c.d for key share)'),
    [{ tables: ['c.d'], defects: [] }]);
  assert.deepEqual(tables("select id from a.b where note = 'for update' and x is distinct from y"), []);
});

test('reports locks PostgreSQL refuses for every role', () => {
  const defects = (sql) => analyseLocks(sql).flatMap((clause) => clause.defects);
  assert.deepEqual(defects('select * from identity.registration_cases registration left join identity.patients patient on patient.id = registration.resolved_patient_id for update'),
    ['FOR UPDATE without OF over an outer join locks its nullable side']);
  assert.deepEqual(defects('select * from identity.registration_cases registration left join identity.patients patient on true for update of registration'), []);
  assert.deepEqual(defects('select * from a.b x left join a.c y on true for update of y'),
    ['FOR UPDATE OF y locks the nullable side of an outer join']);
  assert.deepEqual(defects('select * from a.b x right join a.c y on true for update of x'),
    ['FOR UPDATE OF x locks the nullable side of an outer join']);
  assert.deepEqual(defects('select * from a.b x for update of z'), ['FOR UPDATE OF z names no FROM item']);
  assert.deepEqual(defects('select * from a.b x join (select 1) y on true for update'),
    ['locks a FROM item that is not a schema-qualified table: (select 1) y']);
  assert.deepEqual(defects('select * from «table» x for update'), ['locks a FROM item that is not a schema-qualified table: «table» x']);
  // An interpolation the scanner cannot resolve never passes as a table.
  const [unresolved] = lockingStatements('query(`select * from ${tableFor(kind)} where id=$1 for update`)');
  assert.deepEqual(analyseLocks(unresolved.sql).flatMap((clause) => clause.defects),
    ['locks a FROM item that is not a schema-qualified table: «tableFor_kind_»']);
});

test('reports the other lock forms PostgreSQL refuses for every role (0A000)', () => {
  const defects = (sql) => analyseLocks(sql).flatMap((clause) => clause.defects);
  assert.deepEqual(defects('select count(*) from lab.results where id=$1 for update'), ['FOR UPDATE is not allowed with aggregate functions']);
  assert.deepEqual(defects('select distinct id from lab.results for update'), ['FOR UPDATE is not allowed with DISTINCT']);
  assert.deepEqual(defects('select status from lab.results group by status having true for share'),
    ['FOR SHARE is not allowed with GROUP BY', 'FOR SHARE is not allowed with HAVING']);
  assert.deepEqual(defects('select id, rank() over (order by id) from lab.results for update'), ['FOR UPDATE is not allowed with window functions']);
  assert.deepEqual(defects('select id from lab.results union select id from lab.specimens for update'),
    ['FOR UPDATE is not allowed with UNION, INTERSECT or EXCEPT']);
  // Sub-selects, and IS DISTINCT FROM, are not the locked level.
  assert.deepEqual(defects('select r.id, (select count(*) from lab.specimens s) from lab.results r where r.x is distinct from $1 for update of r'), []);
  assert.deepEqual(defects('select id from lab.results where id in (select id from lab.specimens union select id from lab.accessions) for update'), []);
  assert.deepEqual(defects('(select id from lab.results for update) union select id from lab.specimens'),
    ['FOR UPDATE is not allowed with UNION, INTERSECT or EXCEPT']);
  assert.deepEqual(defects('select id from lab.specimens union (select id from lab.results for update)'),
    ['FOR UPDATE is not allowed with UNION, INTERSECT or EXCEPT']);
  assert.deepEqual(defects('select id, generate_series(1, 2) from lab.results for update'),
    ['FOR UPDATE is not allowed with set-returning functions in the target list']);
  assert.deepEqual(defects('select 1 from lab.results order by count(*) for update'), ['FOR UPDATE is not allowed with aggregate functions']);
  // Identifiers that start with "over" are not window functions.
  assert.deepEqual(defects('select id, over_limit from lab.results where overdue for update'), []);
});

test('follows only memberships that pass on privileges', () => {
  const model = databaseModel([['fixture.sql', `
    create table s.t (id uuid);
    grant update on s.t to group_role;
    do $$ begin create role sealed nologin noinherit; end $$;
    alter role sealed noinherit;
    grant group_role to sealed;
    grant group_role to explicit with inherit false;
    grant group_role to revoked;
    revoke inherit option for group_role from revoked;
    grant group_role to open_role;
  `]]);
  for (const role of ['sealed', 'explicit', 'revoked']) {
    assert.match(lockPermission(model, role, 's.t').reason, /no UPDATE privilege/, role);
  }
  assert.deepEqual(lockPermission(model, 'open_role', 's.t'), { allowed: true });
  // The INHERIT attribute counts as it is when the grant is made, and
  // CREATE ROLE ... IN ROLE is a membership.
  const ordered = databaseModel([['fixture.sql', `
    create table s.t (id uuid);
    grant update on s.t to g;
    create role later_inherit nologin noinherit;
    grant g to later_inherit;
    alter role later_inherit inherit;
    create role later_noinherit nologin inherit;
    grant g to later_noinherit;
    alter role later_noinherit noinherit;
    do $$ begin create role created_in nologin in role g; end $$;
  `]]);
  assert.match(lockPermission(ordered, 'later_inherit', 's.t').reason, /no UPDATE privilege/);
  assert.deepEqual(lockPermission(ordered, 'later_noinherit', 's.t'), { allowed: true });
  assert.deepEqual(lockPermission(ordered, 'created_in', 's.t'), { allowed: true });
  assert.deepEqual(unfollowedForms([['a.sql', 'create role r nologin role other_role;']]), ['a.sql: CREATE ROLE ... ROLE, ADMIN or USER']);
});

test('replays table privileges, role membership, row-level security and policies', () => {
  const model = databaseModel([['fixture.sql', `
    create table s.locked (id uuid);
    create table s.column_only (id uuid, status text);
    create table s.no_policy (id uuid);
    create table s.plain (id uuid);
    alter table s.locked enable row level security;
    alter table s.column_only enable row level security;
    alter table s.no_policy enable row level security;
    create policy locked_update on s.locked for update to group_role using (true);
    create policy column_all on s.column_only to public using (true);
    create policy no_policy_select on s.no_policy for select to group_role using (true);
    create policy no_policy_restrictive on s.no_policy as restrictive for update to group_role using (true);
    grant group_role to login_role;
    grant select, insert, update on s.locked, s.no_policy to group_role;
    grant update (status) on s.column_only to group_role;
    grant all on all tables in schema s to other_role;
    revoke update on s.plain from other_role;
    grant select on s.plain to group_role;
  `]]);
  assert.deepEqual([...effectiveRoles(model, 'login_role')].sort(), ['group_role', 'login_role', 'public']);
  assert.deepEqual(lockPermission(model, 'login_role', 's.locked'), { allowed: true });
  assert.deepEqual(lockPermission(model, 'login_role', 's.column_only'), { allowed: true });
  assert.match(lockPermission(model, 'login_role', 's.no_policy').reason, /no UPDATE policy/);
  assert.match(lockPermission(model, 'login_role', 's.plain').reason, /no UPDATE privilege/);
  assert.match(lockPermission(model, 'other_role', 's.plain').reason, /no UPDATE privilege/);
  assert.deepEqual(lockPermission(model, 'other_role', 's.locked'), { allowed: false,
    reason: 's.locked has row-level security and no UPDATE policy for other_role, so the lock returns no rows' });
  assert.match(lockPermission(model, 'login_role', 's.missing').reason, /not a table/);
  const revoked = databaseModel([['fixture.sql', `create table s.t (id uuid);
    grant update (id) on s.t to r; revoke all privileges on all tables in schema s from r;`]]);
  assert.match(lockPermission(revoked, 'r', 's.t').reason, /no UPDATE privilege/);
});

test('refuses database statements the replay does not follow', () => {
  assert.deepEqual(unfollowedForms([['a.sql', `do $$ begin execute 'grant update on s.t to r'; end $$;
    alter policy p on s.t to r; create policy q on s.t using (true);`]]),
  ['a.sql: table GRANT or REVOKE in a dollar-quoted body', 'a.sql: ALTER POLICY']);
  assert.deepEqual(unfollowedForms(realScripts()), []);
});

// The fourteen lock clauses Stage 8 reproduced as failures (release checklist
// section 4.2), exactly as main 54f79d2 ran them. Each must be refused.
const STAGE_8_FAILURES = [
  ['hid_pharmacy_api_runtime', `select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
    r.id::text as reversal_id from pharmacy.work_items w left join pharmacy.dispensings d on d.work_item_id=w.id
    left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
    where (w.facility_id=$1 and w.accepted_by=$2 and w.idempotency_key=$3) or w.source_ehr_prescription_id=$4 for update of w`,
  /no UPDATE privilege on pharmacy\.work_items/],
  ['hid_pharmacy_api_runtime', `select w.*,d.id::text as dispensing_id from pharmacy.work_items w
    left join pharmacy.dispensings d on d.work_item_id=w.id left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
    where w.id=$1 for update of w`, /no UPDATE privilege on pharmacy\.work_items/],
  ['hid_pharmacy_api_runtime', `select d.*,r.id::text as reversal_id,r.reversed_at from pharmacy.dispensings d
    left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id
    where (d.facility_id=$1 and d.dispensed_by=$2 and d.idempotency_key=$3) or d.work_item_id=$4 for update of d`,
  /no UPDATE privilege on pharmacy\.dispensings/],
  ['hid_pharmacy_api_runtime', `select d.*,r.id::text as reversal_id,r.reversed_at from pharmacy.dispensings d
    left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id where d.id=$1 for update of d`,
  /no UPDATE privilege on pharmacy\.dispensings/],
  ['hid_pharmacy_api_runtime', `select * from pharmacy.dispensing_reversals
    where (facility_id=$1 and reversed_by=$2 and idempotency_key=$3) or dispensing_id=$4 for update`,
  /no UPDATE privilege on pharmacy\.dispensing_reversals/],
  ['hid_pharmacy_api_runtime', `select * from pharmacy.imported_medication_evidence
    where (facility_id=$1 and created_by=$2 and idempotency_key=$3) or publication_id=$4 for update`,
  /no UPDATE privilege on pharmacy\.imported_medication_evidence/],
  ['hid_lab_api_runtime', `select id::text,request_sha256 from lab.imported_evidence
    where (facility_id=$1 and created_by=$2 and idempotency_key=$3) or ($4::uuid is not null and publication_id=$4) for update`,
  /no UPDATE privilege on lab\.imported_evidence/],
  ['hid_lab_api_runtime', `select id::text,request_sha256 from lab.work_items where (facility_id=$1 and accepted_by=$2 and idempotency_key=$3)
    or (source_ehr_order_id=$4 and source_ehr_order_version=$5) for update`, /no UPDATE privilege on lab\.work_items/],
  ['hid_lab_api_runtime', `select id::text,request_sha256 from lab.accessions
    where work_item_id=$1 or (facility_id=$2 and created_by=$3 and idempotency_key=$4) for update`,
  /no UPDATE privilege on lab\.accessions/],
  ['hid_ocr_api_runtime', `select validation.*, job.document_id::text, job.patient_id::text, job.status as job_status
    from ocr.validations validation join ocr.jobs job on job.id = validation.job_id
    where validation.facility_id = $1 and validation.validated_by = $2 and validation.idempotency_key = $3 for update`,
  /no UPDATE privilege on ocr\.validations/],
  ['hid_ocr_api_runtime', `select id::text, job_id::text from ocr.patient_confirmations where facility_id = $1 and confirmed_by = $2
    and idempotency_key = $3 for update`, /no UPDATE privilege on ocr\.patient_confirmations/],
  ['hid_ocr_api_runtime', `select validation.* from ocr.validations validation join ocr.jobs job on job.id=validation.job_id
    where validation.id=$1 for update of validation`, /no UPDATE privilege on ocr\.validations/],
  ['hid_outreach_api_runtime', `select campaign.status,campaign.services,campaign.starts_at,campaign.ends_at from outreach.campaigns campaign
    join outreach.campaign_members member on member.campaign_id=campaign.id and member.facility_id=campaign.facility_id and member.membership_id=$3
    where campaign.id=$1 and campaign.facility_id=$2 for share of campaign,member`,
  /no UPDATE privilege on outreach\.campaign_members/],
  ['hid_identity_api_runtime', `select registration.id::text, patient.hid_code as resolved_hid_code,
    (select count(*)::text from identity.registration_case_candidates candidate where candidate.case_id = registration.id) as candidate_count
    from identity.registration_cases registration left join identity.patients patient on patient.id = registration.resolved_patient_id
    where registration.id = $1 and registration.facility_id = platform.current_facility_id() for update`,
  /outer join locks its nullable side/],
];

test('refuses every lock clause that failed as its runtime role on main', () => {
  for (const [role, sql, expected] of STAGE_8_FAILURES) {
    const reasons = analyseLocks(sql).flatMap((clause) => [...clause.defects,
      ...clause.tables.map((table) => lockPermission(realModel, role, table)).filter((result) => !result.allowed)
        .map((result) => result.reason)]);
    assert.ok(reasons.some((reason) => expected.test(reason)), `${role}: ${sql}\n${reasons.join('\n')}`);
  }
});

test('accepts the locks each runtime role can take on the tables it updates', () => {
  for (const [role, table] of [['hid_lab_api_runtime', 'lab.specimens'], ['hid_lab_api_runtime', 'lab.results'],
    ['hid_ocr_api_runtime', 'ocr.jobs'], ['hid_ocr_api_runtime', 'ocr.publications'],
    ['hid_outreach_api_runtime', 'outreach.campaigns'], ['hid_outreach_api_runtime', 'outreach.registration_cases'],
    ['hid_identity_api_runtime', 'identity.registration_cases']]) {
    assert.deepEqual(lockPermission(realModel, role, table), { allowed: true }, `${role} on ${table}`);
  }
});

test('every row lock in the services is one its runtime role can take', () => {
  const results = inspectServices(realModel, join(repository, 'services'));
  assert.ok(results.length >= 25, `found only ${results.length} lock clauses`);
  assert.deepEqual(results.filter((result) => result.violations.length > 0)
    .map(({ location, violations }) => `${location}: ${violations.join('; ')}`), []);
});
