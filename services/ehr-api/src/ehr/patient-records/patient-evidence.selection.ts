import type { Evidence,RecordIntent,Coverage } from './patient-evidence.types';
const time=(r:Evidence)=>Date.parse(r.effectiveAt??r.recordedAt??'')||0;
const medication=(r:Evidence)=>r.kind==='prescription'||r.kind==='health_profile'||r.kind==='note'||r.kind==='document'||r.kind==='attachment'||r.kind==='import_version'
  ||(r.kind==='import'&&/medication|prescription|drug/.test(JSON.stringify(r.fields).toLowerCase()));
const labs=(r:Evidence)=>['lab_result','investigation','document','attachment','import_version'].includes(r.kind)
  ||(r.kind==='note'&&/lab|laboratory|result|investigation/.test(r.content.toLowerCase()))
  ||(r.kind==='import'&&/lab|laboratory|test_result/.test(JSON.stringify(r.fields).toLowerCase()));
const stop=new Set('the a an my this patient what when was is were has have had are and or of for in to most last latest recent recorded previously condition related appear records its it all history medical please summarise summarize explain first'.split(' '));
/** Words that ask for diagnoses in general rather than a named condition: matched by the kind of record, not by its text. */
const generic=new Set('diagnosis diagnoses diagnosed diagnose conditions illness illnesses problem problems disease diseases sickness ailment ailments earliest oldest initial ever person persons patients their his her they them did start started begin began'.split(' '));
/** A record that states a diagnosis or condition: a recorded diagnosis, or an imported record about one. */
const conditionRecord=(r:Evidence)=>r.kind==='diagnosis'
  ||((r.kind==='import'||r.kind==='import_version'||r.kind==='health_profile')&&/diagnos|condition|problem|illness|disease/.test(JSON.stringify(r.fields).toLowerCase()));
export function selectEvidence(records:readonly Evidence[],intent:RecordIntent,query:string):{sources:Evidence[];partial:boolean} {
  let candidates=[...records];
  if(intent==='medications')candidates=candidates.filter(medication);
  if(intent==='labs')candidates=candidates.filter(labs);
  if(intent==='condition') {
    const words=query.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    const terms=words.filter(t=>t.length>2&&!stop.has(t)&&!generic.has(t));
    const general=words.some(t=>generic.has(t)||t==='condition');
    if(terms.length||general) {
      const matched=candidates.filter(r=>terms.some(t=>r.content.toLowerCase().includes(t))||(general&&!terms.length&&conditionRecord(r)));
      const encounters=new Set(matched.map(r=>r.encounterId).filter(Boolean));
      // No match is no reason to answer from nothing: the whole permitted record is read, oldest first.
      if(matched.length)candidates=candidates.filter(r=>matched.includes(r)||r.encounterId&&encounters.has(r.encounterId));
    }
  }
  const recorded=(r:Evidence)=>Date.parse(r.recordedAt??'')||0;
  candidates.sort((a,b)=>intent==='condition'?recorded(a)-recorded(b):intent==='medications'?recorded(b)-recorded(a):time(b)-time(a));
  return boundEvidence(candidates);
}
export type TemporalOrder='earliest'|'latest'|'timeline';
/** A question asking for the first or the latest item, or for a history over time. */
export function temporalOrder(question:string):TemporalOrder|null {
  const q=question.toLowerCase();
  if(/\b(?:first|earliest|oldest|initial|originally|began|begin|start(?:ed|s)?|since when|how long ago)\b/.test(q))return 'earliest';
  if(/\b(?:last|latest|most recent|newest|recently|current(?:ly)?)\b/.test(q))return 'latest';
  if(/\b(?:history|timeline|over time|over the years|so far|ever)\b/.test(q))return 'timeline';
  return null;
}
/** Which record kinds a dated question is about: diagnoses, medicines, results, or anything clinical. */
function temporalKinds(question:string):(r:Evidence)=>boolean {
  const q=question.toLowerCase();
  if(/\b(?:medic\w*|drugs?|prescri\w*|tablets?|pills?|doses?)\b/.test(q))return medication;
  if(/\b(?:labs?|laborator\w*|tests?|results?|investigations?|scans?|x-?rays?|blood)\b/.test(q))return labs;
  if(/\b(?:diagnos\w*|conditions?|illness\w*|diseases?|problems?|sick\w*|ill)\b/.test(q))
    return r=>conditionRecord(r)||r.kind==='encounter'||r.kind==='note'||r.kind==='document'||r.kind==='attachment';
  return r=>r.kind!=='profile'&&r.kind!=='vital';
}
const TEMPORAL_EACH=10;
/**
 * For a dated question ("what was the first diagnosis", "latest prescription", "history of ..."):
 * the earliest and latest records of the kinds asked about, chosen only from `records`, which is the
 * reader's already-authorized snapshot, so this never widens what may be read. The dated records come
 * first, in the order asked for, then the normal selection; repeats are dropped and the usual limits apply.
 */
