/**
 * Numbers that identify a person but carry no clinical meaning are hidden
 * before a page leaves for the Claude API: 11-digit NIN-like numbers and
 * Nigerian phone numbers (+234 / 234 / 0 followed by a 7, 8 or 9 mobile
 * prefix). Each is replaced by a numbered placeholder; grounding runs on the
 * same masked text the model saw, and restore() puts the original back into
 * what is stored, so asWritten stays verbatim to the line.
 */
const PHONE = /(?<![\d+])(?:\+?234[\s-]?|0)[789][01]\d(?:[\s-]?\d){7}(?!\d)/g;
const NIN_LIKE = /(?<!\d)\d{11}(?!\d)/g;
const PLACEHOLDER = /\[hidden-number-(\d+)\]/g;

/** Text with every placeholder blanked, so its index and words never count as written on the page. */
export function withoutPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER, ' ');
}

export interface Masker {
  mask(text: string): string;
  restore(text: string): string;
  readonly count: number;
}

export function createMasker(): Masker {
  const hidden: string[] = [];
  const replace = (match: string) => {
    hidden.push(match);
    return `[hidden-number-${hidden.length}]`;
  };
  return {
    mask: (text) => text.replace(PHONE, replace).replace(NIN_LIKE, replace),
    restore: (text) => text.replace(PLACEHOLDER, (placeholder, index: string) => hidden[Number(index) - 1] ?? placeholder),
    get count() { return hidden.length; },
  };
}
