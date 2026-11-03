import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {PoolClient} from 'pg';
import {PatientChatService} from './patient-chat.service';
import {evidence,binding,chunks,type Evidence} from './patient-evidence.types';
import {withdrawnPatientEntryChunksSql} from '../patient-entries/patient-entries.query';
jest.mock('../../config/environment',()=>({getEnvironment:()=>({AI_ENABLED:true,AI_EMBEDDING_MODEL_ID:'amazon.titan-embed-text-v2:0'})}));
// PATIENT_ENTRIES_ENABLED (0116), off unless a test turns it on.
let mockEntriesEnabled=false;
jest.mock('../patient-entries/patient-entries.flag',()=>({patientEntriesEnabled:()=>mockEntriesEnabled}));
afterEach(()=>{mockEntriesEnabled=false;});
const patientId='11111111-1111-4111-8111-111111111111';
const auth={patientId,subject:'subject-a',accountId:'account-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
const request={actor:{kind:'patient',patientId},correlationId:'synthetic-chat'} as never;
const item=(kind:Evidence['kind'],n:number,fields:Record<string,unknown>={text:'Synthetic history'})=>evidence({kind,
 id:`22222222-2222-4222-8222-${String(n).padStart(12,'0')}`,version:'1',title:`Synthetic ${kind} ${n}`,
 recordedAt:`2026-10-${String(n%28+1).padStart(2,'0')}T10:00:00Z`,effectiveAt:null,provenance:'Synthetic source',quality:'recorded',fields});
function setup(records:Evidence[]=[item('prescription',1)]) {
 const query=jest.fn(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:records[0]?.kind,source_id:records[0]?.id,chunk_no:0}]:[]}));
 const transaction=jest.fn(async(_a:unknown,_c:string,work:(c:PoolClient)=>Promise<unknown>)=>work({query} as unknown as PoolClient));
 const authorizeSelf=jest.fn().mockResolvedValue(auth),embed=jest.fn().mockResolvedValue(Array(1024).fill(0));
 const plan=jest.fn().mockResolvedValue({intent:'records',recordIntent:'medications',query:'previous and latest medication'});
 const answer=jest.fn().mockResolvedValue('The source records a prescribed medicine [1].');
 const save=jest.fn().mockResolvedValue(undefined),context=jest.fn().mockResolvedValue({exchanges:[],bindings:[]});
 const snapshot=jest.fn().mockResolvedValue({records,coverage:{complete:true,recordCount:records.length,selectedCount:0,pendingDocuments:0,unavailable:[]}});
 const assertCurrent=jest.fn().mockResolvedValue(undefined),prepareDocuments=jest.fn().mockResolvedValue([]);
 const service=new PatientChatService({withPatientTransaction:transaction} as never,{authorizeSelf} as never,{embed} as never,
  {plan,answer} as never,{recordWithClient:jest.fn()} as never,{start:jest.fn().mockResolvedValue('generation'),context,save} as never,
  {snapshot,assertCurrent,prepareDocuments} as never);
 return {service,query,transaction,authorizeSelf,embed,plan,answer,save,context,snapshot,assertCurrent,prepareDocuments};
}
describe('Patient evidence chat',()=>{
 it('bounds ranked chunks plus long literal matches and declares excerpted context',async()=>{
  const records=Array.from({length:7},(_,i)=>item('import',i+1,{text:'target '+ 'x'.repeat(i?15000:35000)}));
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'target'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?
   Array.from({length:12},(_,chunk_no)=>({source_kind:records[0]!.kind,source_id:records[0]!.id,chunk_no})):[]}));
  await s.service.answer(request,'Find target');
  const sources=s.answer.mock.calls[0][1];
  expect(sources.reduce((sum:number,r:Evidence)=>sum+r.content.length,0)).toBeLessThanOrEqual(90000);
  expect(sources.length).toBeLessThanOrEqual(12);
  expect(s.answer.mock.calls[0][4].complete).toBe(false);
 });
 it('answers latest prescription questions through current structured evidence, without depending on note/vector availability',async()=>{
  const s=setup();const reply=await s.service.answer(request,'What is my last prescription?');
  expect(s.embed).not.toHaveBeenCalled();expect(reply.sources[0]).toMatchObject({kind:'prescription'});
  expect(s.assertCurrent).toHaveBeenCalledWith(request,[binding(item('prescription',1))]);
  expect(JSON.stringify(reply.sources)).not.toContain('hash');expect(s.answer.mock.calls[0][1][0].kind).toBe('prescription');
 });
 it.each(['summary','condition','labs'])('retrieves %s evidence rather than redirecting the record question to support',async recordIntent=>{
  const s=setup([item('lab_result',1),item('diagnosis',2),item('import',3,{category:'medication'})]);
  s.plan.mockResolvedValue({intent:'records',recordIntent,query:recordIntent==='condition'?'Synthetic':'history'});
  await s.service.answer(request,'Explain my records');expect(s.snapshot).toHaveBeenCalled();expect(s.answer).toHaveBeenCalled();
 });
 it('preserves conversation context and saves inherited evidence',async()=>{
  const s=setup();const previous=[{question:'What medicine?',answer:'A recorded prescription [1].'}];
  const bindings=[binding(item('prescription',1))];s.context.mockResolvedValue({exchanges:previous,bindings});
  s.plan.mockResolvedValue({intent:'conversation',answer:'I can help you understand your records.'});
  await s.service.answer(request,'What are you?');expect(s.embed).not.toHaveBeenCalled();expect(s.prepareDocuments).not.toHaveBeenCalled();
  expect(s.plan).toHaveBeenCalledWith('What are you?',previous,expect.any(AbortSignal));expect(s.save.mock.calls[0][4]).toEqual(bindings);
 });
 it('declares incomplete selection when medication history exceeds the model context budget',async()=>{
  const s=setup(Array.from({length:75},(_,i)=>item('prescription',i+1)));
  const reply=await s.service.answer(request,'List all medicines');expect(reply.coverage).toMatchObject({complete:false,recordCount:75,selectedCount:60});
 });
 it('revalidates selected records before returning generated patient facts',async()=>{
  const s=setup();s.assertCurrent.mockRejectedValue(new Error('revoked'));
  await expect(s.service.answer(request,'Medication history')).rejects.toThrow('temporarily unavailable');expect(s.save).not.toHaveBeenCalled();
 });
 it('withholds a generated answer if history was cleared during the request',async()=>{
  const s=setup();s.save.mockRejectedValue(new Error('generation changed'));
  await expect(s.service.answer(request,'Medication')).rejects.toThrow('temporarily unavailable');
 });
 it('never retrieves patient evidence or calls a model after initial authorization fails',async()=>{
  const s=setup();s.authorizeSelf.mockRejectedValue(new Error('revoked'));
  await expect(s.service.answer(request,'Medication')).rejects.toThrow('revoked');expect(s.plan).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();
 });
 it('withholds references outside the supplied evidence',async()=>{
  const s=setup();s.answer.mockResolvedValue('Unsupported claim [99].');const reply=await s.service.answer(request,'Medicine');
  expect(reply.sources).toEqual([]);expect(reply.answer).not.toContain('Unsupported');
 });
 it('does not produce record citations for missing matching evidence',async()=>{
  const s=setup([]);s.answer.mockResolvedValue('I cannot verify a prescription from the available records.');
  expect((await s.service.answer(request,'Medicine')).sources).toEqual([]);
 });
 it('searches generalized current-source vectors and retains a patient parameter on every index operation',async()=>{
  const s=setup([item('note',1)]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'Synthetic history'});
  await s.service.answer(request,'What does this history mean?');expect(s.embed).toHaveBeenCalled();
  for(const [sql,args] of s.query.mock.calls as unknown as Array<[string,unknown[]]>)if(sql.includes('patient_evidence_chunks'))expect(args?.[0]).toBe(patientId);
 });
 it('declares an extraction availability failure instead of assuming empty documents',async()=>{
  const s=setup();s.prepareDocuments.mockResolvedValue(['Document extraction unavailable']);
  expect((await s.service.answer(request,'History')).coverage).toMatchObject({complete:false,unavailable:['Document extraction unavailable']});
 });
 it('rejects overlapping patient requests and releases admission after failure',async()=>{
  const s=setup();let release!:()=>void;s.answer.mockImplementation(()=>new Promise<string>(r=>{release=()=>r('Medicine [1].')}));
  const running=s.service.answer(request,'Medicine');await new Promise(r=>setImmediate(r));
  await expect(s.service.answer(request,'Medicine')).rejects.toThrow('wait');release();await running;
 });
 it.each(['','x'.repeat(501)])('rejects invalid question length',async q=>{await expect(setup().service.answer(request,q)).rejects.toThrow('characters');});
 it('says where each returned source came from, in the patient\'s words, and asks the model to say so too',async()=>{
  const records=[item('prescription',1),evidence({...item('import',2),originHint:'patient-provided'}),item('document',3),
   evidence({...item('note',4),originHint:'scanned_paper'})];
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});
  s.answer.mockResolvedValue('Recorded facts [1] [2] [3] [4].');
  const reply=await s.service.answer(request,'Summarise my history');
  const byId=new Map(reply.sources.map(source=>[(source as {id:string}).id,source]));
  expect(byId.get(records[0]!.id)).toMatchObject({origin:'health_worker',originLabel:'Recorded by a health worker'});
  expect(byId.get(records[1]!.id)).toMatchObject({origin:'patient',originLabel:'You added this'});
  expect(byId.get(records[2]!.id)).toMatchObject({origin:'scanned_paper',originLabel:'From a scanned paper record'});
  expect(byId.get(records[3]!.id)).toMatchObject({origin:'scanned_paper',originLabel:'From a scanned paper record'});
  expect(s.answer.mock.calls[0][5]).toBe('patient');
  // The saved reply keeps the labels for history; it still carries no hash.
  expect(s.save.mock.calls[0][3].sources[0]).toHaveProperty('originLabel');
 });
 it('labels a record the patient added as theirs: "You added this" to the patient',async()=>{
  const records=[item('patient_entry',5,{type:'medicine',place:null,date:'2026-10-01',notes:'Twice a day'}),item('prescription',6)];
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});
  s.answer.mockResolvedValue('Recorded facts [1] [2].');
  const reply=await s.service.answer(request,'Summarise my history');
  const added=reply.sources.find(source=>(source as {kind:string}).kind==='patient_entry');
  expect(added).toMatchObject({id:records[0]!.id,origin:'patient',originLabel:'You added this'});
 });
});

