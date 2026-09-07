import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { runPreviewGate } from '../scripts/tuf-preview-gate.mjs'
import { publicationAuthorization } from './helpers/tuf-publication-fixture.mjs'

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('preview admission uses an exact version URL, pinned root, and disposable fresh client state', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'hid-preview-gate-test-'))
  try {
    const versionId = '1234abcd-1234-1234-1234-123456789abc'
    const receiptBody = {
      schema_version: '2.0.0',
      action: 'version-upload',
      deployment: 'staging',
      worker_name: 'hid-tuf-staging',
      repository_sha256: 'a'.repeat(64),
      file_count: 5,
      root_version: 1,
      targets_version: 1,
      snapshot_version: 1,
      timestamp_version: 1,
      version_id: versionId,
      preview_url: 'https://1234abcd-hid-tuf-staging.account-name.workers.dev/',
      uploaded_at: '2026-09-01T00:00:00.000Z',
      wrangler_version: '4.127.1',
      publication_authorization: publicationAuthorization({
        deployment: 'staging', repositorySha256: 'a'.repeat(64), fileCount: 5,
        rootVersion: 1, targetsVersion: 1, snapshotVersion: 1, timestampVersion: 1,
        files: [{ path: 'metadata/1.root.json', sha256: sha256(Buffer.from('{"trusted":"root"}\n')) }],
      }, new Date('2026-09-01T00:00:00Z')),
    }
    const uploadReceipt = resolve(directory, 'upload.json')
    await writeFile(uploadReceipt, JSON.stringify({
      ...receiptBody,
      receipt_sha256: sha256(canonicalize(receiptBody)),
    }))
    const root = resolve(directory, '1.root.json')
    const rootBytes = Buffer.from('{"trusted":"root"}\n')
    await writeFile(root, rootBytes)
    const client = resolve(directory, 'hid-tuf')
    await writeFile(client, 'test client')
    const workspace = resolve(directory, 'workspace')
    const output = resolve(directory, 'admission.json')
    const releaseId = `r0000000001-g${'b'.repeat(40)}`
    let ephemeralDirectory

    const expected = { deployment_plan: { environment: 'staging', release_id: releaseId } }
    const result = await runPreviewGate({
      uploadReceipt,
      client,
      clientSha256: 'c'.repeat(64),
      root,
      rootSha256: sha256(rootBytes),
      releaseId,
      gitSha: 'b'.repeat(40),
      awsAccountId: '123456789012',
      awsRegion: 'us-east-1',
      admissionTime: '2026-09-01T00:01:00Z',
      workspace,
      output,
    }, {
      async admitRelease(options) {
        const config = JSON.parse(await readFile(options.config, 'utf8'))
        ephemeralDirectory = resolve(options.config, '..')
        assert.equal(config.repository_id, 'hid-staging-preview-1234abcd')
        assert.equal(config.metadata_url, `${receiptBody.preview_url}metadata`)
        assert.equal(config.targets_url, `${receiptBody.preview_url}targets`)
        assert.equal(config.trusted_root_path, root)
        assert.equal(config.trusted_root_sha256, sha256(rootBytes))
        assert.equal(config.state_dir, resolve(ephemeralDirectory, 'state'))
        assert.equal(options.workspace, workspace)
        assert.equal(options.output, output)
        await mkdir(config.state_dir)
        await writeFile(resolve(config.state_dir, 'state.json'), '{}')
        return expected
      },
    })
    assert.equal(result, expected)
    await assert.rejects(readFile(resolve(ephemeralDirectory, 'state', 'state.json')), /ENOENT/)

    await assert.rejects(runPreviewGate({
      uploadReceipt: 'relative-upload.json',
      client,
      root,
      workspace,
      output,
    }), /absolute uploadReceipt path/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
