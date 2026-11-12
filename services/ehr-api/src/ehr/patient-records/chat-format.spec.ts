import { dashStream, pendingDocumentsNote, removeDashes, removeDashesWithin } from './chat-format';

const EN = '–'; const EM = '—'; const BAR = '―';
const DASHES = /[–—―]/;

describe('removeDashes', () => {
  it.each([
    [`Seen 2024${EN}2025.`, 'Seen 2024 to 2025.'],
    [`Take 5 ${EN} 10 days`, 'Take 5 to 10 days'],
    [`Pages 3${EN}4`, 'Pages 3 to 4'],
    // An em dash between numbers is a clause break, never a range: "to" would change the meaning.
    [`BP 140/90 ${EM} 3 readings`, 'BP 140/90, 3 readings'],
    [`Type 2${EM}3 visits`, 'Type 2, 3 visits'],
    [`Seen 2024${BAR}2025`, 'Seen 2024, 2025'],
    // A dash standing for "nothing" stays visible as words.
    [`Result: ${EM}`, 'Result: none recorded'],
    [`Allergies:${EN}\nNext`, 'Allergies: none recorded\nNext'],
    [`| Test | Result |\n| Iron | ${EM} |`, '| Test | Result |\n| Iron | none recorded |'],
    [`- ${EM}`, '- none recorded'],
    [`- ${EM} Iron tablets`, '- Iron tablets'],
    [`Note: ${EM} see below`, 'Note: see below'],
    [`Recorded on 21 September 2026 ${EM} by a health worker.`, 'Recorded on 21 September 2026, by a health worker.'],
    [`Anaemia${EM}recorded in 2026${EM}was the first entry.`, 'Anaemia, recorded in 2026, was the first entry.'],
    [`It was recorded ${EN} not confirmed.`, 'It was recorded, not confirmed.'],
    [`Ends here ${EM}.`, 'Ends here.'],
    [`A line ending ${EM}\nNext line`, 'A line ending\nNext line'],
    [`(${EM} aside)`, '(aside)'],
    [`${EM} First item\n  ${EN} Second item`, '- First item\n  - Second item'],
    [`Smith${EN}Jones clinic`, 'Smith-Jones clinic'],
    [`Up to 2024${EN}`, 'Up to 2024-'],
    [`One${BAR}two`, 'One, two'],
    ['No dashes - here [1].', 'No dashes - here [1].'],
  ])('%j becomes %j', (input, output) => {
    expect(removeDashes(input)).toBe(output);
    expect(removeDashes(input)).not.toMatch(DASHES);
  });

  it('keeps citations, bold and list items around a clause dash', () => {
    expect(removeDashes(`**Iron deficiency anaemia** ${EM} recorded 21 September 2026 [1] [2]`))
      .toBe('**Iron deficiency anaemia**, recorded 21 September 2026 [1] [2]');
  });

  it('keeps bold working when a dash sits next to a bold marker', () => {
    expect(removeDashes(`**Iron deficiency anaemia ${EM}** recorded 21 September 2026 [1]`))
      .toBe('**Iron deficiency anaemia**, recorded 21 September 2026 [1]');
    expect(removeDashes(`**Iron deficiency anaemia${EM}**`)).toBe('**Iron deficiency anaemia**');
    expect(removeDashes(`**Anaemia ${EM}**. Seen once`)).toBe('**Anaemia**. Seen once');
    expect(removeDashes(`**${EM} Anaemia** seen`)).toBe('**Anaemia** seen');
    expect(removeDashes(`Seen ${EM} **twice** [1]`)).toBe('Seen, **twice** [1]');
    expect(removeDashes(`__Anaemia ${EM}__ seen`)).toBe('__Anaemia__, seen');
  });

  it('leaves code exactly as written', () => {
    const text = `Range 1${EN}2 and \`a${EM}b\`\n\`\`\`\nx ${EM} y\n\`\`\`\nAfter ${EM} code`;
    expect(removeDashes(text)).toBe(`Range 1 to 2 and \`a${EM}b\`\n\`\`\`\nx ${EM} y\n\`\`\`\nAfter, code`);
  });

  it('returns text without dashes unchanged', () => {
    const text = '## What the record shows\n\n- Item one [1]\n- Item two [2]';
    expect(removeDashes(text)).toBe(text);
  });

  it('keeps a text within its limit by using a plain hyphen when "to" would not fit', () => {
    const text = 'x'.repeat(3996) + `1${EN}2`;
    expect(removeDashesWithin(text, 4000)).toBe('x'.repeat(3996) + '1-2');
    expect(removeDashesWithin(`1${EN}2`, 4000)).toBe('1 to 2');
  });
});

describe('dashStream', () => {
  const samples = [
    `From 2024${EN}2025 ${EM} as recorded [1].\n${EM} Item one\nSmith${EN}Jones \`a${EM}b\` end ${EM}`,
    `Value 5 ${EN} 10, then ${EM}more${EM} text.\n\`\`\`\nx ${EM} y\n\`\`\`\nDone 1${EM}2`,
    `**Answer** ${EM} 21 September 2026. Range 3 ${EN}\n4 ${EN} 5`,
    // A dash inside an `inline code` span that only closes in a later piece.
    `\`\` ${EN} a\`\nmore`,
    `**Anaemia ${EM}** seen\nResult: ${EM}\n| a | ${EM} |\n\`\`\`\nx ${EM}`,
  ];
  it.each(samples)('gives the same text as removeDashes whatever the chunk boundaries (%#)', sample => {
    const expected = removeDashes(sample);
    for (let size = 1; size <= 7; size++) {
      for (let offset = 0; offset < size; offset++) {
        const stream = dashStream(); let out = '';
        out += stream.push(sample.slice(0, offset));
        for (let i = offset; i < sample.length; i += size) out += stream.push(sample.slice(i, i + size));
        out += stream.end();
        expect(out).toBe(expected);
      }
    }
  });

  it('handles a range split across chunks, sending whole lines as they finish', () => {
    const stream = dashStream();
    expect(stream.push('From 2024')).toBe('');
    expect(stream.push(EN)).toBe('');
    expect(stream.push('2025.\nNext')).toBe('From 2024 to 2025.\n');
    expect(stream.end()).toBe('Next');
  });

  it('never repeats text when a later piece closes an inline code span (the reviewed case)', () => {
    const sample = `\`\` ${EN} a\`\nmore`;
    for (const cut of [6, 7]) {
      const stream = dashStream();
      const out = stream.push(sample.slice(0, cut)) + stream.push(sample.slice(cut)) + stream.end();
      expect(out).toBe(removeDashes(sample));
    }
  });
});

describe('pendingDocumentsNote', () => {
  it('uses plain words, singular and plural, never "document(s)"', () => {
    expect(pendingDocumentsNote(1)).toBe('1 document is still being read or could not be read, so this answer may be missing something.');
    expect(pendingDocumentsNote(3)).toBe('3 documents are still being read or could not be read, so this answer may be missing something.');
    expect(pendingDocumentsNote(0)).toBeNull();
    expect(pendingDocumentsNote(2)).not.toContain('(s)');
  });
});
