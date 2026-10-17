import { ANSWER_JSON_SCHEMA, validateAnswer } from './answer-validator';

const answer = (blocks: unknown[], status = 'answered') => JSON.stringify({ status, blocks });
const record = (text: string, references: number[] = [1]) => ({ kind: 'record', text, references });
const explanation = (text: string) => ({ kind: 'explanation', text, references: [] });

describe('record chat answer validation', () => {
  it('accepts record blocks citing supplied sources, with explanation and safety blocks citing none', () => {
    const result = validateAnswer(answer([record('Your blood pressure was 118 over 76.', [2, 1, 2]),
      explanation('Blood pressure has two numbers.'), { kind: 'safety', text: 'If you have chest pain, seek emergency care now.',
        references: [] }]), 3);
    expect(result).toEqual({ ok: true, status: 'answered', cited: [1, 2], answer:
      'Your blood pressure was 118 over 76.\n\nBlood pressure has two numbers.\n\nIf you have chest pain, seek emergency care now.',
    blocks: [record('Your blood pressure was 118 over 76.', [1, 2]), explanation('Blood pressure has two numbers.'),
      { kind: 'safety', text: 'If you have chest pain, seek emergency care now.', references: [] }] });
  });

  it('accepts a no-evidence answer made of explanations', () => {
    expect(validateAnswer(answer([explanation('Your released records do not mention allergies.')], 'no_evidence'), 3))
      .toMatchObject({ ok: true, status: 'no_evidence', cited: [] });
  });

  it.each([
    ['text that is not JSON', 'Your blood pressure was normal.', 'schema_invalid'],
    ['an unknown status', answer([record('x')], 'free_text'), 'schema_invalid'],
    ['an unknown block kind', answer([{ kind: 'advice', text: 'x', references: [] }]), 'schema_invalid'],
    ['an extra field', JSON.stringify({ status: 'answered', blocks: [record('x')], note: 'extra' }), 'schema_invalid'],
    ['an extra block field', answer([{ ...record('x'), url: 'y' }]), 'schema_invalid'],
    ['no blocks', answer([]), 'schema_invalid'],
    ['nine blocks', answer(Array.from({ length: 9 }, () => explanation('x'))), 'schema_invalid'],
    ['a block over 2000 characters', answer([record('x'.repeat(2001))]), 'schema_invalid'],
    ['an empty block', answer([record('   ')]), 'schema_invalid'],
    ['a fractional reference', answer([record('x', [1.5])]), 'schema_invalid'],
    ['a record block without a reference', answer([record('Your pulse was 64.', [])]), 'citations_invalid'],
    ['a reference past the last source', answer([record('Your pulse was 64.', [4])]), 'citations_invalid'],
    ['reference zero', answer([record('Your pulse was 64.', [0])]), 'citations_invalid'],
    ['an explanation with a reference', answer([record('Your pulse was 64.'), { ...explanation('x'), references: [1] }]),
      'citations_invalid'],
    ['an answered reply without a record block', answer([explanation('General help.')]), 'citations_invalid'],
    ['a no-evidence reply with a record block', answer([record('Your pulse was 64.')], 'no_evidence'), 'citations_invalid'],
    ['a bracketed reference marker', answer([record('Your pulse was 64 [1].')]), 'content_invalid'],
    ['a link', answer([record('See https://example.invalid/results for more.')]), 'content_invalid'],
    ['a www address', answer([record('See www.example.invalid for more.')]), 'content_invalid'],
    ['HTML', answer([record('Your pulse was <b>64</b>.')]), 'content_invalid'],
    ['markdown bold', answer([record('Your pulse was **64**.')]), 'content_invalid'],
    ['a markdown heading', answer([record('# Results\nYour pulse was 64.')]), 'content_invalid'],
    ['a markdown link', answer([record('See [results](records) for more.')]), 'content_invalid'],
    ['a Health ID', answer([record('Your Health ID is HID-ABCDEFGH.')]), 'content_invalid'],
    ['an 11-digit number (a NIN)', answer([record('Your number is 12345678901.')]), 'content_invalid'],
    ['a phone number', answer([record('Call +234 803 123 4567 now.')]), 'content_invalid'],
    ['an email address', answer([record('Write to synthetic@example.invalid.')]), 'content_invalid'],
    ['a record id', answer([record('Record 5c4a7900-0000-4000-8000-000000000001 says so.')]), 'content_invalid'],
    // Text the database cannot store (a NUL; a lone surrogate in jsonb) or a terminal could act on.
    ['a NUL character', answer([record('Your pulse was 64.\u0000')]), 'content_invalid'],
    ['a NUL escape in the JSON text', '{"status":"answered","blocks":[{"kind":"record","text":"Pulse 64\\u0000","references":[1]}]}',
      'content_invalid'],
    ['a control character', answer([record('Your pulse was 64.\u001b[2J')]), 'content_invalid'],
    ['a C1 control character', answer([record('Your pulse was 64.\u0085')]), 'content_invalid'],
    ['a lone surrogate', '{"status":"answered","blocks":[{"kind":"record","text":"Pulse \\ud800 64","references":[1]}]}',
      'content_invalid'],
    ['an answer over 4000 characters', answer([record('a'.repeat(1990)), record('b'.repeat(1990)), record('c'.repeat(100))]),
      'answer_too_long'],
  ])('refuses %s', (_label, raw, reason) => {
    expect(validateAnswer(raw, 3)).toEqual({ ok: false, reason });
  });

  it('keeps line breaks and tabs, which are not control characters for this purpose', () => {
    expect(validateAnswer(answer([record('Your pulse was 64.\nYour temperature was 36.6.\tBoth normal.')]), 1))
      .toMatchObject({ ok: true });
  });

  it('keeps dates, doses and measurements, which are not identifiers', () => {
    expect(validateAnswer(answer([record('On 2026-10-01 your pressure was 118/76 and you took 500 mg twice daily.')]), 1))
      .toMatchObject({ ok: true });
  });

  it('sends a schema with no constraint keyword the Messages API refuses', () => {
    const forbidden = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'multipleOf', 'pattern',
      'uniqueItems', 'exclusiveMinimum', 'exclusiveMaximum'];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      for (const key of forbidden) expect(Object.hasOwn(record, key)).toBe(false);
      if (record.type === 'object') expect(record.additionalProperties).toBe(false);
      Object.values(record).forEach(walk);
    };
    walk(ANSWER_JSON_SCHEMA);
    expect(JSON.stringify(ANSWER_JSON_SCHEMA)).toContain('"additionalProperties":false');
  });
});