export function withTemporalEvidence(records:readonly Evidence[],selected:readonly Evidence[],question:string,partial:boolean,searchQuestion=''):{sources:Evidence[];partial:boolean;order:TemporalOrder|null} {
  // The reader's own words decide the order; the planner's standalone question is read only when they say nothing about it.
  const order=temporalOrder(question)??temporalOrder(searchQuestion);
  if(!order)return {sources:[...selected],partial,order};
  const dated=records.filter(temporalKinds(question+'\n'+searchQuestion)).filter(r=>time(r)>0).sort((a,b)=>time(a)-time(b));
  const earliest=dated.slice(0,TEMPORAL_EACH),latest=dated.slice(-TEMPORAL_EACH).reverse();
  const first=order==='latest'?[...latest,...earliest]:[...earliest,...latest];
  const seen=new Set<string>();const merged:Evidence[]=[];
  for(const r of [...first,...selected]){const key=r.kind+':'+r.id;if(seen.has(key))continue;seen.add(key);merged.push(r);}
  const bounded=boundEvidence(merged);
  return {sources:bounded.sources,partial:partial||bounded.partial||dated.length>2*TEMPORAL_EACH,order};
}
export function boundEvidence(candidates:readonly Evidence[],maxSources=60):{sources:Evidence[];partial:boolean} {
  const sources:Evidence[]=[];let chars=0;let partial=false;
  for(const r of candidates) {
    const text=r.content.length>12000?r.content.slice(0,12000)+'\n[Source excerpt truncated]':r.content;
    if(sources.length>=maxSources||chars+text.length>90_000){partial=true;continue;}
    if(text!==r.content)partial=true;
    sources.push({...r,content:text});chars+=text.length;
  }
  return {sources,partial};
}
// Exact decimal arithmetic; retain original units and do not silently convert.
export function decimalDifference(a:string,b:string):string|null {
  if(!/^-?\d{1,40}(\.\d{1,20})?$/.test(a)||!/^-?\d{1,40}(\.\d{1,20})?$/.test(b))return null;
  const digits=Math.max(a.split('.')[1]?.length??0,b.split('.')[1]?.length??0);
  const scaled=(v:string)=>{const [whole,fraction='']=v.split('.');const sign=v.startsWith('-')?-1n:1n;
    return sign*BigInt((whole??'0').replace('-','')+fraction.padEnd(digits,'0'));};
  const value=scaled(a)-scaled(b);const sign=value<0n?'-':'';const text=(value<0n?-value:value).toString().padStart(digits+1,'0');
  return digits?sign+(text.slice(0,-digits)+'.'+text.slice(-digits)).replace(/\.?0+$/,''):sign+text;
}
export function labComparisons(sources:readonly Evidence[]) {
  const groups=new Map<string,Array<{source:Evidence;number:number}>>();
  sources.forEach((source,i)=>{
    if(source.kind!=='lab_result'||!source.effectiveAt||!source.fields.unit||!source.fields.specimen||!source.fields.code||!source.fields.codeSystem)return;
    const key=JSON.stringify([source.fields.codeSystem,source.fields.code,source.fields.specimen,source.fields.unit]);
    const group=groups.get(key)??[];group.push({source,number:i+1});groups.set(key,group);
  });
  const changes:Array<{previousReference:number;currentReference:number;change:string;unit:unknown}>=[];
  for(const group of groups.values()) {
    group.sort((a,b)=>time(a.source)-time(b.source));
    for(let i=1;i<group.length;i++) {
      const previous=group[i-1]!,current=group[i]!;
      if(time(previous.source)===time(current.source))continue;
      const delta=decimalDifference(String(current.source.fields.numericValue),String(previous.source.fields.numericValue));
      if(delta!==null)changes.push({previousReference:previous.number,currentReference:current.number,change:delta,unit:current.source.fields.unit});
    }
  }
  return changes;
}
export function answerCoverage(base:Coverage,selected:number,partial:boolean):Coverage {
  return {...base,complete:base.complete&&!partial,selectedCount:selected};
}
