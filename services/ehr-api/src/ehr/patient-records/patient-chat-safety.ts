import type { ChatReply, ContextBinding } from './patient-chat-history.service';
import { originLabel,type Evidence,type EvidenceBinding,type SourceKind } from './patient-evidence.types';

/**
 * Patient-chat safeguards applied by the server, never by the model. Staff
 * chat uses none of this.
 */
export const RESULT_LINE = 'Talk to your doctor about what this result means.';
// Wording to be confirmed by Ola (design D6).
export const DIAGNOSIS_LINE = 'Talk to your doctor about what this diagnosis means.';
export const CORRECTING_LINE = 'The lab is correcting this result.';
export const NOT_CHECKED_LINE = 'Not checked by a clinician.';
export const PATIENT_LINES = [CORRECTING_LINE, RESULT_LINE, DIAGNOSIS_LINE] as const;
/** Generated patient answers stay below this, so the server lines still fit the 4000-character save limit. */
export const PATIENT_ANSWER_LIMIT = 3800;

/** The citation numbers that appear in an answer, e.g. "[2]". */
export function citedNumbers(answer: string): Set<number> {
  return new Set([...answer.matchAll(/\[(\d+)\]/g)].map(match => Number(match[1])));
}

type Cited = Pick<Evidence,'kind'|'version'|'fields'> & Partial<Pick<Evidence,'content'>>;
/** A lab placeholder for a result whose correction is not yet released: it carries no value. */
export function isCorrectionPending(source: Pick<Evidence,'kind'|'version'> & { fields?: Record<string,unknown> }): boolean {
  return source.kind === 'lab_result' && (source.fields?.correctionPending === true || source.version.includes(':pending:'));
}
/**
 * Text that states a result: the words for one, a finding ("MRDT positive",
 * "RVS non-reactive"), a test written as it is reported ("Hb 9.2", "PCV 30%"),
 * or a value with a laboratory unit ("9.2 g/dL", "5.4 mmol/L").
 */
const RESULT_TEXT = new RegExp([
  String.raw`\b(?:lab|laboratory|results?|lab_results?|test_results?|investigations?|genotype|blood[ _-]?group)\b`,
  String.raw`\b(?:positive|negative|reactive|non-reactive|detected|not detected)\b`,
  String.raw`\b(?:hb|pcv|wbc|fbs|rbs|fbc|mrdt|mp|hba1c|e\/?u\/?cr|lft|urinalysis|widal|esr|crp|ogtt|rdt)\b`,
  String.raw`\d(?:\.\d+)?\s*(?:g\/dl|mg\/dl|mmol\/l|µmol\/l|umol\/l|iu\/l|u\/l|mg\/l|g\/l|ng\/ml|miu\/ml|cells\/|\/hpf|\/µl|\/ul|%)`,
].join('|'), 'i');
/** Imported health profile fields that are results (genotype, blood group). */
const RESULT_FIELDS = /^(?:genotype|blood[_ ]?group|bloodgroup)$/i;
/**
 * Does a cited source give the patient a result? A released lab result does.
 * So does an imported health profile holding a genotype or blood group, and an
 * imported record, a scanned document or a note that states one.
 */
export function givesResult(source: Cited): boolean {
  if (source.kind === 'lab_result') return !isCorrectionPending(source);
  if (source.kind === 'health_profile' && Object.entries(source.fields ?? {})
    .some(([key, value]) => RESULT_FIELDS.test(key) && value !== null && value !== undefined && String(value).trim() !== '')) return true;
  if (['import','import_version','document','attachment','note','health_profile'].includes(source.kind)) {
    return RESULT_TEXT.test(source.content ?? JSON.stringify(source.fields ?? {}));
  }
  return false;
}
/** The server lines owed for the cited sources, each at most once, in a fixed order. */
export function patientLines(cited: readonly Cited[]): string[] {
  const lines = new Set<string>();
  if (cited.some(isCorrectionPending)) lines.add(CORRECTING_LINE);
  if (cited.some(givesResult)) lines.add(RESULT_LINE);
  if (cited.some(source => source.kind === 'diagnosis')) lines.add(DIAGNOSIS_LINE);
  return PATIENT_LINES.filter(line => lines.has(line));
}
/**
 * The lines owed by a conversation reply that follows earlier record answers:
 * the lines those answers already carried, and those implied by the sources
 * they cite (answers saved before the server added lines). Pass only the cited
 * sources' bindings, never every selected one.
 */
