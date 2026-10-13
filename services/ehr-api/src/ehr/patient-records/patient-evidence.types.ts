import { createHash } from 'node:crypto';
export const SOURCE_KINDS = ['note','encounter','diagnosis','prescription','investigation','vital','import','import_version','health_profile','lab_result','attachment','document','profile'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export type RecordIntent = 'summary' | 'medications' | 'condition' | 'labs' | 'search';
export interface Evidence {
  kind: SourceKind; id: string; version: string; hash: string; title: string;
  recordedAt: string | null; effectiveAt: string | null; provenance: string;
  quality: string; fields: Record<string, unknown>; content: string;
  encounterId?:string;
}
export interface EvidenceBinding { kind: SourceKind; id: string; version: string; hash: string }
export interface EvidenceReference extends EvidenceBinding {
  number: number; title: string; recordedAt: string | null; effectiveAt: string | null;
  provenance: string; quality: string;
}
export interface Coverage { complete: boolean; unavailable: string[]; pendingDocuments: number; recordCount: number; selectedCount: number }
export interface EvidenceSnapshot { records: Evidence[]; coverage: Coverage }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function evidence(input: Omit<Evidence,'hash'|'content'>): Evidence {
  input={...input,title:input.title.slice(0,500)};
  const {_encounterId,...fields}=input.fields;
  const encounterId=typeof _encounterId==='string'?_encounterId:input.encounterId;
  input={...input,fields,...(encounterId?{encounterId}:{})};
  const content=canonical({title:input.title,recordedAt:input.recordedAt,effectiveAt:input.effectiveAt,
    provenance:input.provenance,quality:input.quality,fields:input.fields});
  return {...input,content,hash:createHash('sha256').update(canonical({content,encounterId:encounterId??null})).digest('hex')};
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
