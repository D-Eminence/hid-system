import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// ORD-9 (0152): its post-checks pin what the file makes (Rahman's re-review of #320, nit 6), so an edited file whose
// sealed-release trigger fires on other events, or whose trigger function lost a check, is refused. Read from the
// file itself: each CREATE TRIGGER's events as pg_trigger.tgtype, and the trigger function's body as md5(prosrc).
const repository = resolve(import.meta.dirname, '..', '..')
const sql = readFileSync(resolve(repository, 'services/ehr-api/database/migrations/0152_catalog_diagnoses.sql'), 'utf8')
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

test('0152 makes three triggers on the diagnosis list, of types 27, 34 and 7', () => {
  assert.deepEqual(triggers, [
    { name: 'catalog_diagnoses_append_only', type: 27, fn: 'platform.reject_mutation' },
    { name: 'catalog_diagnoses_no_truncate', type: 34, fn: 'platform.reject_mutation' },
    { name: 'catalog_diagnoses_not_sealed', type: 7, fn: 'ehr.catalog_diagnosis_not_sealed' },
  ])
})

test('0152\'s post-checks pin each trigger by name, tgtype and function', () => {
  for (const trigger of triggers) {
    assert.match(postChecks, new RegExp(String.raw`trigger_row\.tgname = '${trigger.name}' and trigger_row\.tgtype = ${trigger.type}\b`),
      `${trigger.name} is pinned at tgtype ${trigger.type}`)
  }
  assert.match(postChecks, /trigger_row\.tgfoid = 'platform\.reject_mutation\(\)'::regprocedure/)
  assert.match(postChecks, /trigger_row\.tgfoid = 'ehr\.catalog_diagnosis_not_sealed\(\)'::regprocedure/)
})