export function conversationLines(answers: readonly string[], bindings: readonly ContextBinding[]): string[] {
  const lines = new Set<string>(PATIENT_LINES.filter(line => answers.some(answer => answer.includes(line))));
  for (const b of bindings) {
    if (!('kind' in b)) continue;
    if (b.kind === 'lab_result') lines.add(b.version.includes(':pending:') ? CORRECTING_LINE : RESULT_LINE);
    if (b.kind === 'diagnosis') lines.add(DIAGNOSIS_LINE);
  }
  return PATIENT_LINES.filter(line => lines.has(line));
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CITES = String.raw`(?:[ \t]*\[\d+\])*`;
/**
 * A copy of a line written as a sentence of its own: at the start of the text or of a line, or after
 * another sentence's end; with any spacing or line break between its words, with or without its full stop
 * (or an exclamation mark), in bold or italics, as a list item, and with the citations written after it.
 * The same words inside a longer sentence ("Please talk to your doctor about ... means for you") are not a copy.
 */
const lineCopy = (line: string) => {
  const words = line.replace(/[.!]$/, '').trim().split(/\s+/).map(escapeRegExp).join(String.raw`\s+`);
  const start = String.raw`(?<=^|\n|[.!?:\])][ \t]*)[ \t]*(?:(?:[-*+•]|\d+[.)])[ \t]+)?(\*\*|__|\*|_)?`;
  // Ends with its stop (then a space or the end), or, without one, at the end of the text or of a line.
  const end = String.raw`(?:${CITES}(?:[.!]\1|\1[.!])${CITES}(?=\s|$)|${CITES}\1${CITES}[ \t]*(?=\n|$))`;
  return new RegExp(`${start}${words}${end}`, 'gi');
};
/**
 * Appends each line once as a final paragraph. Every copy the model wrote of
 * any of these lines (its own paragraph or sentence, in bold, as a list item,
 * or followed by a citation) is removed first, so no line repeats. A citation
 * that only a removed copy carried is kept at the end of the body.
 */
export function withPatientLines(answer: string, lines: readonly string[]): string {
  if (!lines.length) return answer;
  const paragraphs = answer.split(/\n{2,}/).map(paragraph => {
    let next = paragraph;
    for (const line of lines) next = next.replace(lineCopy(line), '');
    if (next === paragraph) return paragraph;
    return next.split('\n').map(row => row.replace(/[ \t]{2,}/g, ' ').trim()).filter(Boolean).join('\n');
  });
  let body = paragraphs.filter(paragraph => paragraph.trim()).join('\n\n').trim();
  const kept = citedNumbers(body);
  const lost = [...citedNumbers(answer)].filter(n => !kept.has(n));
  if (lost.length) body = `${body}${body ? ' ' : ''}${lost.map(n => `[${n}]`).join(' ')}`;
  return [body, ...lines].filter(Boolean).join('\n\n');
}
/** Keeps only sources whose number the answer cites, with their original numbers. */
export function citedOnly<T extends { number: number }>(sources: readonly T[], answer: string): T[] {
  const cited = citedNumbers(answer);
  return sources.filter(source => cited.has(source.number));
}
/**
 * For each saved exchange, the current bindings of the sources its answer
 * cites. Version and hash come from the stored bindings (the stored reply has
 * its hashes removed). Older rows that list every selected source keep only
 * the cited ones.
 */
export function citedFromExchanges(rows: ReadonlyArray<{ reply: ChatReply; sourceBindings: readonly EvidenceBinding[] }>): Map<string,EvidenceBinding> {
  const result = new Map<string,EvidenceBinding>();
  for (const row of rows) {
    if (row.reply.status !== 'ready' || !Array.isArray(row.reply.sources)) continue;
    const bound = new Map(row.sourceBindings.map(b => [`${b.kind}:${b.id}`, b]));
    const cited = citedNumbers(String(row.reply.answer ?? ''));
    for (const source of row.reply.sources) {
      if (!cited.has(source.number)) continue;
      const key = 'noteId' in source ? `note:${source.noteId}` : `${source.kind}:${source.id}`;
      const b = bound.get(key);
      if (b) result.set(key, b);
    }
  }
  return result;
}

/** What the patient's source viewer shows: never hash, content, raw fields or encounter ids. */
export interface PatientSourceView {
  kind: SourceKind; id: string; kindLabel: string; title: string;
  recordedAt: string | null; effectiveAt: string | null; originLabel: string; provenance: string;
  items: Array<{ label: string; value: string }>; notices: string[];
}
export const KIND_LABELS: Record<SourceKind,string> = {
  note: 'Clinic note', encounter: 'Visit', diagnosis: 'Diagnosis', prescription: 'Prescription',
  investigation: 'Test request', lab_result: 'Lab result', vital: 'Vital signs', document: 'Clinical document',
  attachment: 'Imported document', import: 'Imported history', import_version: 'Earlier version of imported history',
  health_profile: 'Imported health profile', profile: 'Age and sex',
};
const FIELD_LABELS: Record<string,string> = {
  noteType: 'Note type', text: 'Text', signedAt: 'Signed', type: 'Type', startedAt: 'Started', endedAt: 'Ended',
  status: 'Status', codeSystem: 'Code system', code: 'Code', condition: 'Condition', clinicalStatus: 'Clinical status',
  verificationStatus: 'Verification', onsetAt: 'Began', abatementAt: 'Ended', medication: 'Medicine',
  doseQuantity: 'Dose', doseUnit: 'Dose unit', route: 'Route', frequency: 'How often', startsOn: 'Starts',
  endsOn: 'Ends', test: 'Test', specimen: 'Sample', resultType: 'Result type', numericValue: 'Value',
  textValue: 'Result', unit: 'Unit', referenceRange: 'Reference range', recordedFlag: 'Flag recorded by the lab',
  revisionKind: 'Revision', collectedAt: 'Collected', releasedAt: 'Released', verification: 'Verification',
  recorded_at: 'Recorded', source: 'Source', ageYears: 'Age (years)', sex: 'Sex',
};
const label = (key: string) => FIELD_LABELS[key]
  ?? (key.replace(/[_-]+/g,' ').replace(/([a-z\d])([A-Z])/g,'$1 $2').toLowerCase().replace(/^./,c=>c.toUpperCase()));
function items(fields: Record<string,unknown>, prefix = '', depth = 0): Array<{label:string;value:string}> {
  const out: Array<{label:string;value:string}> = [];
  for (const [key,value] of Object.entries(fields)) {
    if (key.startsWith('_') || key === 'correctionPending' || value === null || value === undefined || value === '') continue;
    const name = prefix ? `${prefix}: ${label(key)}` : label(key);
    if (typeof value === 'boolean') out.push({ label: name, value: value ? 'Yes' : 'No' });
    else if (typeof value === 'string' || typeof value === 'number') out.push({ label: name, value: String(value) });
    else if (Array.isArray(value)) {
      const text = value.filter(v => v !== null && typeof v !== 'object').map(String).join(', ');
      if (text) out.push({ label: name, value: text });
      else if (depth < 2) value.forEach((v,i)=>{ if (v && typeof v === 'object') out.push(...items(v as Record<string,unknown>, `${name} ${i+1}`, depth+1)); });
    } else if (typeof value === 'object' && depth < 2) out.push(...items(value as Record<string,unknown>, name, depth + 1));
  }
  return out.slice(0, 100);
}
export function sourceView(source: Evidence): PatientSourceView {
  const pending = isCorrectionPending(source);
  const notices = patientLines([source]);
  if (source.origin === 'patient' || source.kind === 'document' || source.kind === 'attachment') notices.push(NOT_CHECKED_LINE);
  const fields = pending && source.fields.status === CORRECTING_LINE ? { ...source.fields, status: null } : source.fields;
  return { kind: source.kind, id: source.id, kindLabel: KIND_LABELS[source.kind], title: source.title,
    recordedAt: source.recordedAt, effectiveAt: source.effectiveAt, originLabel: originLabel(source.origin,'patient'),
    provenance: source.provenance, items: items(fields), notices };
}
