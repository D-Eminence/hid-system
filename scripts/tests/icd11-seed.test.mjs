import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { seedProblems, seedText } from '../../services/ehr-api/scripts/catalog-seed.mjs'
import {
  APPROVED_OTHER_NAMES, ICD11_NOTICE, LEFT_OUT_CHAPTERS, TABULATION_MEMBER, buildIcd11Seed, otherNamesFrom, parseTabulation,
  plainLetters, verbatimTitle, zipMember,
} from '../../services/ehr-api/scripts/icd11-seed.mjs'

// ORD-9 (0152): the ICD-11 diagnosis seed from WHO's release file
// (services/ehr-api/scripts/icd11-seed.mjs). Synthetic files with ICD-11's
// own codes and titles (WHO, CC BY-ND 3.0 IGO); the other names are ours.
const repository = resolve(import.meta.dirname, '..', '..')

/** A ZIP of the given members, each deflated or stored, with a central directory. */
function zip(members) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, text, store } of members) {
    const data = Buffer.from(text, 'utf8')
    const body = store ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const HEADER = ['Foundation URI', 'Linearization URI', 'Code', 'BlockId', 'Title', 'ClassKind', 'DepthInKind', 'IsResidual',
  'ChapterNo', 'BrowserLink', 'isLeaf', 'Primary tabulation', 'Grouping1', 'Grouping2', 'Grouping3', 'Grouping4',
  'Grouping5', 'CodingNote', 'Parent', 'Version:2026 Jan 17 - 05:30 UTC']
const line = (code, title, kind, chapter, { residual = 'False', note = '' } = {}) =>
  ['u', 'l', code, code ? '' : 'Block', `"${title}"`, kind, '1', residual, chapter, 'b', 'True', '', '', '', '', '', '', note, '']
    .join('\t')
const TABULATION = '﻿' + [HEADER.join('\t'),
  line('', 'Certain infectious or parasitic diseases', 'chapter', '01'),
  line('', '- Malaria', 'block', '01'),
  line('1F40', '- - Malaria due to Plasmodium falciparum', 'category', '01', { note: 'first part\nsecond part' }),
  line('1F4Z', '- - Malaria, unspecified', 'category', '01', { residual: 'True' }),
  line('1A07', '- - Typhoid fever', 'category', '01'),
  line('XN6P4', '- Plasmodium falciparum', 'category', 'X'),
  line('SP50', '- Enteric fever disorder (TM2)', 'category', '26'),
  line('VA00', '- Attention functions [WHODAS]', 'category', 'V'),
].join('\r\n') + '\r\n'
const SYNONYMS_SOURCE = `export const ICD11_TITLES = [
  ['Malaria', null],
  ['Malaria due to Plasmodium falciparum', '1F40'],
  ['Typhoid fever', '1A07'],
];
export const DIAGNOSIS_SYNONYMS: Readonly<Record<string, string>> = {
  'mp+': 'Malaria',
  'falciparum malaria': 'Malaria due to Plasmodium falciparum',
  'typhoid': 'Typhoid fever',
  'enteric fever': 'Typhoid fever',
};
`
const RELEASE_FILE = { name: 'SimpleTabulation-ICD-11-MMS-en.zip', sha256: 'f'.repeat(64) }

test('the ZIP reader finds a member, deflated or stored, through the central directory', () => {
  const archive = zip([{ name: 'readme.txt', text: 'read me', store: true }, { name: TABULATION_MEMBER, text: TABULATION }])
  assert.equal(zipMember(archive, TABULATION_MEMBER).toString('utf8'), TABULATION)
  assert.equal(zipMember(archive, 'readme.txt').toString('utf8'), 'read me')
  assert.throws(() => zipMember(archive, 'missing.txt'), /no member missing.txt/)
  assert.throws(() => zipMember(Buffer.from('not a zip'), TABULATION_MEMBER), /no end of central directory/)
})

test('the tabulation: quoted titles, a bare line break inside a note joined back, the release column ignored', () => {
  const rows = parseTabulation(TABULATION)
  assert.equal(rows.length, 8)
  const falciparum = rows.find((row) => row.Code === '1F40')
  assert.equal(falciparum.Title, '- - Malaria due to Plasmodium falciparum')
  assert.equal(falciparum.CodingNote, 'first part\nsecond part')
  assert.equal(falciparum.ChapterNo, '01')
  assert.ok(!('Version:2026 Jan 17 - 05:30 UTC' in falciparum))
  assert.equal(verbatimTitle('- - - Cholera'), 'Cholera')
  assert.equal(verbatimTitle('Malaria due to Plasmodium falciparum, unspecified'), 'Malaria due to Plasmodium falciparum, unspecified')
})

test('our other names: only those naming a coded title, by code, sorted', () => {
  const names = otherNamesFrom(SYNONYMS_SOURCE)
  assert.deepEqual([...names.entries()], [['1F40', ['falciparum malaria']], ['1A07', ['enteric fever', 'typhoid']]])
  assert.throws(() => otherNamesFrom('no list here'), /no DIAGNOSIS_SYNONYMS/)
})

// Rahman's re-review of #320, finding 1: a key in double quotes (a name with an apostrophe) was dropped.
test('our other names: a key or a title in double quotes is read, with its escapes', () => {
  const source = `export const ICD11_TITLES = [
  ['Parkinson disease', '8A00.0'],
  ['Bell palsy', '8B88.0'],
  ['Sjögren syndrome', '4A43.2'],
];
export const DIAGNOSIS_SYNONYMS: Readonly<Record<string, string>> = {
  "parkinson's disease": 'Parkinson disease',
  'parkinsons': "Parkinson disease",
  "bell's palsy": "Bell palsy",
  'sjogren\\'s syndrome': 'Sjögren syndrome',
  "a \\"quoted\\" name": 'Bell palsy',
};
`
  assert.deepEqual([...otherNamesFrom(source).entries()], [
    ['8A00.0', ["parkinson's disease", 'parkinsons']],
    ['8B88.0', ['a "quoted" name', "bell's palsy"]],
    ['4A43.2', ["sjogren's syndrome"]],
  ])
})

test('our other names: every entry of ocr-worker\'s DIAGNOSIS_SYNONYMS that names a coded title is read', () => {
  const source = readFileSync(resolve(repository, 'services/ocr-worker/src/reading/diagnosis-list.ts'), 'utf8')
  // An independent reading of both lists, line by line, in either quote.
  const literal = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`
  const text = (single, double) => (single ?? double).replace(/\\(['"\\])/g, '$1')
  const codes = new Map([...source.matchAll(new RegExp(String.raw`^\s*\[${literal}, (?:'([^']+)'|null)\],$`, 'gm'))]
    .map((match) => [text(match[1], match[2]), match[3] ?? null]))
  const block = source.slice(source.indexOf('export const DIAGNOSIS_SYNONYMS'), source.indexOf('\n};', source.indexOf('export const DIAGNOSIS_SYNONYMS')))
  const lines = block.split('\n').slice(1).filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
  const expected = new Map()
  for (const line of lines) {
    const match = new RegExp(String.raw`^\s*${literal}: ${literal},$`).exec(line)
    assert.ok(match, `an entry this test cannot read: ${line}`)
    const code = codes.get(text(match[3], match[4]))
    if (code) expected.set(code, [...new Set([...(expected.get(code) ?? []), text(match[1], match[2])])].sort())
  }
  assert.deepEqual(otherNamesFrom(source), expected)
  assert.deepEqual(otherNamesFrom(source).get('8A00.0'), ["parkinson's disease"])
})

