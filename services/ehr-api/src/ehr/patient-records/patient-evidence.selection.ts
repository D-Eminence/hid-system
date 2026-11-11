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
      // A named condition that matches nothing gives an empty selection, so the answer says plainly that nothing
      // was found (the NONE prompt) instead of citing unrelated records. Only a general question ("first
      // diagnosis") is matched by the kind of record, so it never ends up empty while diagnoses exist.
      candidates=candidates.filter(r=>matched.includes(r)||r.encounterId&&encounters.has(r.encounterId));
    }
  }
  const recorded=(r:Evidence)=>Date.parse(r.recordedAt??'')||0;
  candidates.sort((a,b)=>intent==='condition'?recorded(a)-recorded(b):intent==='medications'?recorded(b)-recorded(a):time(b)-time(a));
  return boundEvidence(candidates);
}
export type TemporalOrder='earliest'|'latest'|'timeline';
/** Words for something in a health record: an order word ("first", "latest") counts only next to one of these. */
const CLINICAL=String.raw`(?:diagnos\w*|conditions?|illness\w*|diseases?|problems?|medic\w*|drugs?|prescri\w*|tablets?|pills?|doses?|labs?|laborator\w*|tests?|results?|investigations?|scans?|x-?rays?|blood\w*|visits?|appointments?|encounters?|admissions?|vaccin\w*|immuni[sz]\w*|allerg\w*|symptoms?|treatments?|operations?|surger\w*|notes?|documents?|reports?|readings?|infections?)`;
/** Up to three words between the order word and the clinical word ("first recorded malaria diagnosis"). */
const near=(order:string)=>new RegExp(String.raw`\b${order}\b(?:\s+[\p{L}\p{N}'-]+){0,3}?\s+${CLINICAL}\b|\b${CLINICAL}\b(?:\s+[\p{L}\p{N}'-]+){0,3}?\s+${order}\b`,'u');
const EARLIEST=near('(?:first|earliest|oldest|initial)'),LATEST=near('(?:last|latest|most recent|newest|recent|current)'),
  TIMELINE=near('(?:history|timeline|over time|over the years|so far)');
/**
 * A question asking for the first or the latest item, or for a history over time. "When did it start",
 * "since when" and "how long ago" always ask for the earliest; "first", "latest" and the like only next to a
 * clinical word, so "what is my first name" or "my current address" are not dated questions.
 */
export function temporalOrder(question:string):TemporalOrder|null {
  const q=question.toLowerCase();
  if(/\b(?:originally|began|begin|start(?:ed|s)?|since when|how long ago)\b/.test(q)||EARLIEST.test(q))return 'earliest';
  if(LATEST.test(q))return 'latest';
  if(TIMELINE.test(q))return 'timeline';
  return null;
}
/**
 * Which record kinds a dated question is about: diagnoses, medicines, results or visits. A question about
 * anything else gets no extra records: its normal selection is only put in date order.
 */
function temporalKinds(question:string):((r:Evidence)=>boolean)|null {
  const q=question.toLowerCase();
  if(/\b(?:medic\w*|drugs?|prescri\w*|tablets?|pills?|doses?)\b/.test(q))return medication;
  if(/\b(?:labs?|laborator\w*|tests?|results?|investigations?|scans?|x-?rays?|blood)\b/.test(q))return labs;
  if(/\b(?:diagnos\w*|conditions?|illness\w*|diseases?|problems?|sick\w*|ill)\b/.test(q))return conditionRecord;
  if(/\b(?:visits?|appointments?|encounters?|admissions?)\b/.test(q))return r=>r.kind==='encounter';
  return null;
}
/** How many records from each end of the dated list, and how much text they may take: the normal selection always comes first. */
const TEMPORAL_EACH=6,TEMPORAL_CHARS=25_000;
const MAX_SOURCES=60,MAX_CHARS=90_000;
/**
 * For a dated question ("what was the first diagnosis", "latest prescription", "history of visits"): the
 * normal selection, plus the earliest and latest records of the kind asked about, chosen only from
 * `records`, which is the reader's already-authorized snapshot, so this never widens what may be read.
 * The extra records only use room the selection left, within their own small budget, so they never push
 * out the records that answer the question. A history question adds nothing. Everything is then sent
 * strictly in date order: earliest first, or newest first for "latest"; records without a date go last.
 */
export function withTemporalEvidence(records:readonly Evidence[],selected:readonly Evidence[],question:string,partial:boolean,searchQuestion=''):{sources:Evidence[];partial:boolean;order:TemporalOrder|null} {
  // The reader's own words decide the order; the planner's standalone question is read only when they say nothing about it.
  const order=temporalOrder(question)??temporalOrder(searchQuestion);
  if(!order)return {sources:[...selected],partial,order};
  const kinds=order==='timeline'?null:temporalKinds(question+'\n'+searchQuestion);
  const key=(r:Evidence)=>r.kind+':'+r.id;
  const seen=new Set(selected.map(key));
  let extra:Evidence[]=[];let extraPartial=false;
  if(kinds) {
    const dated=records.filter(kinds).filter(r=>time(r)>0).sort((a,b)=>time(a)-time(b));
    const earliest=dated.slice(0,TEMPORAL_EACH),latest=dated.slice(-TEMPORAL_EACH).reverse();
    const picks:Evidence[]=[];
    for(const r of order==='latest'?[...latest,...earliest]:[...earliest,...latest]){if(seen.has(key(r)))continue;seen.add(key(r));picks.push(r);}
    const used=selected.reduce((sum,r)=>sum+r.content.length,0);
    const bounded=boundEvidence(picks,Math.max(0,MAX_SOURCES-selected.length),Math.min(TEMPORAL_CHARS,Math.max(0,MAX_CHARS-used)));
    // Incomplete only when a record from the end asked about could not be read in full.
    const asked=new Set((order==='latest'?latest:earliest).map(key));
    extraPartial=picks.some(r=>asked.has(key(r))&&!bounded.sources.some(s=>key(s)===key(r)&&s.content===r.content));
    extra=bounded.sources;
  }
  const direction=order==='latest'?-1:1;
  const sources=[...extra,...selected].sort((a,b)=>{const ta=time(a),tb=time(b);if(!ta||!tb)return (ta?0:1)-(tb?0:1);return direction*(ta-tb);});
  return {sources,partial:partial||extraPartial,order};
}
export function boundEvidence(candidates:readonly Evidence[],maxSources=MAX_SOURCES,maxChars=MAX_CHARS):{sources:Evidence[];partial:boolean} {
  const sources:Evidence[]=[];let chars=0;let partial=false;
  for(const r of candidates) {
    const text=r.content.length>12000?r.content.slice(0,12000)+'\n[Source excerpt truncated]':r.content;
    if(sources.length>=maxSources||chars+text.length>maxChars){partial=true;continue;}
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
