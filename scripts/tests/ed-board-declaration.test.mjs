import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// ED-1 (0168, 0169): the unsigned declaration, and the pull request text the owner signs from, hold to the files
// that ship. Found in the agent review of #337 at 3b9bf8db: the declaration's order proof cited APPT-1's 0160-0161
// at ae6f6560 and BILL-1's 0162-0167 at 046fb5a7, "not rerun at this head", while both branches had since changed
// those files (0161; 0163 and 0167); and the pull request body still named db83d733's sha256s for signing and did
// not say that ED-1 ships after APPT-1 and BILL-1. Every case is skipped once the declaration is no longer ED-1's (a
// later release rewrites it, and integration closes the numbers up).
//
// The checks against other branches use only what this clone already holds: a cited commit, and the remote-tracking
// branch of each department ED-1 ships after (CI's shallow checkout has neither, so they skip there). The pull
// request body is not in the repository: put it in a file and name it, for example
//   gh pr view 337 --json body --jq .body > /tmp/pr337.md
//   HID_ED_PR_BODY=/tmp/pr337.md node --test scripts/tests/ed-board-declaration.test.mjs
const repository = resolve(import.meta.dirname, '..', '..')
const declaration = JSON.parse(readFileSync(resolve(repository, 'config/production-schema-compatibility.json'), 'utf8'))
const files = declaration.files ?? {}
const migrations = 'services/ehr-api/database/migrations/'
const skip = Object.hasOwn(files, `${migrations}0168_emergency_department_board.sql`) ? false : 'not ED-1\'s declaration'
// The branch of each department the release order puts before ED-1.
const laneBranches = { 'APPT-1': 'claude/sprint-appointments-backend', 'BILL-1': 'claude/sprint-billing-backend' }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function git(...args) {
  try {
    return execFileSync('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 })
  } catch {
    return null
  }
}
/** The bytes of the migration numbered `number` at `revision`, or null when the revision holds none. */
function migrationAt(revision, number) {
  const names = git('ls-tree', '--name-only', revision, migrations)?.toString().split('\n') ?? []
  const name = names.find((path) => path.startsWith(`${migrations}${number}_`))
  return name ? { name, bytes: git('show', `${revision}:${name}`) } : null
}

/** The departments ED-1 ships after, as the review reference states the release order. */
function orderedBefore() {
  const statement = declaration.review_reference?.match(/ED-1 ships after ((?:[A-Z]+-\d+(?:, | and )?)+)/)
  assert.ok(statement, 'the review reference states which departments ED-1 ships after')
  return statement[1].match(/[A-Z]+-\d+/g)
}
/** Each "LANE at <commit> (NNNN <sha256 prefix>..., ...)" in the evidence. */
function citations() {
  const citation = /\b([A-Z]+-\d+) at ([0-9a-f]{8,40}) \(((?:\d{4} [0-9a-f]{8}\.\.\.(?:, )?)+)\)/g
  return [...declaration.evidence.matchAll(citation)].map(([, lane, commit, list]) => ({ lane, commit,
    files: [...list.matchAll(/(\d{4}) ([0-9a-f]{8})\.\.\./g)].map(([, number, prefix]) => ({ number, prefix })) }))
}
const sentences = (text) => text.split(/(?<=[^.]\.) (?=[A-Z(])/)

test('the declaration names each database file at its sha256', { skip }, () => {
  assert.ok(Object.keys(files).length > 0)
  for (const [path, hash] of Object.entries(files)) {
    assert.equal(sha256(readFileSync(resolve(repository, path))), hash, `${path} is not at the declared sha256`)
  }
})

test('the order proof names each department ED-1 ships after at a head with its files, and was rerun', { skip }, () => {
  const lanes = orderedBefore()
  assert.ok(lanes.includes('APPT-1') && lanes.includes('BILL-1'), 'Rahman\'s order: ED-1 ships after APPT-1 and BILL-1')
  const cited = citations()
  for (const lane of lanes) {
    const run = cited.find((entry) => entry.lane === lane)
    assert.ok(run, `the evidence cites ${lane} as "${lane} at <commit> (NNNN <sha256>..., ...)"`)
    assert.ok(run.files.length > 0)
  }
  for (const sentence of sentences(declaration.evidence)) {
    if (!/\bnot rerun\b/i.test(sentence)) continue
    for (const lane of lanes) {
      assert.ok(!sentence.includes(lane), `an order run after ${lane} is marked as not rerun: ${sentence.slice(0, 160)}`)
    }
  }
})

test('each cited file has the cited sha256 at the cited commit, where this clone holds it', { skip }, (t) => {
  let checked = 0
  for (const { lane, commit, files: cited } of citations()) {
    if (git('cat-file', '-e', `${commit}^{commit}`) === null) {
      t.diagnostic(`${lane}'s ${commit} is not in this clone`)
      continue
    }
    for (const { number, prefix } of cited) {
      const file = migrationAt(commit, number)
      assert.ok(file, `${lane} at ${commit} has no migration ${number}`)
      assert.ok(sha256(file.bytes).startsWith(prefix), `${file.name} at ${commit} is not ${prefix}...`)
      checked++
    }
  }
  if (checked === 0) t.skip('no cited commit is in this clone')
})

test('the order proof ran the files on each earlier department\'s pushed branch, where this clone has it', { skip },
  (t) => {
    let checked = 0
    for (const { lane, files: cited } of citations()) {
      const branch = laneBranches[lane]
      if (!branch) continue
      const ref = `refs/remotes/origin/${branch}`
      if (git('rev-parse', '--verify', '--quiet', ref) === null) {
        t.diagnostic(`origin/${branch} is not in this clone`)
        continue
      }
      for (const { number, prefix } of cited) {
        const file = migrationAt(ref, number)
        assert.ok(file, `origin/${branch} no longer has ${lane}'s ${number}: rerun the order proof and update the evidence`)
        const actual = sha256(file.bytes)
        assert.ok(actual.startsWith(prefix), `${lane}'s ${file.name} on origin/${branch} is ${actual.slice(0, 8)}..., ` +
          `not the ${prefix}... the order proof ran: rerun it at that head and update the evidence`)
        checked++
      }
    }
    if (checked === 0) t.skip('no earlier department\'s branch is in this clone')
  })

test('the pull request body names the declared sha256s, the release order and the current text', {
  skip: skip || (process.env.HID_ED_PR_BODY ? false : 'HID_ED_PR_BODY names no file'),
}, () => {
  const body = readFileSync(process.env.HID_ED_PR_BODY, 'utf8')
  const lines = body.split('\n')
  // Every line naming a declared file names it at the declared sha256, and each declared file has such a line.
  for (const [path, hash] of Object.entries(files)) {
    const name = path.split('/').at(-1)
    const naming = lines.filter((line) => line.includes(name) && /\b[0-9a-f]{64}\b/.test(line))
    assert.ok(naming.length > 0, `the body names ${name} with its sha256`)
    for (const line of naming) {
      for (const [found] of line.matchAll(/\b[0-9a-f]{64}\b/g)) {
        assert.equal(found, hash, `the body names ${name} at ${found.slice(0, 8)}..., not the declared ${hash.slice(0, 8)}...`)
      }
    }
  }
  const lanes = orderedBefore()
  assert.match(body, new RegExp(`ED-1 ships after [^\\n]*${lanes.join('[^\\n]*')}`), 'the body states the release order')
  // The release contract check's booked numbers, as the code has them.
  const verifier = readFileSync(resolve(repository, 'release/scripts/verify-release-contract.mjs'), 'utf8')
  const [, low, high] = verifier.match(/if \(number >= (\d+) && number <= (\d+)\) continue/)
  for (const [, from, to] of body.matchAll(/booked numbers (\d{4})-(\d{4})/g)) {
    assert.deepEqual([Number(from), Number(to)], [Number(low), Number(high)], `the body's booked numbers ${from}-${to}`)
  }
  // A cancel closes only the ED record and keeps the waiting-list row open (0168's ehr.ed_cancel).
  const cancel = lines.find((line) => line.startsWith('- **Cancel.**'))
  assert.ok(cancel, 'the body has the Cancel bullet')
  assert.match(cancel, /only the ED record closes/i)
  assert.match(cancel, /stays open/i)
  // Rahman's item 3 and the admission nit on the go-live line: the rollback runbook and the admit_requested hand-over.
  const goLive = lines.find((line) => line.startsWith('**Go-live checklist line:**'))
  assert.ok(goLive, 'the body has the go-live checklist line')
  assert.match(goLive, /before rolling ehr-api back/i)
  assert.match(goLive, /admit_requested/)
})
