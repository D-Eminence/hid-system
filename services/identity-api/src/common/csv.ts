/**
 * RFC 4180 CSV for administrative exports.
 *
 * - Records end with CRLF, including the last one.
 * - A field containing a double quote, comma, CR or LF is quoted, with inner
 *   double quotes doubled.
 * - Spreadsheet formula injection (OWASP CSV injection): a value that begins
 *   with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with a
 *   single quote so spreadsheet software treats it as text.
 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvDocument(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).map((line) => `${line}\r\n`).join('');
}