describe('Shared engine with explicit staff access',()=>{
 it('uses only the supplied staff evidence/history/transaction strategy, without fabricating a patient session',async()=>{
  const s=setup([item('prescription',1)]);
  const authorize=jest.fn().mockResolvedValue({...auth,subject:'staff-a',accountId:'staff-account'});
  const staffSnapshot=jest.fn().mockResolvedValue({records:[item('prescription',2)],coverage:{complete:true,recordCount:1,selectedCount:0,pendingDocuments:0,unavailable:[]}});
  const transaction=jest.fn(async(_auth:unknown,_correlation:string,work:(client:unknown)=>Promise<unknown>)=>work({query:jest.fn()}));
  const access={authorize,transaction,admissionKey:'staff:staff-account:facility-a',chunksTable:'ehr.staff_evidence_chunks',
    audit:{actorType:'staff',facilityId:'facility-a',actorMembershipId:'member-a',purposeOfUse:'direct-care'},
    evidence:{snapshot:staffSnapshot,assertCurrent:jest.fn(),prepareDocuments:jest.fn().mockResolvedValue([])},
    history:{start:jest.fn().mockResolvedValue('staff-generation'),context:s.context,save:s.save}} as never;
  const reply=await s.service.answer(request,'Latest medicine for this patient',access);
  expect(reply.sources[0]).toMatchObject({id:item('prescription',2).id,origin:'health_worker',originLabel:'Recorded by a health worker'});
  // Staff read the patient's own entries as the patient's, not as "you".
  expect(s.answer.mock.calls[0][5]).toBe('staff');
  expect(s.authorizeSelf).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();expect(transaction).toHaveBeenCalled();
 });
 it('labels a record the patient added "Added by the patient" to staff',async()=>{
  const s=setup([]);
  const added=item('patient_entry',7,{type:'test',place:'Lagoon Lab',date:'2026-10-01',notes:null});
  const staffSnapshot=jest.fn().mockResolvedValue({records:[added],coverage:{complete:true,recordCount:1,selectedCount:0,pendingDocuments:0,unavailable:[]}});
  const access={authorize:jest.fn().mockResolvedValue({...auth,subject:'staff-a',accountId:'staff-account'}),
    transaction:jest.fn(async(_auth:unknown,_correlation:string,work:(client:unknown)=>Promise<unknown>)=>work({query:jest.fn()})),
    admissionKey:'staff:staff-account:facility-b',chunksTable:'ehr.staff_evidence_chunks',
    audit:{actorType:'staff',facilityId:'facility-a',actorMembershipId:'member-a',purposeOfUse:'direct-care'},
    evidence:{snapshot:staffSnapshot,assertCurrent:jest.fn(),prepareDocuments:jest.fn().mockResolvedValue([])},
    history:{start:jest.fn().mockResolvedValue('staff-generation'),context:s.context,save:s.save}} as never;
  s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});s.answer.mockResolvedValue('Recorded fact [1].');
  const reply=await s.service.answer(request,'Summarise this patient',access);
  expect(reply.sources[0]).toMatchObject({id:added.id,kind:'patient_entry',origin:'patient',originLabel:'Added by the patient'});
 });
 it('shares the per-clinician admission key across different selected patients',async()=>{
  const s=setup();let finish!:(value:unknown)=>void;s.plan.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
  const access={authorize:async()=>auth,admissionKey:'staff:staff-a:facility-a',history:{start:async()=> 'generation',context:s.context,save:s.save}} as never;
  const first=s.service.answer(request,'First patient',access);
  while(!finish)await Promise.resolve();
  await expect(s.service.answer(request,'Other patient',access)).rejects.toMatchObject({code:'PATIENT_CHAT_RATE_LIMITED'});
  finish({intent:'conversation',answer:'I can summarize authorized records.'});await first;
 });
});

