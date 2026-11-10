/**
 * Versions the OCR worker stamps on every extraction it writes. They mirror the
 * worker's own constants (the worker's src/textract.provider.ts and
 * src/reading/prompt.ts); reading-versions.spec.ts pins them equal, so a new
 * worker prompt cannot ship without this API learning it.
 *
 * provenance.processingContract: the Textract step and line output.
 * provenance.reading.promptVersion: the frozen Claude prompt that read the lines into items.
 */
export const OCR_PROCESSING_CONTRACT = 'hid-textract-v2';
export const PROMPT_VERSION = 'hid-paper-reading-prompt-11';
export const MODEL_SCHEMA_VERSION = 'hid-paper-reading-model-schema-2';

/** The first contract: structured_payload was { pages: [{ page, text, confidence }] }. Read-only now. */
export const LEGACY_PROCESSING_CONTRACT = 'hid-textract-v1';

/** Readings that a new job could improve on once AI reading is on: never reused then. */
export const READINGS_REDONE_WHEN_AI_ON = ['ai_off', 'ai_failed'] as const;
