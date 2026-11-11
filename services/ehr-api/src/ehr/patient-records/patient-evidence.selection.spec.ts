import {evidence} from './patient-evidence.types';
import {selectEvidence,decimalDifference,labComparisons,temporalOrder,withTemporalEvidence} from './patient-evidence.selection';
const record=(kind:'note'|'prescription'|'import'|'lab_result',id:string,date:string,fields:Record<string,unknown>)=>evidence({kind,id,version:'1',title:'Synthetic '+id,recordedAt:date,effectiveAt:date,provenance:'Synthetic',quality:'recorded',fields});
it('finds the latest prescription outside the former top-five note search and retains patient-reported medicine provenance',()=>{
 const older=record('prescription','old','2020-01-01',{medication:'Old medicine'}),latest=record('prescription','latest','2026-10-13',{medication:'Latest medicine'});
 const reported=record('import','reported','2024-01-01',{infoType:'medication',record:'Patient says paracetamol'});
 const selected=selectEvidence([older,...Array.from({length:55},(_,i)=>record('note',String(i),'2025-01-01',{text:'Unrelated'})),reported,latest],'medications','all medicines');
 expect(selected.sources[0]!.id).toBe('latest');expect(selected.sources.map(s=>s.id)).toEqual(expect.arrayContaining(['reported','old']));
 expect(selected.partial).toBe(false);expect(selected.sources.find(s=>s.id==='reported')!.kind).toBe('import');
});
it('orders condition mentions by recorded date and does not infer actual disease onset',()=>{
 const sources=selectEvidence([record('note','new','2026-01-01',{text:'Diabetes review'}),record('import','old','2020-01-01',{record:'Diabetes reported'}),record('note','other','2010-01-01',{text:'Unrelated'})],'condition','diabetes').sources;
 expect(sources.map(s=>s.id)).toEqual(['old','new']);
});
it('uses exact numeric changes without crossing analytes, specimens, missing units or mismatched units',()=>{
 const fields={codeSystem:'loinc',code:'synthetic-analyte',specimen:'blood',unit:'mg/dL'};
 const sources=[record('lab_result','a','2026-01-01',{...fields,numericValue:'120.10'}),record('lab_result','b','2026-02-01',{...fields,numericValue:'100.05'}),record('lab_result','c','2026-03-01',{...fields,unit:'mmol/L',numericValue:'5.1'}),record('lab_result','d','2026-04-01',{...fields,specimen:'urine',numericValue:'42'})];
 expect(labComparisons(sources)).toEqual([{previousReference:1,currentReference:2,change:'-20.05',unit:'mg/dL'}]);
 expect(decimalDifference('0.3','0.1')).toBe('0.2');expect(decimalDifference('x','1')).toBeNull();
});
it('chunks/truncates long histories with an explicit partial-coverage flag rather than asserting a complete answer',()=>{
 const selected=selectEvidence([record('note','long','2026-01-01',{text:'x'.repeat(80000)})],'summary','history');
 expect(selected.sources).toHaveLength(1);expect(selected.partial).toBe(true);expect(selected.sources[0]!.content).toContain('truncated');
});
describe('dated questions (first, earliest, latest)',()=>{
 const diagnosis=(id:string,date:string,condition:string)=>evidence({kind:'diagnosis',id,version:'1',title:condition,recordedAt:date,effectiveAt:date,
  provenance:'Clinician recorded condition',quality:'confirmed',fields:{condition,clinicalStatus:'active',verificationStatus:'confirmed'}});
 it('finds diagnoses for "first diagnosis" although no record contains the word "diagnosis"',()=>{
  const records=[diagnosis('new','2026-09-21','Iron deficiency anaemia'),diagnosis('old','2019-03-02','Synthetic asthma'),record('note','n','2018-01-01',{text:'Unrelated visit'})];
  const sources=selectEvidence(records,'condition','person first diagnosis').sources;
  expect(sources.map(s=>s.id)).toEqual(['old','new']);
 });
 it('reads the whole permitted record, oldest first, when a named condition matches nothing',()=>{
  const sources=selectEvidence([record('note','b','2026-01-01',{text:'Visit'}),record('note','a','2020-01-01',{text:'Visit'})],'condition','synthetic gout').sources;
  expect(sources.map(s=>s.id)).toEqual(['a','b']);
 });
 it.each([['What was this person first diagnosis','earliest'],['When did the asthma start?','earliest'],['latest prescription','latest'],
  ['Show the history of visits','timeline'],['What does this result say?',null]])('reads %j as %j',(question,order)=>{
  expect(temporalOrder(question)).toBe(order);
 });
 it('adds the earliest and latest diagnoses from the given records only, earliest first, on top of a search selection',()=>{
  const many=Array.from({length:40},(_,i)=>diagnosis(`d${String(i).padStart(2,'0')}`,`${2000+i}-01-01`,'Synthetic condition '+i));
  const searched=[record('note','hit','2026-10-01',{text:'Synthetic match'})];
  const result=withTemporalEvidence(many,searched,'what was the first diagnosis',false);
  expect(result.order).toBe('earliest');
  expect(result.sources[0]!.id).toBe('d00');expect(result.sources.slice(0,10).map(s=>s.id)).toEqual(many.slice(0,10).map(s=>s.id));
  expect(result.sources.map(s=>s.id)).toEqual(expect.arrayContaining(['d39','hit']));
  // Only records the reader was already allowed to read: nothing outside `many` and `searched`.
  const allowed=new Set([...many,...searched].map(s=>s.id));
  expect(result.sources.every(s=>allowed.has(s.id))).toBe(true);
  expect(result.sources).toHaveLength(21);
  // Not every dated record was read, so the answer must not claim a complete history.
  expect(result.partial).toBe(true);
 });
 it('puts the newest first for "latest" and leaves other questions unchanged',()=>{
  const records=[diagnosis('a','2001-01-01','A'),diagnosis('b','2024-01-01','B')];
  expect(withTemporalEvidence(records,[],'my latest diagnosis',false).sources.map(s=>s.id)).toEqual(['b','a']);
  const plain=withTemporalEvidence(records,[records[0]!],'what does it mean',false);
  expect(plain).toEqual({sources:[records[0]],partial:false,order:null});
 });
});
