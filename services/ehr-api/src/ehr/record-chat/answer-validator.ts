import { z } from 'zod';
import { containsIdentifier } from './identifiers';

/**
 * The structured answer the processor must return (output_config.format).
 * The Messages API refuses numerical, string-length and complex array
 * constraints in a JSON schema, so this schema carries only types, enums,
 * required and additionalProperties: false. Every bound is checked here, in
 * validateAnswer, before anything from the model is kept.
 */
export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'blocks'],
  properties: {
    status: { type: 'string', enum: ['answered', 'no_evidence'] },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'references'],
        properties: {
          kind: { type: 'string', enum: ['record', 'explanation', 'safety'] },
          text: { type: 'string' },
          references: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
} as const;

export const MAX_BLOCKS = 8;
export const MAX_BLOCK_CHARS = 2000;
export const MAX_ANSWER_CHARS = 4000;

export interface AnswerBlock {
  kind: 'record' | 'explanation' | 'safety';
  text: string;
  references: number[];
}

export type ValidatedAnswer =
  | { ok: true; status: 'answered' | 'no_evidence'; blocks: AnswerBlock[]; answer: string; cited: number[] }
  | { ok: false; reason: 'schema_invalid' | 'citations_invalid' | 'content_invalid' | 'answer_too_long' };

const answerSchema = z.strictObject({
  status: z.enum(['answered', 'no_evidence']),
  blocks: z.array(z.strictObject({
    kind: z.enum(['record', 'explanation', 'safety']),
    text: z.string().trim().min(1).max(MAX_BLOCK_CHARS),
    references: z.array(z.number().int()),
  })).min(1).max(MAX_BLOCKS),
});

const REFERENCE_MARKER = /\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/;
const MARKUP = /<\/?[a-z!][^>]*>|```|\*\*|__|^\s{0,3}#{1,6}\s|\[[^\]]*\]\([^)]*\)/im;

/** The joined plain-text answer, as stored and shown. */
export function joinBlocks(blocks: readonly AnswerBlock[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

/**
 * Checks the model's JSON against the answer rules: one to eight blocks of at
 * most 2,000 characters, a record block cites at least one supplied source
 * and only supplied sources (1..sourceCount), an explanation or safety block
 * cites none, an answered reply has a record block and a no-evidence reply
 * none, no bracketed reference markers, links, markup or identifier patterns,
 * and at most 4,000 characters in all. On any failure nothing from the model
 * is kept.
 */
export function validateAnswer(raw: string, sourceCount: number): ValidatedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'schema_invalid' };
  }
  const result = answerSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: 'schema_invalid' };
  const blocks: AnswerBlock[] = result.data.blocks.map((block) => ({ kind: block.kind, text: block.text,
    references: [...new Set(block.references)].sort((left, right) => left - right) }));
  for (const block of blocks) {
    if (block.kind === 'record') {
      if (block.references.length === 0
        || block.references.some((reference) => reference < 1 || reference > sourceCount)) {
        return { ok: false, reason: 'citations_invalid' };
      }
    } else if (block.references.length > 0) {
      return { ok: false, reason: 'citations_invalid' };
    }
    if (REFERENCE_MARKER.test(block.text) || MARKUP.test(block.text) || containsIdentifier(block.text)) {
      return { ok: false, reason: 'content_invalid' };
    }
  }
  const records = blocks.filter((block) => block.kind === 'record').length;
  if ((result.data.status === 'answered' && records === 0) || (result.data.status === 'no_evidence' && records > 0)) {
    return { ok: false, reason: 'citations_invalid' };
  }
  const answer = joinBlocks(blocks);
  if (answer.length > MAX_ANSWER_CHARS) return { ok: false, reason: 'answer_too_long' };
  const cited = [...new Set(blocks.flatMap((block) => block.references))].sort((left, right) => left - right);
  return { ok: true, status: result.data.status, blocks, answer, cited };
}
