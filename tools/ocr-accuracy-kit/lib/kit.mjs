// Loading the kit's answer keys and manifest, and proving a document file is one of the kit's own
// fictional documents. Nothing here prints document text.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_KEYS_DIR = path.join(KIT_DIR, 'keys');
export const DEFAULT_WORKER_DIR = path.resolve(KIT_DIR, '..', '..', 'services', 'ocr-worker');

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** keys.jsonl and manifest.json from a keys directory; the manifest's keysSha256 must match the keys file. */
export function loadKeys(keysDir = DEFAULT_KEYS_DIR) {
  const keysPath = path.join(keysDir, 'keys.jsonl');
  const manifestPath = path.join(keysDir, 'manifest.json');
  if (!existsSync(keysPath) || !existsSync(manifestPath)) {
    throw new KitError('KEYS_MISSING', `no keys.jsonl and manifest.json in ${keysDir}`);
  }
  const keysText = readFileSync(keysPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (sha256Hex(Buffer.from(keysText, 'utf8')) !== manifest.keysSha256) {
    throw new KitError('KEYS_MANIFEST_MISMATCH', 'keys.jsonl does not match manifest.json (keysSha256)');
  }
  const keys = keysText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  for (const key of keys) {
    if (key.fictional !== true) throw new KitError('NOT_FICTIONAL', `key ${key.docId} is not marked fictional`);
    if (!(key.file in manifest.files)) throw new KitError('KEYS_MANIFEST_MISMATCH', `${key.file} is not in the manifest`);
  }
  if (keys.length !== manifest.count) throw new KitError('KEYS_MANIFEST_MISMATCH', 'key count differs from manifest');
  return { keys, manifest };
}

/**
 * The document's bytes, only if they are exactly the kit's generated file (sha256 in the manifest). This is
 * what stops anything other than the kit's fictional documents being sent to a real service.
 */
export function readKitDocument(docsDir, key, manifest) {
  const file = path.join(docsDir, key.file);
  if (!existsSync(file)) throw new KitError('DOCUMENT_MISSING', `${key.file} not found in ${docsDir} (run generate.py)`);
  const bytes = readFileSync(file);
  const digest = sha256Hex(bytes);
  if (digest !== manifest.files[key.file]) {
    throw new KitError('DOCUMENT_NOT_IN_MANIFEST', `${key.file} is not the kit's generated file (sha256 differs)`);
  }
  return { bytes, sha256Hex: digest };
}

export class KitError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'KitError'; }
}

/** A tiny argv parser: --flag, --name value, --name=value. */
export function parseArgs(argv, { booleans = [], strings = [] }) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const [rawName, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (booleans.includes(rawName)) { out[rawName] = inline === undefined ? true : inline !== 'false'; continue; }
    if (strings.includes(rawName)) {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined) throw new KitError('USAGE', `--${rawName} needs a value`);
      out[rawName] = value;
      continue;
    }
    throw new KitError('USAGE', `unknown option --${rawName}`);
  }
  return out;
}