test('0152\'s post-checks pin each trigger with no WHEN condition, no column list and no arguments', () => {
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

test('0152\'s post-checks pin the sealed-release function\'s body: the md5 is of its body in this file', () => {
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

// 0157 (ORD-9, Rahman's two ranking fixes after his last look at #320): one CREATE OR REPLACE of the diagnosis
// search. Its preconditions pin 0152's search by the md5 of its body, and its post-checks the md5 of its own; both
// are read here from the files, as above. Neither body names 0152 or 0157 (both name only 0149, in comments), so a
// new number at integration keeps both.
const rankingFile = 'services/ehr-api/database/migrations/0157_diagnosis_search_ranking.sql'
const ranking = readFileSync(resolve(repository, rankingFile), 'utf8')
const searchHead = 'ehr.search_catalog_diagnoses(requested_q text, requested_limit integer)'

/** The text between a function's $$ markers, as PostgreSQL stores it in pg_proc.prosrc. */
function bodyOf(text, head) {
  const start = text.indexOf(head)
  assert.ok(start >= 0, head)
  const bodyStart = text.indexOf('as $$', start) + 'as $$'.length
  return text.slice(bodyStart, text.indexOf('$$;', bodyStart))
}
const md5 = (text) => createHash('md5').update(text).digest('hex')
/** A body or file without its comment lines. */
const code = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
const searchBefore = bodyOf(sql, `create function ${searchHead}`)
const searchAfter = bodyOf(ranking, `create or replace function ${searchHead}`)
// The file's statements, after its header, with each comment line set aside (the header names what the code does).
const rankingCode = code(ranking.slice(ranking.indexOf('\n-- 0. Preconditions.\n')))

test('0157 pins 0152\'s search by the md5 of its body in 0152, and its own by the md5 of its body in 0157', () => {
  assert.equal(md5(searchBefore), '43f331b780d76226347dcf4cba313f74')
  const sections = ranking.slice(ranking.indexOf('\n-- 0. Preconditions.\n'))
  const preconditions = sections.slice(0, sections.indexOf('\n-- 1. The search ('))
  const rest = sections.slice(sections.indexOf('\n-- 3. Post-checks.\n'))
  assert.ok(preconditions.length > 0 && rest.length > 0)
  // The before-pin, once, in the preconditions; the after-pin in the "already applied" check and the post-check.
  assert.deepEqual([...preconditions.matchAll(/md5\(proc\.prosrc\) = '([0-9a-f]{32})'/g)].map((match) => match[1]), [md5(searchBefore)])
  assert.match(preconditions, new RegExp(`= '${md5(searchAfter)}' then\\s+raise exception using errcode = '55000', message = '0157: already applied';`))
  assert.deepEqual([...rest.matchAll(/md5\(proc\.prosrc\) = '([0-9a-f]{32})'/g)].map((match) => match[1]),
    [md5(searchAfter), '8b3c964d6b9f34c557210acfe1f986ff'])
  assert.notEqual(md5(searchAfter), md5(searchBefore))
  // 0149's query helper, which both bodies call, pinned as 0152 pins it.
  assert.ok(sql.includes("is distinct from '8b3c964d6b9f34c557210acfe1f986ff'"))
  assert.ok(preconditions.includes("is distinct from '8b3c964d6b9f34c557210acfe1f986ff'"))
  for (const body of [searchBefore, searchAfter]) assert.doesNotMatch(body, /\b015[0-9]\b/)
})

test('0157 restates the search\'s signature, columns, language, STABLE, SECURITY DEFINER and search_path', () => {
  const declaration = (text, create) => {
    const start = text.indexOf(`${create} ${searchHead}`)
    return text.slice(start + create.length + 1, text.indexOf('as $$', start)).trim().replace(/\s+/g, ' ')
  }
  const made = declaration(sql, 'create function')
  assert.equal(made, `${searchHead} returns table (code text, title text, matched_name text, list_version text, more boolean) `
    + 'language plpgsql stable security definer set search_path = pg_catalog, pg_temp')
  assert.equal(declaration(ranking, 'create or replace function'), made)
  assert.ok(searchAfter.startsWith('\n#variable_conflict use_column\ndeclare\n'))
  // No lock and no busy refusal; declarations of plain types only (a %TYPE or %ROWTYPE would look up a table).
  assert.doesNotMatch(rankingCode, /\block table\b|'55P03'|%rowtype|%type\b/i)
  // Every refusal of the file's own (the search's body keeps 22023 CATALOG_SEARCH_INVALID) is 55000 "0157: ...".
  const outside = rankingCode.replace(code(searchAfter), '')
  assert.ok(outside.length < rankingCode.length)
  const refusals = [...outside.matchAll(/errcode = '([0-9A-Z]{5})',\s*message = '([^']*)/g)]
  assert.equal(refusals.length, 8)
  for (const [, code, message] of refusals) {
    assert.equal(code, '55000', message)
    assert.ok(message.startsWith('0157: '), message)
  }
})

test('0157\'s body is 0152\'s but for the two fixes, the new key and their comments', () => {
  // Fix 1 (Rahman's form): the shortened word or the word as typed is one of the entry's own words, listed once per row.
  assert.match(searchAfter, /where not \(array\[word\.shortened_word, word\.shortened_word \|\| 's'\] && found\.entry_words\)/)
  assert.match(searchAfter, /string_to_array\(btrim\(candidate\.title_words \|\| ' '\s+\|\| regexp_replace\(lower\(candidate\.other_names\), '\[\^\[:alnum:\]\]\+', ' ', 'g'\)\), ' '\) as entry_words/)
  // Fix 2: every word of q, cut to 40 characters, not stopped at 6; 0 for a one-word q; the fourth key.
  assert.match(searchAfter, /typed_words := array\(select left\(split\.word, 40\)\s+from regexp_split_to_table\(lower\(searched\), '\[\^\[:alnum:\]\]\+'\) as split\(word\)\s+where split\.word <> ''\);/)
  assert.match(searchAfter, /case when cardinality\(typed_words\) < 2 then 0/)
  assert.match(searchAfter, /order by shown\.code_hit desc, shown\.name_is_q desc, shown\.starts_with_q desc,\s+shown\.words_named desc, length\(shown\.title\), lower\(shown\.title\) collate "C", shown\.code collate "C"\)/)
  // Line by line, with comments set aside, only these lines differ from 0152's body.
  const before = code(searchBefore).split('\n')
  const after = code(searchAfter).split('\n')
  const removed = before.filter((line) => !after.includes(line))
  const added = after.filter((line) => !before.includes(line))
  assert.deepEqual(removed.map((line) => line.trim()), [
    'as compared_other',
    "where word.shortened_word <> all (string_to_array(btrim(found.title_words || ' '",
    "|| regexp_replace(lower(found.other_names), '[^[:alnum:]]+', ' ', 'g')), ' '))))),",
    'length(shown.title), lower(shown.title) collate "C", shown.code collate "C") as position',
  ])
  assert.deepEqual(added.map((line) => line.trim()), [
    'typed_words text[];',
    'typed_words := array(select left(split.word, 40)',
    "from regexp_split_to_table(lower(searched), '[^[:alnum:]]+') as split(word)",
    "where split.word <> '');",
    "string_to_array(btrim(candidate.title_words || ' '",
    "|| regexp_replace(lower(candidate.other_names), '[^[:alnum:]]+', ' ', 'g')), ' ') as entry_words,",
    'as compared_other,',
    'case when cardinality(typed_words) < 2 then 0',
    'else (select count(*)::integer from unnest(typed_words) as typed(word)',
    'where exists (select 1 from unnest(found.entry_words) as entry(word)',
    'where starts_with(entry.word, typed.word))) end as words_named',
    "where not (array[word.shortened_word, word.shortened_word || 's'] && found.entry_words)))),",
    'shown.words_named desc, length(shown.title), lower(shown.title) collate "C", shown.code collate "C")',
    'as position',
  ])
})
