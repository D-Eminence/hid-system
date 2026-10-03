import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preservedMigrationKey } from './preserved-migration-key.mjs';

test('retains exactly the legacy logical key for 32-byte and generated 33-byte envelopes', () => {
  for (const length of [32, 33]) {
    const bytes = Buffer.alloc(length, 7);
    assert.deepEqual(preservedMigrationKey(bytes.toString('base64')), bytes.subarray(0, 32));
  }
});
test('rejects truncated or noncanonical key encodings', () => {
  for (const value of ['', 'not a key', Buffer.alloc(31).toString('base64'), 'a'.repeat(43), 'a'.repeat(42) + 'a=']) {
    assert.throws(() => preservedMigrationKey(value), /Invalid preserved migration key/);
  }
});
