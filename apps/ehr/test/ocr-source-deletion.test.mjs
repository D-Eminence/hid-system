import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// The pure helper OcrReviewWorkspace uses for a source the OCR worker deleted after 24 hours (migration 0110).
const source = await readFile(new URL('../src/components/clinical/ocrSourceDeletion.ts', import.meta.url), 'utf8')
const helper = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`)
const { ocrReviewVisibility, SOURCE_DELETED_MESSAGE, CONTENT_DELETED_MESSAGE } = helper

const workspace = await readFile(new URL('../src/components/clinical/OcrReviewWorkspace.tsx', import.meta.url), 'utf8')

test('the sentences are exactly the agreed ones', () => {
  assert.equal(SOURCE_DELETED_MESSAGE, 'Source page deleted after 24 hours')
  assert.equal(CONTENT_DELETED_MESSAGE, 'Content deleted after 24 hours')
})

test('a normal document is previewed and reviewed', () => {
  assert.deepEqual(ocrReviewVisibility({ status: 'available' }, { contentDeleted: false }),
    { loadPreview: true, sourceNotice: null, contentNotice: null })
  assert.deepEqual(ocrReviewVisibility({ status: 'available' }, null),
    { loadPreview: true, sourceNotice: null, contentNotice: null })
})

test('a source_deleted document is not previewed, and shows both sentences instead of the page and the review', () => {
  assert.deepEqual(ocrReviewVisibility({ status: 'source_deleted' }, null),
    { loadPreview: false, sourceNotice: SOURCE_DELETED_MESSAGE, contentNotice: CONTENT_DELETED_MESSAGE })
  assert.deepEqual(ocrReviewVisibility({ status: 'source_deleted' }, { contentDeleted: true }),
    { loadPreview: false, sourceNotice: SOURCE_DELETED_MESSAGE, contentNotice: CONTENT_DELETED_MESSAGE })
})

test('a document being deleted (source_deleting) is treated the same way', () => {
  assert.deepEqual(ocrReviewVisibility({ status: 'source_deleting' }, { contentDeleted: true }),
    { loadPreview: false, sourceNotice: SOURCE_DELETED_MESSAGE, contentNotice: CONTENT_DELETED_MESSAGE })
})

test('an extraction ocr-api marks deleted shows the content sentence instead of the review', () => {
  assert.equal(ocrReviewVisibility({ status: 'available' }, { contentDeleted: true }).contentNotice,
    CONTENT_DELETED_MESSAGE)
})

test('no document selected: nothing to preview, no notice', () => {
  assert.deepEqual(ocrReviewVisibility(null, null), { loadPreview: false, sourceNotice: null, contentNotice: null })
})

test('the review workspace uses the helper for the preview, the extraction and the review controls', () => {
  assert.match(workspace, /ocrReviewVisibility\(document, null\)\.loadPreview \? clinicalApi\.documentDownload/)
  assert.match(workspace, /deletion\.sourceNotice \?/)
  assert.match(workspace, /deletion\.contentNotice \? <p role="status"/)
  assert.match(workspace, /const canReview = [^;]*!deletion\.contentNotice/)
  assert.match(workspace, /const publishable = !deletion\.contentNotice/)
})
