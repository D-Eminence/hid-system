// ORD-7: the governed loader's checks and its one transaction. The command
// is load-catalog.mjs, which passes in a connected pg client; this module
// imports no driver, so scripts/tests/catalog-seeds.test.mjs drives it with a
// stand-in client.
//
// A refusal (LoadRefusal) leaves nothing written and ends the command with
// exit 2, as against a failure (exit 1). Its one line ends "nothing loaded";
// a busy table also asks for a quieter time, worded as the migrations' own
// busy refusals are. 0149's own refusals in the transaction (its triggers and
// the version guard: SQLSTATE 55000, such as CATALOG_ID_CHANGED; a table
// check: 23514) are refusals too, with the database's message. A connection
// lost once the load's COMMIT is sent (CommitOutcomeUnknown) is neither: the
// version may have committed, so the command ends with its own exit code
// (COMMIT_UNKNOWN_EXIT, 3) and a line (COMMIT_UNKNOWN_LINE) that says so and
// asks for the same load again, which settles it.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { approvalFor, heldBackAndRetired, heldBackRetiredProblem, seedProblems, sha256 } from './catalog-seed.mjs';

export class LoadRefusal extends Error {
  constructor(message, { busy = false } = {}) {
    super(message);
    this.name = 'LoadRefusal';
    this.busy = busy;
  }
}

/** The line a refusal prints (stderr). */
export function refusalLine(refusal) {
  return `load-catalog: ${refusal.message}; nothing loaded${refusal.busy ? '; run the release again at a quieter time' : ''}`;
}

/** The busy refusal: this loader's lock or the versions table stayed held for the loader's 5 seconds (55P03). */
export const BUSY = 'ehr.catalog_versions or another catalogue load stayed busy for 5 seconds';

/**
 * The load's COMMIT was sent and no reply to it came: the connection was
 * lost (a terminated backend, a failover), or a fatal error came in its
 * place. The server may have committed the version before the connection
 * went (a backend terminated while its commit waits for a synchronous
 * standby has already committed locally), so "nothing loaded" would not be
 * true. The command ends with COMMIT_UNKNOWN_LINE, exit 3. An ERROR reply to
 * COMMIT is a reply: the transaction rolled back, and that stays a refusal
 * or a failure with "nothing loaded".
 */
export class CommitOutcomeUnknown extends Error {
  constructor(cause) {
    super('the connection was lost during commit', { cause });
    this.name = 'CommitOutcomeUnknown';
  }
}

/**
 * The exit code of a commit with no reply: its own, so the deploy tool reads the outcome as unknown from the code
 * alone, without the log (exit 1 is a failure with nothing loaded, exit 2 a refusal).
 */
export const COMMIT_UNKNOWN_EXIT = 3;

/** The line a commit with no reply prints (stderr), which the deploy tool shows. */
export const COMMIT_UNKNOWN_LINE = 'load-catalog: the connection was lost during commit, so the load may have committed; '
  + 'ask for the same load again to settle it (it loads, or is refused as already loaded)';

/**
 * The SQLSTATEs with which 0149 refuses a row or a change in the load's
 * transaction: 55000 from its insert triggers (CATALOG_VERSION_SEALED,
 * CATALOG_ID_RETIRED, CATALOG_ID_CHANGED) and the versions guard, and 23514
 * from a table check. The transaction rolls back, so nothing is loaded.
 */
export const DATABASE_REFUSALS = ['55000', '23514'];

function readJson(file, what) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new LoadRefusal(`${what} ${file} cannot be read (${error?.code ?? 'unreadable'})`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new LoadRefusal(`${what} ${file} is not JSON`);
  }
}

/**
 * Everything the loader checks before it connects. Throws a LoadRefusal for:
 * - --approvals under NODE_ENV=production (only the deployed
 *   docs/codes/catalog-approvals.json may sign a load);
 * - a seed, approvals or Wave 0 codes file that cannot be read or is not JSON;
 * - a seed that breaks 0149's rules or Wave 0's, or holds back an id it also
 *   retires (seedProblems);
 * - a file whose sha256 is not signed for its kind and version, or whose
 *   sign-off lacks a licence answer it needs (approvalFor).
 * Returns the seed, its sha256, the sign-off entry and the approvals file's
 * own sha256, which the version records (approvals_sha256).
 */
