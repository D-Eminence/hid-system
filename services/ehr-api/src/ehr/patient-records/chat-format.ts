/**
 * Plain-text clean-up for every record chat answer, patient and staff, applied by the server
 * whatever the model wrote. Answers never contain an en dash (U+2013), an em dash (U+2014) or a
 * horizontal bar (U+2015):
 * - a range between two numbers ("2024–2025", "5 – 10") reads "2024 to 2025", "5 to 10";
 * - a dash at the start of a line is a list item and becomes "- ";
 * - a dash between clauses (an em dash or a horizontal bar, or a spaced en dash) becomes ", ",
 *   dropped before punctuation, at the end of a line or after an opening bracket;
 * - any other one (an unspaced en dash, as in "Smith–Jones") becomes "-".
 * Code (a ``` fenced block, or `inline code` on one line) is left exactly as written.
 */
const DASH = /[–—―]/;
const CLAUSE = '\u0000';

function plain(text: string): string {
  if (!DASH.test(text)) return text;
  return text
    .replace(/(\d)[ \t]*[–—―][ \t]*(?=\d)/g, '$1 to ')
    .replace(/^([ \t]*)[–—―][ \t]+/gm, '$1- ')
    .replace(/[ \t]*[—―][ \t]*|[ \t]+–[ \t]+/g, CLAUSE)
    .replace(/\u0000+(?=[.,;:!?)\]]|\n|$)/g, '')
    .replace(/(^|\n|[([])\u0000+/g, '$1')
    .replace(/\u0000+/g, ', ')
    .replace(/[–—―]/g, '-');
}

/** The answer's text and code parts, in order: code is a fenced block (to its closing fence or the end) or a matched `span` on one line. */
function parts(text: string): Array<{ code: boolean; text: string }> {
  const result: Array<{ code: boolean; text: string }> = [];
  const pattern = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) result.push({ code: false, text: text.slice(last, match.index) });
    result.push({ code: true, text: match[0] });
    last = match.index! + match[0].length;
  }
  if (last < text.length) result.push({ code: false, text: text.slice(last) });
  return result;
}

export function removeDashes(text: string): string {
  if (!DASH.test(text)) return text;
  return parts(text).map(part => part.code ? part.text : plain(part.text)).join('');
}

/**
 * removeDashes, kept within `limit` characters: "to" is longer than the dash it replaces, so a text
 * that would grow past the limit (a saved answer at the 4000-character limit) has each dash replaced
 * by "-" instead, which keeps its length.
 */
export function removeDashesWithin(text: string, limit: number): string {
  const clean = removeDashes(text);
  return clean.length <= limit ? clean : text.replace(/[–—―]/g, '-');
}

/**
 * removeDashes for text that arrives in pieces (a streamed answer). Each push returns the text that
 * is now final; end() returns the rest. The joined output equals removeDashes of the joined input:
 * text that a later piece could still change is held back (trailing spaces, a trailing dash and the
 * spaces around it, and an unclosed `inline code` span on the last line).
 */
export function dashStream() {
  let raw = ''; let sent = 0;
  const settled = () => {
    let end = raw.length;
    const tail = /[ \t–—―]+$/.exec(raw);
    if (tail) end = tail.index;
    const line = raw.slice(raw.lastIndexOf('\n', end - 1) + 1, end);
    if (!/```/.test(line) && (line.match(/`/g)?.length ?? 0) % 2 === 1) end -= line.length - line.lastIndexOf('`');
    return end;
  };
  const emit = (end: number) => {
    const output = removeDashes(raw.slice(0, end));
    const next = output.slice(sent); sent = output.length; return next;
  };
  return {
    push(chunk: string): string { raw += chunk; return emit(settled()); },
    end(): string { return emit(raw.length); },
  };
}

/**
 * The coverage gap of an answer in plain words, singular or plural, given to the model so its
 * "What is missing" part reads the same way.
 */
export function pendingDocumentsNote(pending: number): string | null {
  if (!Number.isSafeInteger(pending) || pending <= 0) return null;
  return pending === 1
    ? '1 document is still being read or could not be read, so this answer may be missing something.'
    : `${pending} documents are still being read or could not be read, so this answer may be missing something.`;
}