// Ola (clinical owner), nit 9g of Rahman's re-review of #320: the plain-letter spelling of an accented title.
test('a title with accented letters gets its plain-letter spelling as our other name; nothing else does', () => {
  assert.equal(plainLetters('Sjögren syndrome'), 'Sjogren syndrome')
  assert.equal(plainLetters('Sézary syndrome'), 'Sezary syndrome')
  assert.equal(plainLetters('Behçet disease'), 'Behcet disease')
  assert.equal(plainLetters('Other specified sjögren syndrome'), 'Other specified sjogren syndrome')
  assert.equal(plainLetters('Malaria due to Plasmodium falciparum'), null)
  assert.equal(plainLetters('Haemoglobin H disease (– α/– – included)'), null)
  assert.equal(plainLetters('Unspecified infectious\u00a0disorders of eyelid'), null)
  const tabulation = '\ufeff' + [HEADER.join('\t'),
    line('4A43.2', '- - Sjögren syndrome', 'category', '04'),
    line('4A62', '- Behçet disease', 'category', '04'),
    line('3A50.02', '- - - Haemoglobin H disease (– α/– – included)', 'category', '03'),
  ].join('\r\n') + '\r\n'
  const source = `export const ICD11_TITLES = [
  ['Behçet disease', '4A62'],
];
export const DIAGNOSIS_SYNONYMS: Readonly<Record<string, string>> = {
  'behcets': 'Behçet disease',
};
`
  const seed = buildIcd11Seed(parseTabulation(tabulation),
    { release: '2026-01', releaseFile: RELEASE_FILE, otherNames: otherNamesFrom(source) })
  assert.deepEqual(seed.items.map((item) => [item.code, item.title, item.otherNames]), [
    ['3A50.02', 'Haemoglobin H disease (– α/– – included)', []],
    ['4A43.2', 'Sjögren syndrome', ['Sjogren syndrome']],
    ['4A62', 'Behçet disease', ['Behcet disease', 'behcets']],
  ])
  assert.deepEqual(seedProblems(seed), [])
})

