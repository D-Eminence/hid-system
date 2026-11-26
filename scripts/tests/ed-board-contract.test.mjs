import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// ED-1 (0168, 0169): what the contracts and the flag's comments say holds to what the code does. Found in the agent
// review of #337 at feb4ac76: the texts promised the board at the sealed demo and QA facilities while ED_BOARD_ENABLED
// is one process-wide switch, and Rahman's front-desk nit and his second Q-ED-3 condition (#337 7175564791) were on
// neither the clinical lead's checklist nor the DPO items. (A service test may not read docs/: a change there would
// not select the service's tests.)
const repository = resolve(import.meta.dirname, '..', '..')
const read = (path) => readFileSync(resolve(repository, path), 'utf8')
const planned = read('docs/EHR_PLANNED_CONTRACT.md')
const interfaceContract = read('docs/INTERFACE_CONTRACT.md')
const migration = read('services/ehr-api/database/migrations/0168_emergency_department_board.sql')
const access = read('services/ehr-api/database/migrations/0169_emergency_department_board_access.sql')
const environment = read('services/ehr-api/src/config/environment.ts')
const boardService = read('services/ehr-api/src/ehr/ed-board/ed-board.service.ts')
const queueService = read('services/ehr-api/src/ehr/worklist/visit-queue.service.ts')
const environmentExample = read('services/ehr-api/.env.example')

/** The text from a heading line to the next heading of the same or a higher level. */
function section(text, heading) {
  const start = text.indexOf(`\n${heading}`)
  assert.ok(start >= 0, `no heading ${heading}`)
  const level = heading.match(/^#+/)[0].length
  const next = new RegExp(`\\n#{1,${level}} `, 'g')
  next.lastIndex = start + heading.length + 1
  const end = next.exec(text)
  return text.slice(start, end ? end.index : text.length)
}
const plannedEd = section(planned, '## ED-1: Emergency department board and triage')
const interfaceEd = section(interfaceContract, '## ED-1. Emergency department board and triage')
const flat = (text) => text.replace(/\s+/g, ' ')

/** A function's body in a migration, from its create line to its closing $fn$. */
function body(sql, name) {
  const start = sql.indexOf(`create function ${name}(`)
  assert.ok(start >= 0, `no function ${name}`)
  const open = sql.indexOf('$fn$', start) + 4
  return sql.slice(open, sql.indexOf('$fn$', open))
}

test('ED_BOARD_ENABLED is one switch for the whole process: no facility is looked at', () => {
  assert.match(environment, /\n\s*ED_BOARD_ENABLED: booleanString,\n/)
  assert.match(boardService, /export function edBoardEnabled\(\): boolean \{\n\s*return getEnvironment\(\)\.ED_BOARD_ENABLED;\n\}/)
  assert.match(queueService, /export function edBoardOn\(\): boolean \{\n\s*return getEnvironment\(\)\.ED_BOARD_ENABLED;\n\}/)
})

test('so no text says the board is on at the sealed demo and QA facilities, or in a separate staging', () => {
  // Production is the one deployment (0098: no separate staging backend) and serves the sealed facilities beside the
  // real ones: switching the flag on for them switches the board on at every facility.
  const flagComment = environment.slice(environment.lastIndexOf('\n', environment.indexOf('// ED-1 (0168, 0169)')),
    environment.indexOf('ED_BOARD_ENABLED: booleanString'))
  const exampleLines = environmentExample.slice(environmentExample.indexOf('# ED-1 (0168, 0169)'),
    environmentExample.indexOf('ED_BOARD_ENABLED='))
  const promise = /\bon in staging\b|\bon at the sealed\b|\band at the sealed demo and QA facilities\b/i
  for (const [where, text] of [['EHR_PLANNED_CONTRACT ED-1', plannedEd], ['INTERFACE_CONTRACT ED-1', interfaceEd],
    ['environment.ts', flagComment], ['.env.example', exampleLines], ['0168', migration]]) {
    assert.doesNotMatch(flat(text), promise, where)
  }
  for (const [where, text] of [['EHR_PLANNED_CONTRACT ED-1', plannedEd], ['INTERFACE_CONTRACT ED-1', interfaceEd],
    ['environment.ts', flagComment], ['.env.example', exampleLines]]) {
    assert.match(flat(text), /\bone switch\b/i, `${where} says the flag is one switch`)
  }
  const target = flat(section(plannedEd, '### Target'))
  assert.match(target, /Go-live: production flag `ED_BOARD_ENABLED`[^]*one switch for every facility[^]*sealed demo and QA/)
})

test('route 3 gives the history\'s reasons only to members who hold ehr.ed.triage, and both contracts say so', () => {
  const readBody = body(migration, 'ehr.ed_read')
  assert.match(readBody, /'reason', case when caller\.can_triage then event\.reason end/)
  assert.doesNotMatch(readBody, /'reason', event\.reason/)
  const route3 = flat(plannedEd.slice(plannedEd.indexOf('**3. `GET /ehr/ed-attendances/:attendanceId`**'),
    plannedEd.indexOf('**4. `POST /ehr/ed-attendances/:attendanceId/triage`**')))
  assert.match(route3, /`reason`[^]*only to members who hold `ehr\.ed\.triage`[^]*front desk it is always `null`/)
  const interfaceRoute3 = flat(interfaceEd.slice(interfaceEd.indexOf('**3. `GET /api/v1/ehr/ed-attendances/:attendanceId`**'),
    interfaceEd.indexOf('Every write below answers 200')))
  assert.match(interfaceRoute3, /`reason`[^]*only to members who hold `ehr\.ed\.triage`[^]*front desk it is always `null`/)
})

test('the clinical lead\'s checklist names the front desk\'s cancel of a triaged arrival while the desk can make it', () => {
  // ehr.ed_cancel needs only ehr.ed.arrive, and 0169 gives ehr.ed.arrive to the receptionist.
  assert.match(body(migration, 'ehr.ed_cancel'), /ehr\.ed_caller\('ehr\.ed\.arrive', array\['direct-care'\]\)/)
  assert.match(access, /\('receptionist', 'ehr\.ed\.arrive'\)/)
  const checklist = flat(section(plannedEd, '### Clinical lead checklist'))
  assert.match(checklist, /front desk may cancel any open arrival[^]*already triaged, even at level 1[^]*no level/i)
})

test('the DPO items carry Rahman\'s two Q-ED-3 conditions, the open outpatient row after a cancel, and the reasons', () => {
  const items = flat(section(plannedEd, '### DPO items'))
  const qEd3 = items.slice(items.indexOf('**Q-ED-3:**'), items.indexOf('**Q-ED-4:**'))
  assert.match(qEd3, /two conditions/)
  assert.match(qEd3, /`consentGrantId`/)
  assert.match(qEd3, /DPO explicitly accepts facility-wide visibility for the stay, including the open outpatient row\. \*\*Still open\.\*\*/)
  assert.match(qEd3, /`sent_to_outpatients`/)
  assert.match(qEd3, /after a cancel of the arrival/)
  assert.match(items, /\*\*Reasons in the history\*\*[^]*never to the front desk/)
  // The cancel keeps the row the arrival made open (back to waiting), whatever its basis.
  const cancelBody = body(migration, 'ehr.ed_cancel')
  assert.match(cancelBody, /if not current_row\.moved_from_waiting_list then\s+update ehr\.visit_queue entry\s+set stage = 'waiting'/)
  assert.doesNotMatch(cancelBody, /closed_at\s*=/)
})
