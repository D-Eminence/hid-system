import { createHash } from 'node:crypto';
export const SOURCE_KINDS = ['note','encounter','diagnosis','prescription','investigation','vital','import','import_version','health_profile','lab_result','attachment','document','profile','patient_entry'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export type RecordIntent = 'summary' | 'medications' | 'condition' | 'labs' | 'search';

/**
 * Where a record came from, worked out by the server from the record itself,
 * never by the model: the patient added it, a health worker recorded it, it
 * was read from a scanned paper record, or it is the patient's Health ID
 * profile. It is kept out of the source's content and hash, so a source's
 * binding (saved chat history, stored embeddings) is unchanged by it.
 */
export const ORIGINS = ['patient','health_worker','scanned_paper','health_id_profile'] as const;
export type EvidenceOrigin = typeof ORIGINS[number];
/** Who reads the label: the patient about their own record, or staff about the patient's. */
export type OriginAudience = 'patient' | 'staff';
const ORIGIN_LABELS: Record<OriginAudience, Record<EvidenceOrigin, string>> = {
  patient: { patient: 'You added this', health_worker: 'Recorded by a health worker',
    scanned_paper: 'From a scanned paper record', health_id_profile: 'Your Health ID profile' },
  staff: { patient: 'Added by the patient', health_worker: 'Recorded by a health worker',
    scanned_paper: 'From a scanned paper record', health_id_profile: "The patient's Health ID profile" },
};
export function originLabel(origin: EvidenceOrigin, audience: OriginAudience = 'patient'): string {
  return ORIGIN_LABELS[audience][origin];
}
/**
 * What the evidence query knows about a row's origin beyond its kind: a
 * clinical note read from a scanned paper record ('scanned_paper'), or an
 * imported record's recorded origin ('patient-provided' | 'provider-authored',
 * CHECK in 0061).
 */
export type OriginHint = string | null | undefined;
/**
 * The origin of every source kind. An imported record counts as a health
 * worker's only when it is recorded as provider authored; anything else
 * imported is treated as the patient's, so unconfirmed information is never
 * presented as a health worker's.
 */
export function evidenceOrigin(kind: SourceKind, hint?: OriginHint): EvidenceOrigin {
  switch (kind) {
    case 'note': return hint === 'scanned_paper' ? 'scanned_paper' : 'health_worker';
    case 'encounter': case 'diagnosis': case 'prescription': case 'investigation': case 'vital': case 'lab_result':
      return 'health_worker';
    case 'import': case 'import_version': return hint === 'provider-authored' ? 'health_worker' : 'patient';
    // A record the patient added themselves (0116); no hint makes it anyone else's.
    case 'health_profile': case 'patient_entry': return 'patient';
    case 'attachment': case 'document': return 'scanned_paper';
    case 'profile': return 'health_id_profile';
    default: { const unknown: never = kind; throw new Error(`Unknown evidence kind ${String(unknown)}`); }
  }
}
export interface Evidence {
  kind: SourceKind; id: string; version: string; hash: string; title: string;
  recordedAt: string | null; effectiveAt: string | null; provenance: string;
  quality: string; fields: Record<string, unknown>; content: string;
  origin: EvidenceOrigin;
  encounterId?:string;
}
export interface EvidenceBinding { kind: SourceKind; id: string; version: string; hash: string }
export interface EvidenceReference extends EvidenceBinding {
  number: number; title: string; recordedAt: string | null; effectiveAt: string | null;
  provenance: string; quality: string;
  /** Sent by this backend on every new answer's sources; absent on answers saved before. */
  origin?: EvidenceOrigin; originLabel?: string;
}
export interface Coverage { complete: boolean; unavailable: string[]; pendingDocuments: number; recordCount: number; selectedCount: number }
export interface EvidenceSnapshot { records: Evidence[]; coverage: Coverage }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function evidence(source: Omit<Evidence,'hash'|'content'|'origin'> & { originHint?: OriginHint }): Evidence {
  const {originHint,...rest}=source;
  let input={...rest,title:rest.title.slice(0,500)};
  const {_encounterId,...fields}=input.fields;
  const encounterId=typeof _encounterId==='string'?_encounterId:input.encounterId;
  input={...input,fields,...(encounterId?{encounterId}:{})};
  const content=canonical({title:input.title,recordedAt:input.recordedAt,effectiveAt:input.effectiveAt,
    provenance:input.provenance,quality:input.quality,fields:input.fields});
  return {...input,content,origin:evidenceOrigin(input.kind,originHint),
    hash:createHash('sha256').update(canonical({content,encounterId:encounterId??null})).digest('hex')};
}
export function evidenceKey(s: Pick<EvidenceBinding,'kind'|'id'>) { return `${s.kind}:${s.id}`; }
export function binding(s: Evidence): EvidenceBinding { return {kind:s.kind,id:s.id,version:s.version,hash:s.hash}; }
export function currentBinding(input: EvidenceBinding | {noteId:string;revisionNo:number;hash:string}): EvidenceBinding {
  return 'noteId' in input ? {kind:'note',id:input.noteId,version:String(input.revisionNo),hash:input.hash} : input;
}
export function chunks(s: Evidence): string[] {
  const result:string[]=[];
  for(let offset=0;offset<s.content.length;offset+=2400) result.push(s.content.slice(offset,offset+2800));
  return result;
}
