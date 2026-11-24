import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// ORD-9 (0150): its post-checks pin what the file makes (Rahman's re-review of #320, nit 6), so an edited file whose
// sealed-release trigger fires on other events, or whose trigger function lost a check, is refused. Read from the
// file itself: each CREATE TRIGGER's events as pg_trigger.tgtype, and the trigger function's body as md5(prosrc).
const repository = resolve(import.meta.dirname, '..', '..')
const sql = readFileSync(resolve(repository, 'services/ehr-api/database/migrations/0150_catalog_diagnoses.sql'), 'utf8')
const postChecks = sql.slice(sql.indexOf('-- 6. Post-checks.'))

/** pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate (64 instead of). */
function tgtype(timing, events, level) {
  const bits = { insert: 4, delete: 8, update: 16, truncate: 32 }
  return (level === 'row' ? 1 : 0) + (timing === 'before' ? 2 : timing === 'instead of' ? 64 : 0)
    + events.split(/\s+or\s+/).reduce((sum, event) => sum + bits[event], 0)
}

const triggers = [...sql.matchAll(
  /create trigger (\w+)\s+(before|after|instead of) ([a-z ]+?) on ehr\.catalog_diagnoses\s+for each (row|statement) execute function ([\w.]+)\(\);/g,
)].map(([, name, timing, events, level, fn]) => ({ name, type: tgtype(timing, events, level), fn }))

test('0150 makes three triggers on the diagnosis list, of types 27, 34 and 7', () => {
  assert.deepEqual(triggers, [
    { name: 'catalog_diagnoses_append_only', type: 27, fn: 'platform.reject_mutation' },
    { name: 'catalog_diagnoses_no_truncate', type: 34, fn: 'platform.reject_mutation' },
    { name: 'catalog_diagnoses_not_sealed', type: 7, fn: 'ehr.catalog_diagnosis_not_sealed' },
  ])
})

test('0150\'s post-checks pin each trigger by name, tgtype and function', () => {
  for (const trigger of triggers) {
    assert.match(postChecks, new RegExp(String.raw`trigger_row\.tgname = '${trigger.name}' and trigger_row\.tgtype = ${trigger.type}\b`),
      `${trigger.name} is pinned at tgtype ${trigger.type}`)
  }
  assert.match(postChecks, /trigger_row\.tgfoid = 'platform\.reject_mutation\(\)'::regprocedure/)
  assert.match(postChecks, /trigger_row\.tgfoid = 'ehr\.catalog_diagnosis_not_sealed\(\)'::regprocedure/)
})

test('0150\'s post-checks pin each trigger with no WHEN condition, no column list and no arguments', () => {
  // A trigger edited to fire only WHEN (...), or on UPDATE OF one column, keeps its tgtype, so the type alone does
  // not pin it: each post-check that names a trigger also requires tgqual, tgattr and tgnargs as CREATE TRIGGER
  // above leaves them (found in our own review of round 6).
  const plain = "trigger_row.tgqual is null and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0"
  const checks = postChecks.split(/from pg_trigger trigger_row/).slice(1).map((rest) => rest.slice(0, rest.indexOf(' then')))
  for (const trigger of triggers) {
    const naming = checks.filter((check) => check.includes(`trigger_row.tgname = '${trigger.name}'`))
    assert.equal(naming.length, 1, `one post-check names ${trigger.name}`)
    assert.ok(naming[0].replace(/\s+/g, ' ').includes(plain), `${trigger.name}'s post-check requires: ${plain}`)
  }
})

test('0150\'s post-checks pin the sealed-release function\'s body: the md5 is of its body in this file', () => {
  const start = sql.indexOf('create function ehr.catalog_diagnosis_not_sealed()')
  const bodyStart = sql.indexOf('as $$', start) + 'as $$'.length
  const body = sql.slice(bodyStart, sql.indexOf('$$;', bodyStart))
  // The body refuses another kind's version and a sealed one (nit 7 and Rahman's #318 finding 2).
  assert.match(body, /if target\.kind <> 'diagnosis' then/)
  assert.match(body, /if target\.sealed then/)
  const pins = [...postChecks.matchAll(/md5\(proc\.prosrc\) = '([0-9a-f]{32})'/g)].map((match) => match[1])
  assert.deepEqual(pins, [createHash('md5').update(body).digest('hex')])
  assert.match(postChecks, /proc\.oid = 'ehr\.catalog_diagnosis_not_sealed\(\)'::regprocedure and not proc\.prosecdef\s+and md5\(proc\.prosrc\) =/)
})
