/**
 * hid-1.0's email design (supabase/functions/_shared/notifications.ts), as
 * the patient emails use it: a #f5f7fb page, a white 560-pixel card with a
 * 1-pixel #e5e7eb border and 16-pixel corners, a coloured header band with a
 * 24-pixel bold heading over "Health Identity Directory", a 28-pixel body of
 * 14-pixel text, and an optional dashed code box. Inline styles only, no
 * images and no links. Unlike hid-1.0, every value is HTML-escaped.
 */

/** The header colours hid-1.0 used: blue for codes and welcome, teal for "Password Updated", red for deletion. */
export type EmailAccent = '#1a6fd4' | '#0f766e' | '#b91c1c';

export interface EmailCodeBox {
  label: string;
  value: string;
  /** '0.24em' for a code, '0.12em' for a Health ID, as hid-1.0. */
  letterSpacing: '0.24em' | '0.12em';
}

export interface HidEmail {
  /** The document title: the email's subject. */
  title: string;
  accent: EmailAccent;
  heading: string;
  /** "Hello <name>," or, without one, "Hello there,". */
  greetingName?: string;
  /** Paragraphs before the code box (all of them when there is none). */
  paragraphs: readonly string[];
  codeBox?: EmailCodeBox;
  /** Paragraphs after the code box. */
  closing?: readonly string[];
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function greeting(name: string | undefined): string {
  return `Hello ${name || 'there'},`;
}

function paragraph(text: string, margin: string): string {
  return `<p style="margin:${margin};font-size:14px;line-height:1.7">${escapeHtml(text)}</p>`;
}

/** The HTML part of a patient email, in hid-1.0's layout and colours. */
export function hidEmailHtml(email: HidEmail): string {
  const closing = email.closing ?? [];
  const lastIndex = email.paragraphs.length + closing.length - 1;
  const before = email.paragraphs.map((text, index) => paragraph(text,
    index === lastIndex ? '0' : email.codeBox && index === email.paragraphs.length - 1 ? '0 0 18px' : '0 0 12px'));
  const after = closing.map((text, index) => paragraph(text,
    email.paragraphs.length + index === lastIndex ? '0' : '0 0 10px'));
  const codeBox = email.codeBox
    ? '<div style="margin:0 0 18px;padding:18px;border:1px dashed #93c5fd;border-radius:12px;background:#eff6ff;text-align:center">'
      + '<div style="font-size:12px;color:#6b7280;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px">'
      + `${escapeHtml(email.codeBox.label)}</div>`
      + `<div style="font-size:30px;font-weight:700;letter-spacing:${email.codeBox.letterSpacing};color:#1a6fd4">`
      + `${escapeHtml(email.codeBox.value)}</div></div>`
    : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeHtml(email.title)}</title></head><body style="margin:0;padding:0">`
    + '<div style="font-family:Arial,sans-serif;background:#f5f7fb;padding:24px;color:#111827">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">'
    + `<div style="padding:24px 28px;background:${email.accent};color:#ffffff">`
    + `<div style="font-size:24px;font-weight:700">${escapeHtml(email.heading)}</div>`
    + '<div style="font-size:12px;opacity:0.85;margin-top:4px">Health Identity Directory</div>'
    + '</div>'
    + '<div style="padding:28px">'
    + `<p style="margin:0 0 12px;font-size:14px">${escapeHtml(greeting(email.greetingName))}</p>`
    + before.join('') + codeBox + after.join('')
    + '</div></div></div></body></html>';
}

/** The plain-text part of the same email: the greeting, the paragraphs and the code box as "Label: value". */
export function hidEmailText(email: HidEmail): string {
  const parts = [greeting(email.greetingName), ...email.paragraphs];
  if (email.codeBox) parts.push(`${email.codeBox.label}: ${email.codeBox.value}`);
  parts.push(...(email.closing ?? []));
  return parts.join('\n\n');
}
