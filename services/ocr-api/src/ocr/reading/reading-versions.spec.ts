import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PAPER_READING_CONTRACT, PAPER_READING_SCHEMA_VERSION } from './paper-reading.contract';
import { MODEL_SCHEMA_VERSION, OCR_PROCESSING_CONTRACT, PROMPT_VERSION } from './reading-versions';

// The worker is another process and package: its files are read as text, never imported.
const worker = resolve(__dirname, '../../../../ocr-worker/src');
const workerFile = (path: string) => readFileSync(resolve(worker, path), 'utf8');
function workerConstant(path: string, name: string): string {
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(workerFile(path));
  if (!match?.[1]) throw new Error(`${name} is not a plain string constant in the worker's ${path}`);
  return match[1];
}

describe('versions mirrored from the OCR worker', () => {
  it('pins PROMPT_VERSION and MODEL_SCHEMA_VERSION to the worker prompt', () => {
    expect(PROMPT_VERSION).toBe(workerConstant('reading/prompt.ts', 'PROMPT_VERSION'));
    expect(MODEL_SCHEMA_VERSION).toBe(workerConstant('reading/prompt.ts', 'MODEL_SCHEMA_VERSION'));
  });

  it('pins the processing contract the worker writes into provenance', () => {
    expect(OCR_PROCESSING_CONTRACT).toBe(workerConstant('textract.provider.ts', 'TEXTRACT_PROCESSING_CONTRACT'));
  });

  it('keeps the payload contract a byte-for-byte copy of the worker contract', () => {
    expect(readFileSync(resolve(__dirname, 'paper-reading.contract.ts'), 'utf8')).toBe(workerFile('reading/contract.ts'));
    expect(PAPER_READING_CONTRACT).toBe('hid-paper-reading-v2');
    expect(PAPER_READING_SCHEMA_VERSION).toBe('hid-paper-reading-schema-2');
  });
});
