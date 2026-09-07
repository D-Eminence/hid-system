import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { canonicalizeTuf } from '../scripts/tuf-repository-layout.mjs'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

test('OLPC canonical JSON matches the pinned go-tuf P-256 key-ID vector', () => {
  const key = {
    keytype: 'ecdsa',
    scheme: 'ecdsa-sha2-nistp256',
    keyval: {
      public: [
        '-----BEGIN PUBLIC KEY-----',
        'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu+HEqqpXLa48lXH9rkRygsfsCKq1',
        'XM36oXymJ9wxpM68nCqkrZCVnZ9lkEeCwD8qWYTNxD5yfWXwJjFh+K7qLQ==',
        '-----END PUBLIC KEY-----',
      ].join('\n'),
    },
  }

  const canonical = canonicalizeTuf(key)
  assert.match(canonical, /PUBLIC KEY-----\nMFkw/)
  assert.doesNotMatch(canonical, /PUBLIC KEY-----\\nMFkw/)
  // Generated independently by go-tuf v2.4.2 metadata.Key.ID().
  assert.equal(sha256(canonical), '7ca7f5d763ebfd251ed387630d4c02a6ea1f2ec826712cc15247f0db55c161f2')
})

test('OLPC canonical JSON rejects numbers outside the TUF integer domain', () => {
  assert.throws(() => canonicalizeTuf({ value: 1.5 }), /safe base-10 integers/)
  assert.throws(() => canonicalizeTuf({ value: -0 }), /safe base-10 integers/)
})