export function prepareLoad({ seedPath, approvalsPath, approvalsGiven = false, waveZeroPath, environment = process.env }) {
  if (approvalsGiven && environment.NODE_ENV === 'production') {
    throw new LoadRefusal('--approvals is not allowed in production: only the deployed docs/codes/catalog-approvals.json signs a load');
  }
  const { bytes, value: seed } = readJson(seedPath, 'the seed file');
  const fileSha256 = sha256(bytes);
  const waveZero = seed?.kind === 'lab_test' ? readJson(waveZeroPath, 'the Wave 0 codes file').value?.codes : undefined;
  const problems = seedProblems(seed, { waveZero });
  if (problems.length > 0) {
    throw new LoadRefusal(`${seedPath}: ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? ' …' : ''}`);
  }
  const { bytes: approvalsBytes, value: approvals } = readJson(approvalsPath, 'the approvals file');
  const approval = approvalFor(approvals, { kind: seed.kind, version: seed.version, fileSha256,
    holdsAtc: seed.kind === 'medicine' && seed.items.some((item) => item.atcCode !== null) });
  if (approval.problem) throw new LoadRefusal(approval.problem);
  return { seed, fileSha256, approval: approval.entry, approvalsSha256: sha256(approvalsBytes) };
}

const MEDICINES_INSERT = `insert into ehr.catalog_medicines (version_id, list_id, generic_name, other_names, strength,
    dose_form, dose_form_text, routes, atc_code, common_adult_dose, source, source_section, source_list, withdrawn)
  select $1, item."listId", item."genericName", array_to_string(array(select jsonb_array_elements_text(item."otherNames")), '; '),
         item.strength, item."doseForm", item."doseFormText", array(select jsonb_array_elements_text(item.routes)),
         item."atcCode", item."commonAdultDose", item.source, item."sourceSection", item."sourceList", item.withdrawn
    from jsonb_to_recordset($2::jsonb) as item("listId" text, "genericName" text, "otherNames" jsonb, strength text,
      "doseForm" text, "doseFormText" text, routes jsonb, "atcCode" text, "commonAdultDose" text, source text,
      "sourceSection" text, "sourceList" text, withdrawn boolean)`;
const LAB_TESTS_INSERT = `insert into ehr.catalog_lab_tests (version_id, list_id, code_system, code, display,
    other_names, specimen, category, source, withdrawn)
  select $1, item."listId", item."codeSystem", item.code, item.display,
         array_to_string(array(select jsonb_array_elements_text(item."otherNames")), '; '), item.specimen, item.category,
         item.source, item.withdrawn
    from jsonb_to_recordset($2::jsonb) as item("listId" text, "codeSystem" text, code text, display text,
      "otherNames" jsonb, specimen text, category text, source text, withdrawn boolean)`;
const INSERTS = { medicine: MEDICINES_INSERT, lab_test: LAB_TESTS_INSERT };
/**
 * The active version's ids that a seed drops (Rahman's review of #319,
 * point 4): those it holds back (a row that would not load: the row needs
 * fixing, not retiring) and those it neither holds nor retires.
 */
export function droppedIds(seed, activeIds) {
  const kept = new Set([...seed.items, ...seed.retired].map((entry) => entry.listId));
  const heldBack = new Set((seed.heldBack ?? []).map((entry) => entry.listId));
  const dropped = activeIds.filter((id) => !kept.has(id));
  return { heldBack: dropped.filter((id) => heldBack.has(id)), notRetired: dropped.filter((id) => !heldBack.has(id)) };
}

const some = (ids) => `${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ' …' : ''}`;

/** The refusal's words for dropped ids: a held-back one is fixed, never retired; any other is retired with a reason. */
function droppedLine(seed, active, { heldBack, notRetired }) {
  const parts = [];
  if (heldBack.length === 1) {
    parts.push(`${heldBack[0]} is in the live list but held back in this seed; fix the row, do not retire it`);
  } else if (heldBack.length > 1) {
    parts.push(`${some(heldBack)} are in the live list but held back in this seed; fix the rows, do not retire them`);
  }
  if (notRetired.length > 0) {
    parts.push(`the active ${seed.kind} ${active.version} holds ${notRetired.length === 1 ? 'an id' : `${notRetired.length} ids`} `
      + `this seed drops without retiring: ${some(notRetired)}; list each in the seed's retired ids with a reason`);
  }
  return parts.join('; ');
}

// The active version's ids, to find those the new seed drops.
const activeIds = (table) => `select versions.version,
    array(select rows.list_id from ${table} rows where rows.version_id = versions.id order by rows.list_id) as ids
  from ehr.catalog_versions versions where versions.kind = $1 and versions.active`;
const ACTIVE_IDS = { medicine: activeIds('ehr.catalog_medicines'), lab_test: activeIds('ehr.catalog_lab_tests') };

/**
 * The load, in one transaction. First, before any statement, a seed that
 * holds back an id it also retires is refused (a row to fix, never to
 * retire; seedProblems refuses it before the loader connects, too). Then
 * this loader's advisory lock; SHARE ROW
 * EXCLUSIVE on ehr.catalog_versions (two loaders cannot both switch, while
 * searches go on reading); the refusals that need the database (no 0149, a
 * version already loaded, an id of the active version that the seed drops:
 * held back, or not retired); the new retired ids; the version row (inactive, with
 * the approvals file's sha256); its rows; then the old active version off
 * and the new one on. A lock still held after 5 seconds (55P03) is the busy
 * refusal, and 0149's own refusals (DATABASE_REFUSALS) are refusals with the
 * database's message. dryRun does all of it and rolls back. Once COMMIT is
 * sent, a failure with no ERROR reply from the server (the connection lost,
 * or a fatal error in the reply's place) is CommitOutcomeUnknown: the version
 * may have committed. A connection the client already knows is lost (its
 * 'error' or 'end' event came first) is never sent COMMIT, so that stays a
 * failure with nothing loaded. Returns the evidence line.
 */