// Promised on #320 (Ola, clinical owner): "Down syndrome" for LD40.0 and "gallstone" for DC11. Ola dropped "gallstones"
// on 25 Nov 2026: 0152's second attempt finds DC11 for it through "gallstone", then DA91.30 Gallstone ileus.
test('the approved other names: exactly these, each with its code, WHO\'s title and the approval', () => {
  assert.deepEqual(APPROVED_OTHER_NAMES.map((entry) => ({ ...entry, names: [...entry.names] })), [
    { code: 'LD40.0', title: 'Complete trisomy 21', names: ['down syndrome'],
      approval: 'approved by Ola as clinical owner, 25 Nov 2026 (#320, comments 7141511470 and 7168535216)' },
    { code: 'DC11', title: 'Cholelithiasis', names: ['gallstone'],
      approval: 'approved by Ola as clinical owner, 25 Nov 2026 (#320, comments 7141511470 and 7168535216)' },
  ])
  assert.ok(Object.isFrozen(APPROVED_OTHER_NAMES) && APPROVED_OTHER_NAMES.every((entry) => Object.isFrozen(entry)
    && Object.isFrozen(entry.names)))
})

test('the approved other names join their entry\'s other names; a code or title the release lacks stops the build', () => {
  const tabulation = '\ufeff' + [HEADER.join('\t'),
    line('', '- Diseases of gallbladder or biliary tract', 'block', '13'),
    line('DC11', '- - Cholelithiasis', 'category', '13'),
    line('DC11.Z', '- - - Cholelithiasis, unspecified', 'category', '13', { residual: 'True' }),
    line('LD40', '- - Complete trisomies of the autosomes', 'category', '20'),
    line('LD40.0', '- - - Complete trisomy 21', 'category', '20'),
  ].join('\r\n') + '\r\n'
  const rows = parseTabulation(tabulation)
  const build = (approvedNames, otherNames = new Map()) =>
    buildIcd11Seed(rows, { release: '2026-01', releaseFile: RELEASE_FILE, otherNames, approvedNames })
  const seed = build(APPROVED_OTHER_NAMES, new Map([['DC11', ['cholelithiasis stones']]]))
  assert.deepEqual(seed.items.map((item) => [item.code, item.title, item.otherNames]), [
    ['DC11', 'Cholelithiasis', ['cholelithiasis stones', 'gallstone']],
    ['DC11.Z', 'Cholelithiasis, unspecified', []],
    ['LD40', 'Complete trisomies of the autosomes', []],
    ['LD40.0', 'Complete trisomy 21', ['down syndrome']],
  ])
  assert.deepEqual(seedProblems(seed), [])
  // Without the list (and by default), the entries keep only what they had.
  assert.deepEqual(build([]).items.map((item) => item.otherNames), [[], [], [], []])
  assert.deepEqual(buildIcd11Seed(rows, { release: '2026-01', releaseFile: RELEASE_FILE }).items, build([]).items)
  const entry = (changes) => [{ code: 'DC11', title: 'Cholelithiasis', names: ['gallstones'], approval: 'approved', ...changes }]
  assert.throws(() => build(entry({ code: 'DC11.9' })), /approved other names: DC11\.9 is not in this release/)
  assert.throws(() => build(entry({ code: 'LD40.0' })),
    /approved other names: LD40\.0 is "Complete trisomy 21" in this release, not "Cholelithiasis"/)
  assert.throws(() => build(entry({ names: [] })), /DC11's names must be trimmed, non-empty and without ";"/)
  assert.throws(() => build(entry({ names: [' gallstones'] })), /DC11's names must be trimmed/)
  assert.throws(() => build(entry({ names: ['gallstones; calculi'] })), /DC11's names must be trimmed/)
  assert.throws(() => build(entry({ approval: ' ' })), /approved other names: DC11 has no approval/)
  assert.throws(() => build([...entry(), ...entry()]), /approved other names: DC11 is listed twice/)
  // A name another entry already has, as a title or other name, compared as the search compares them, stops it too.
  assert.throws(() => build(entry({ names: ['Cholelithiasis-unspecified'] })),
    /approved other names: "Cholelithiasis-unspecified" for DC11 is already a title or other name of DC11\.Z/)
  assert.throws(() => build(entry({ names: ['gallstones'] }), new Map([['DC11.Z', ["Gallstones's"]]])),
    /"gallstones" for DC11 is already a title or other name of DC11\.Z/)
  assert.throws(() => build([...entry(), { code: 'LD40.0', title: 'Complete trisomy 21', names: ['GALLSTONES'], approval: 'ok' }]),
    /"gallstones" for DC11 is already a title or other name of LD40\.0/)
  // Its own entry's title or other name is no clash.
  assert.deepEqual(build(entry({ names: ['cholelithiasis', 'gallstones'] }), new Map([['DC11', ['gallstones']]])).items[0].otherNames,
    ['cholelithiasis', 'gallstones'])
})

test('the seed: coded entries only, verbatim titles, code order; no extension code, block, chapter 26 or section V', () => {
  const seed = buildIcd11Seed(parseTabulation(TABULATION),
    { release: '2026-01', releaseFile: RELEASE_FILE, otherNames: otherNamesFrom(SYNONYMS_SOURCE) })
  assert.deepEqual(seed.items, [
    { code: '1A07', title: 'Typhoid fever', otherNames: ['enteric fever', 'typhoid'], chapter: '01', residual: false },
    { code: '1F40', title: 'Malaria due to Plasmodium falciparum', otherNames: ['falciparum malaria'], chapter: '01',
      residual: false },
    { code: '1F4Z', title: 'Malaria, unspecified', otherNames: [], chapter: '01', residual: true },
  ])
  assert.equal(seed.kind, 'diagnosis')
  assert.equal(seed.version, '2026-01')
  assert.deepEqual(seed.release, { name: 'ICD-11 MMS 2026-01', file: RELEASE_FILE.name, sha256: RELEASE_FILE.sha256 })
  assert.deepEqual(seed.leftOut.map((entry) => [entry.chapter, entry.entries]), [['26', 1], ['V', 1]])
  assert.deepEqual(seed.attribution, [ICD11_NOTICE])
  assert.deepEqual(seedProblems(seed), [])
  assert.equal(seedText(seed), seedText(buildIcd11Seed(parseTabulation(TABULATION),
    { release: '2026-01', releaseFile: RELEASE_FILE, otherNames: otherNamesFrom(SYNONYMS_SOURCE) })))
})

test('an other name for a code the release lacks, or a code twice, stops the build', () => {
  const rows = parseTabulation(TABULATION)
  assert.throws(() => buildIcd11Seed(rows, { release: '2026-01', releaseFile: RELEASE_FILE,
    otherNames: new Map([['9Z99', ['made up']]]) }), /other names for codes not in this release: 9Z99/)
  assert.throws(() => buildIcd11Seed([...rows, rows[2]], { release: '2026-01', releaseFile: RELEASE_FILE }),
    /the code 1F40 appears twice/)
})

test('the loader refuses a diagnosis seed that breaks 0152\'s rules', () => {
  const seed = buildIcd11Seed(parseTabulation(TABULATION), { release: '2026-01', releaseFile: RELEASE_FILE })
  const copy = () => JSON.parse(JSON.stringify(seed))
  const extension = copy(); extension.items.push({ ...extension.items[0], code: 'XN6P4' })
  assert.ok(seedProblems(extension).includes('XN6P4: the code is not an ICD-11 MMS code'))
  const twice = copy(); twice.items.push(twice.items[0])
  assert.ok(seedProblems(twice).includes('1A07: the id is used twice'))
  const retired = copy(); retired.retired = [{ listId: 'MED-00001', reason: 'Synthetic reason here' }]
  assert.ok(seedProblems(retired).some((problem) => problem.startsWith('a diagnosis list retires no id')))
})

test('the draft ICD-11 MMS 2026-01 seed in docs/codes/drafts loads as it stands', () => {
  const seed = JSON.parse(readFileSync(resolve(repository, 'docs/codes/drafts/icd11-mms-2026-01.json'), 'utf8'))
  assert.deepEqual(seedProblems(seed), [])
  assert.equal(seed.kind, 'diagnosis')
  assert.equal(seed.release.file, 'SimpleTabulation-ICD-11-MMS-en.zip')
  assert.equal(seed.release.sha256, 'f1356588f40953a83e3af2b662deab47c5e269f944d1ea4ed0cfeb2007c7cd39')
  assert.equal(seed.items.length, 17255)
  assert.deepEqual(seed.leftOut.map((entry) => [entry.chapter, entry.entries]), [['26', 1120], ['V', 130]])
  assert.deepEqual(Object.keys(LEFT_OUT_CHAPTERS), ['26', 'V'])
  assert.ok(seed.items.every((item) => !item.title.startsWith('- ') && !['26', 'V'].includes(item.chapter)))
  assert.deepEqual(seed.items.find((item) => item.code === '1F40'),
    { code: '1F40', title: 'Malaria due to Plasmodium falciparum', otherNames: ['falciparum malaria'], chapter: '01',
      residual: false })
  // DIAGNOSIS_SYNONYMS' one double-quoted key, and the plain-letter spellings of the 10 accented titles (Ola).
  const named = (code) => seed.items.find((item) => item.code === code).otherNames
  assert.deepEqual(named('8A00.0'), ["parkinson's disease"])
  assert.deepEqual(seed.items.filter((item) => plainLetters(item.title) !== null)
    .map((item) => [item.code, named(item.code).filter((name) => name === plainLetters(item.title))[0]]), [
    ['2B02', 'Sezary syndrome'],
    ['4A43.2', 'Sjogren syndrome'],
    ['4A43.20', 'Primary Sjogren syndrome'],
    ['4A43.21', 'Secondary Sjogren syndrome'],
    ['4A43.22', 'Paediatric onset Sjogren syndrome'],
    ['4A43.2Y', 'Other specified sjogren syndrome'],
    ['4A43.2Z', 'Sjogren syndrome, unspecified'],
    ['4A62', 'Behcet disease'],
    ['5C52.03', 'Sjogren-Larsson syndrome'],
    ['8A45.42', 'Demyelination due to Sjogren disease'],
  ])
  // The approved other names (Ola, 25 Nov 2026), each on its entry and nowhere else.
  assert.deepEqual(named('LD40.0'), ['down syndrome'])
  assert.deepEqual(named('DC11'), ['gallstone'])
  // "gallstones" is no entry's other name (dropped by Ola, 25 Nov 2026), so 0152's second attempt still runs for it.
  assert.deepEqual(seed.items.filter((item) => item.otherNames.some((name) => name.toLowerCase() === 'gallstones')), [])
  for (const { code, title, names } of APPROVED_OTHER_NAMES) {
    assert.equal(seed.items.find((item) => item.code === code).title, title)
    assert.deepEqual(seed.items.filter((item) => item.otherNames.some((name) => names.includes(name))).map((item) => item.code),
      [code])
  }
  assert.equal(seed.items.filter((item) => item.otherNames.length > 0).length, 78)
  const codes = seed.items.map((item) => item.code)
  assert.deepEqual(codes, [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  assert.equal(seedText(seed), readFileSync(resolve(repository, 'docs/codes/drafts/icd11-mms-2026-01.json'), 'utf8'))
})