describe('Vectors of a record the patient removed (0116)',()=>{
 // Every current source already indexed: nothing new is embedded, so nothing else is refreshed.
 const indexed=(records:Evidence[])=>async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[]:
  sql.includes('select source_kind,source_id,source_version,source_hash,chunk_no')?records.flatMap(r=>chunks(r).map((_,chunk_no)=>
   ({source_kind:r.kind,source_id:r.id,source_version:r.version,source_hash:r.hash,chunk_no}))):[]});
 it('are deleted from the patient chat\'s vectors at its next search, even when nothing else is refreshed',async()=>{
  mockEntriesEnabled=true;
  const records=[item('patient_entry',3,{type:'medicine',place:null,date:'2026-10-01',notes:'Twice a day'})];
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'Twice a day'});
  s.query.mockImplementation(indexed(records));
  await s.service.answer(request,'How often do I take it?');
  expect(s.embed).toHaveBeenCalledTimes(1);
  const calls=(s.query.mock.calls as unknown as Array<[string,unknown[]]>).map(([sql,args])=>[sql.trim(),args] as const);
  const cleanup=calls.findIndex(([sql])=>sql===withdrawnPatientEntryChunksSql('ehr.patient_evidence_chunks'));
  expect(cleanup).toBeGreaterThanOrEqual(0);
  expect(calls[cleanup]![1]).toEqual([patientId]);
  expect(calls.filter(([sql])=>sql.startsWith('delete from')).length).toBe(1);
  expect(cleanup).toBeLessThan(calls.findIndex(([sql])=>sql.includes('order by embedding<=>')));
 });
 it('are deleted from the staff chat\'s vectors at its next search, for the patient in scope',async()=>{
  mockEntriesEnabled=true;
  const records=[item('patient_entry',4,{type:'test',place:'Lagoon Lab',date:'2026-10-01',notes:null})];
  const s=setup([]);
  const query=jest.fn(indexed(records));
  const access={authorize:jest.fn().mockResolvedValue({...auth,subject:'staff-a',accountId:'staff-account'}),
    transaction:jest.fn(async(_auth:unknown,_correlation:string,work:(client:unknown)=>Promise<unknown>)=>work({query})),
    admissionKey:'staff:staff-account:facility-a',chunksTable:'ehr.staff_evidence_chunks',
    audit:{actorType:'staff',facilityId:'facility-a',actorMembershipId:'member-a',purposeOfUse:'direct-care'},
    evidence:{snapshot:jest.fn().mockResolvedValue({records,coverage:{complete:true,recordCount:1,selectedCount:0,pendingDocuments:0,unavailable:[]}}),
     assertCurrent:jest.fn(),prepareDocuments:jest.fn().mockResolvedValue([])},
    history:{start:jest.fn().mockResolvedValue('staff-generation'),context:s.context,save:s.save}} as never;
  s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'Lagoon'});s.answer.mockResolvedValue('Recorded fact [1].');
  await s.service.answer(request,'Lagoon results?',access);
  const cleanup=(query.mock.calls as unknown as Array<[string,unknown[]]>).filter(([sql])=>sql.trim()===withdrawnPatientEntryChunksSql('ehr.staff_evidence_chunks'));
  expect(cleanup).toEqual([[withdrawnPatientEntryChunksSql('ehr.staff_evidence_chunks'),[patientId]]]);
 });
 it('are left alone, and the records patients add are never named, while the setting is off',async()=>{
  const records=[item('note',1)];
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'Synthetic history'});
  s.query.mockImplementation(indexed(records));
  await s.service.answer(request,'What does this history mean?');
  expect((s.query.mock.calls as unknown as Array<[string]>).some(([sql])=>/patient_entr|delete from/.test(sql))).toBe(false);
 });
 it('are deleted by the statement the database suite proves under row-level security, for both chats',()=>{
  const suite=readFileSync(resolve(__dirname,'../../../test/database/patient-entries.integration.sql'),'utf8');
  for(const table of ['ehr.patient_evidence_chunks','ehr.staff_evidence_chunks']) {
   expect(withdrawnPatientEntryChunksSql(table)).toBe(`delete from ${table} chunk where chunk.patient_id = $1 and chunk.source_kind = 'patient_entry' and not exists (select 1 from ehr.patient_entries entry where entry.id = chunk.source_id and entry.patient_id = chunk.patient_id)`);
   expect(suite).toContain(withdrawnPatientEntryChunksSql(table));
  }
 });
});