export async function loadSeed(client, { seed, fileSha256, approval, approvalsSha256, dryRun = false }) {
  const retiredHeldBack = heldBackAndRetired(seed);
  if (retiredHeldBack.length > 0) throw new LoadRefusal(retiredHeldBack.map(heldBackRetiredProblem).join('; '));
  // Whether the client has seen its connection go (pg's Client emits 'error' and then 'end'): it then refuses any
  // query without sending it, so a COMMIT asked for after that is never sent.
  let connectionGone = false;
  const gone = () => { connectionGone = true; };
  client.on?.('error', gone);
  client.on?.('end', gone);
  let commitSent = false;
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query("select pg_advisory_xact_lock(hashtextextended('hid-catalog-loader', 0))");
    const present = await client.query(`select to_regclass('ehr.catalog_versions') is not null
        and to_regclass('ehr.catalog_retired_codes') is not null as ready`);
    if (!present.rows[0].ready) throw new LoadRefusal('this schema has no catalogue tables (0149 is not applied)');
    await client.query('lock table ehr.catalog_versions in share row exclusive mode');
    const loaded = await client.query('select 1 from ehr.catalog_versions where kind = $1 and version = $2',
      [seed.kind, seed.version]);
    if (loaded.rowCount > 0) throw new LoadRefusal(`${seed.kind} ${seed.version} is already loaded`);
    const active = (await client.query(ACTIVE_IDS[seed.kind], [seed.kind])).rows[0];
    const dropped = droppedIds(seed, active?.ids ?? []);
    if (dropped.heldBack.length > 0 || dropped.notRetired.length > 0) throw new LoadRefusal(droppedLine(seed, active, dropped));
    const retired = await client.query(`insert into ehr.catalog_retired_codes (kind, list_id, reason)
        select $1, entry."listId", entry.reason from jsonb_to_recordset($2::jsonb) as entry("listId" text, reason text)
        on conflict (list_id) do nothing returning list_id`, [seed.kind, JSON.stringify(seed.retired)]);
    const versionId = randomUUID();
    await client.query(`insert into ehr.catalog_versions (id, kind, version, file_sha256, approval_reference,
        approvals_sha256, approved_at, attribution) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [versionId, seed.kind,
      seed.version, fileSha256, approval.approvalReference.trim(), approvalsSha256, approval.approvedAt, seed.attribution]);
    const inserted = await client.query(INSERTS[seed.kind], [versionId, JSON.stringify(seed.items)]);
    if (inserted.rowCount !== seed.items.length) throw new Error(`loaded ${inserted.rowCount} rows of ${seed.items.length}`);
    const replaced = await client.query(`update ehr.catalog_versions set active = false
        where kind = $1 and active returning version`, [seed.kind]);
    await client.query('update ehr.catalog_versions set active = true, loaded_at = clock_timestamp() where id = $1',
      [versionId]);
    const outcome = { status: dryRun ? 'dry-run: rolled back' : 'loaded', kind: seed.kind, version: seed.version, fileSha256,
      approvalsSha256, items: inserted.rowCount, newRetiredIds: retired.rows.map((row) => row.list_id),
      replaced: replaced.rows[0]?.version ?? null, heldBack: (seed.heldBack ?? []).length };
    // A dry run's rollback that loses its connection leaves nothing (the server rolls back an ended session), and
    // so does a connection already lost before COMMIT: the client refuses the query without sending it. Nothing
    // runs between this check and the query, so COMMIT counts as sent exactly when it goes to a connection the
    // client still holds; whether the server got it, and committed, is what stays unknown if no reply comes.
    commitSent = !dryRun && !connectionGone;
    await client.query(dryRun ? 'rollback' : 'commit');
    return outcome;
  } catch (error) {
    // The server answered COMMIT with an ERROR: the transaction rolled back, as with any other statement's error. No
    // reply (the connection lost) or a fatal one: the outcome is unknown. (A server whose messages are not in English
    // words its severity in its own language, which reads as unknown here: the safe side.)
    if (commitSent && error?.severity !== 'ERROR') throw new CommitOutcomeUnknown(error);
    await client.query('rollback').catch(() => {});
    if (error?.code === '55P03') throw new LoadRefusal(BUSY, { busy: true });
    if (DATABASE_REFUSALS.includes(error?.code)) {
      throw new LoadRefusal(`the database refused the load: ${error.message} (${error.code})`);
    }
    throw error;
  } finally {
    client.off?.('error', gone);
    client.off?.('end', gone);
  }
}
