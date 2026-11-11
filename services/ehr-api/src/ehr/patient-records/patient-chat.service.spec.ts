import type {PoolClient} from 'pg';
import {withPatientLines} from './patient-chat-safety';
import {Logger} from '@nestjs/common';
import {ClaudeCallError} from './claude-ai.service';
import {PatientChatService} from './patient-chat.service';
import {evidence,binding,type Evidence} from './patient-evidence.types';
import {patientEvidence} from './patient-evidence.policy';
jest.mock('../../config/environment',()=>({getEnvironment:()=>({AI_ENABLED:true,AI_EMBEDDING_MODEL_ID:'amazon.titan-embed-text-v2:0'})}));
const patientId='11111111-1111-4111-8111-111111111111';
const auth={patientId,subject:'subject-a',accountId:'account-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
const request={actor:{kind:'patient',patientId},correlationId:'synthetic-chat'} as never;
const item=(kind:Evidence['kind'],n:number,fields:Record<string,unknown>={text:'Synthetic history'})=>evidence({kind,
 id:`22222222-2222-4222-8222-${String(n).padStart(12,'0')}`,version:'1',title:`Synthetic ${kind} ${n}`,
 recordedAt:`2026-10-${String(n%28+1).padStart(2,'0')}T10:00:00Z`,effectiveAt:null,provenance:'Synthetic source',quality:'recorded',fields});
function setup(records:Evidence[]=[item('prescription',1)]) {
 const query=jest.fn(async(sql:string,_params?:unknown[])=>({rows:sql.includes('order by embedding<=>')?[{source_kind:records[0]?.kind,source_id:records[0]?.id,chunk_no:0}]:[]}));
 const transaction=jest.fn(async(_a:unknown,_c:string,work:(c:PoolClient)=>Promise<unknown>)=>work({query} as unknown as PoolClient));
 const authorizeSelf=jest.fn().mockResolvedValue(auth),embed=jest.fn().mockResolvedValue(Array(1024).fill(0));
 const plan=jest.fn().mockResolvedValue({intent:'records',recordIntent:'medications',query:'previous and latest medication'});
 const answer=jest.fn().mockResolvedValue('The source records a prescribed medicine [1].');
 const save=jest.fn().mockResolvedValue(undefined),context=jest.fn().mockResolvedValue({exchanges:[],bindings:[]});
 const snapshot=jest.fn().mockResolvedValue({records,coverage:{complete:true,recordCount:records.length,selectedCount:0,pendingDocuments:0,unavailable:[]}});
 const assertCurrent=jest.fn().mockResolvedValue(undefined),prepareDocuments=jest.fn().mockResolvedValue([]);
 // Fictional identity, used by the server only to clean the patient's own question.
 const redactionProfile=jest.fn().mockResolvedValue({patientId,firstName:'Adaeze',lastName:'Okafor',fullName:'Adaeze Okafor',dateOfBirth:'1990-03-12',gender:'female'});
 const service=new PatientChatService({withPatientTransaction:transaction} as never,{authorizeSelf} as never,{embed} as never,
  {plan,answer} as never,{recordWithClient:jest.fn()} as never,{start:jest.fn().mockResolvedValue('generation'),context,save} as never,
  {snapshot,assertCurrent,prepareDocuments,redactionProfile} as never);
 return {service,query,transaction,authorizeSelf,embed,plan,answer,save,context,snapshot,assertCurrent,prepareDocuments,redactionProfile};
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
  expect(s.plan).toHaveBeenCalledWith('What are you?',previous,expect.any(AbortSignal),'patient');expect(s.save.mock.calls[0][4]).toEqual(bindings);
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
});

describe('Shared engine with explicit staff access',()=>{
 it('uses only the supplied staff evidence/history/transaction strategy, without fabricating a patient session',async()=>{
  const s=setup([item('prescription',1)]);
  const authorize=jest.fn().mockResolvedValue({...auth,subject:'staff-a',accountId:'staff-account'});
  const staffSnapshot=jest.fn().mockResolvedValue({records:[item('prescription',2)],coverage:{complete:true,recordCount:1,selectedCount:0,pendingDocuments:0,unavailable:[]}});
  const transaction=jest.fn(async(_auth:unknown,_correlation:string,work:(client:unknown)=>Promise<unknown>)=>work({query:jest.fn()}));
  const access={audience:'staff',authorize,transaction,admissionKey:'staff:staff-account:facility-a',chunksTable:'ehr.staff_evidence_chunks',
    audit:{actorType:'staff',facilityId:'facility-a',actorMembershipId:'member-a',purposeOfUse:'direct-care'},
    evidence:{snapshot:staffSnapshot,assertCurrent:jest.fn(),prepareDocuments:jest.fn().mockResolvedValue([])},
    history:{start:jest.fn().mockResolvedValue('staff-generation'),context:s.context,save:s.save}} as never;
  const reply=await s.service.answer(request,'Latest medicine for this patient',access);
  expect(reply.sources[0]).toMatchObject({id:item('prescription',2).id,origin:'health_worker',originLabel:'Recorded by a health worker'});
  // Staff read the patient's own entries as the patient's, not as "you".
  expect(s.answer.mock.calls[0][5]).toBe('staff');
  expect(s.authorizeSelf).not.toHaveBeenCalled();expect(s.snapshot).not.toHaveBeenCalled();expect(transaction).toHaveBeenCalled();
 });
 it('shares the per-clinician admission key across different selected patients',async()=>{
  const s=setup();let finish!:(value:unknown)=>void;s.plan.mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
  const access={audience:'staff',audit:{actorType:'staff'},authorize:async()=>auth,admissionKey:'staff:staff-a:facility-a',history:{start:async()=> 'generation',context:s.context,save:s.save}} as never;
  const first=s.service.answer(request,'First patient',access);
  while(!finish)await Promise.resolve();
  await expect(s.service.answer(request,'Other patient',access)).rejects.toMatchObject({code:'PATIENT_CHAT_RATE_LIMITED'});
  finish({intent:'conversation',answer:'I can summarize authorized records.'});await first;
 });
});

// PR 1 patient-chat safeguards (fictional data only).
const LAB=evidence({kind:'lab_result',id:'33333333-3333-4333-8333-000000000001',version:'2',title:'Haemoglobin',
 recordedAt:'2026-10-05T10:00:00Z',effectiveAt:'2026-10-05T09:00:00Z',provenance:'Released laboratory result',quality:'verified and released',
 fields:{test:'Haemoglobin',numericValue:'12.5',unit:'g/dL',specimen:'Blood'}});
const PENDING=evidence({kind:'lab_result',id:'33333333-3333-4333-8333-000000000002',version:'3:pending:44444444-4444-4444-8444-000000000001',
 title:'Fasting glucose',recordedAt:'2026-10-04T10:00:00Z',effectiveAt:null,provenance:'Released laboratory result',quality:'verified and released',
 fields:{test:'Fasting glucose',correctionPending:true,status:'The lab is correcting this result.'}});
const DIAGNOSIS=evidence({kind:'diagnosis',id:'33333333-3333-4333-8333-000000000003',version:'1',title:'Hypertension',
 recordedAt:'2026-09-01T10:00:00Z',effectiveAt:null,provenance:'Clinician recorded condition',quality:'confirmed',
 fields:{condition:'Hypertension',verificationStatus:'confirmed'}});
const RX=item('prescription',1);
const RESULT_LINE='Talk to your doctor about what this result means.';
const DIAGNOSIS_LINE='Talk to your doctor about what this diagnosis means.';
const CORRECTING_LINE='The lab is correcting this result.';
const count=(text:string,part:string)=>text.split(part).length-1;
const staffAccess=(s:ReturnType<typeof setup>,records:Evidence[])=>({audience:'staff',
 authorize:jest.fn().mockResolvedValue({...auth,subject:'staff-a',accountId:'staff-account'}),
 transaction:jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query:s.query})),
 admissionKey:'staff:staff-account:facility-a',chunksTable:'ehr.staff_evidence_chunks',
 audit:{actorType:'staff',facilityId:'facility-a',actorMembershipId:'member-a',purposeOfUse:'direct-care'},
 evidence:{snapshot:jest.fn().mockResolvedValue({records,coverage:{complete:true,recordCount:records.length,selectedCount:0,pendingDocuments:0,unavailable:[]}}),
  assertCurrent:jest.fn(),prepareDocuments:jest.fn().mockResolvedValue([])},
 history:{start:jest.fn().mockResolvedValue('staff-generation'),context:s.context,save:s.save}}) as never;
function summary(records:Evidence[],answer:string) {
 const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});s.answer.mockResolvedValue(answer);return s;
}
const numberOf=(s:ReturnType<typeof setup>,record:Evidence)=>(s.answer.mock.calls[0][1] as Evidence[]).findIndex(r=>r.id===record.id)+1;

describe('B1 server-added lines on patient answers',()=>{
 it('adds the result line exactly once, as the final paragraph, when a lab result is cited, and still answers normally',async()=>{
  const s=summary([LAB,RX],'');s.answer.mockImplementation(async(_q:string,sources:Evidence[])=>
   `Your haemoglobin was recorded as 12.5 g/dL [${sources.findIndex(r=>r.id===LAB.id)+1}].`);
  const reply=await s.service.answer(request,'What was my last blood test?');
  expect(reply.status).toBe('ready');expect(count(reply.answer,RESULT_LINE)).toBe(1);
  expect(reply.answer.endsWith('\n\n'+RESULT_LINE)).toBe(true);expect(reply.answer).not.toContain(DIAGNOSIS_LINE);
  expect(reply.sources.map(r=>(r as {id:string}).id)).toEqual([LAB.id]);
  expect(s.save.mock.calls[0][3].answer).toBe(reply.answer);
 });
 it('does not repeat a line the model wrote itself as a paragraph',async()=>{
  const s=summary([LAB],'Haemoglobin 12.5 g/dL [1].\n\n'+RESULT_LINE);
  expect(count((await s.service.answer(request,'Blood test?')).answer,RESULT_LINE)).toBe(1);
 });
 it('adds the diagnosis line when a diagnosis is cited',async()=>{
  const s=summary([DIAGNOSIS],'A confirmed diagnosis of hypertension is recorded [1].');
  const reply=await s.service.answer(request,'Do I have hypertension?');
  expect(reply.answer).toContain(DIAGNOSIS_LINE);expect(reply.answer).not.toContain(RESULT_LINE);expect(reply.sources).toHaveLength(1);
 });
 it('adds "The lab is correcting this result." for a cited placeholder, with no result line and no value',async()=>{
  const s=summary([PENDING],'Your fasting glucose result is being corrected by the lab [1].');
  const reply=await s.service.answer(request,'What was my glucose?');
  expect(count(reply.answer,CORRECTING_LINE)).toBe(1);expect(reply.answer).not.toContain(RESULT_LINE);
  expect(reply.sources[0]).toMatchObject({kind:'lab_result',version:PENDING.version});
 });
 it('adds every owed line once, in a fixed order, when several kinds are cited',async()=>{
  const s=summary([LAB,PENDING,DIAGNOSIS],'');
  s.answer.mockImplementation(async(_q:string,sources:Evidence[])=>`Recorded facts ${sources.map((_,i)=>`[${i+1}]`).join(' ')}.`);
  const reply=await s.service.answer(request,'Summarise');
  expect(reply.answer.split('\n\n').slice(-3)).toEqual([CORRECTING_LINE,RESULT_LINE,DIAGNOSIS_LINE]);
 });
 it('adds nothing when nothing is cited, when no evidence exists, and to the NO_GROUNDED_ANSWER reply',async()=>{
  const none=setup([]);none.answer.mockResolvedValue('I cannot find a lab result in your records.');
  const empty=await none.service.answer(request,'Any lab results?');
  expect(empty.answer).toBe('I cannot find a lab result in your records.');expect(empty.sources).toEqual([]);
  const invalid=summary([LAB,DIAGNOSIS],'Unsupported claim [99].');
  const reply=await invalid.service.answer(request,'Blood test?');
  expect(reply.answer).toBe('I could not verify an answer from the available records.');expect(reply.sources).toEqual([]);
 });
 it('gives staff replies no added lines',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});
  s.answer.mockResolvedValue('Recorded results [1] [2] [3].');
  const reply=await s.service.answer(request,'Latest results',staffAccess(s,[LAB,DIAGNOSIS,PENDING]));
  expect(reply.answer).toBe('Recorded results [1] [2] [3].');expect(reply.sources).toHaveLength(3);
  for(const line of [RESULT_LINE,DIAGNOSIS_LINE,CORRECTING_LINE])expect(reply.answer).not.toContain(line);
 });
 it('keeps a 3800-character answer plus every line within the 4000-character save limit',async()=>{
  const s=summary([LAB,PENDING,DIAGNOSIS],'');
  s.answer.mockImplementation(async()=>{const tail=' [1] [2] [3]';return 'x'.repeat(3800-tail.length)+tail;});
  const reply=await s.service.answer(request,'Summarise');
  expect(s.answer.mock.calls[0][1]).toHaveLength(3);
  expect(reply.answer.length).toBeLessThanOrEqual(4000);for(const line of [RESULT_LINE,DIAGNOSIS_LINE,CORRECTING_LINE])expect(count(reply.answer,line)).toBe(1);
 });
 it('adds the result line to a conversation reply that follows an answer about a result, and nothing after other answers',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'You are welcome.'});
  s.context.mockResolvedValue({exchanges:[{question:'Blood test?',answer:'Haemoglobin 12.5 g/dL [1].\n\n'+RESULT_LINE}],bindings:[binding(LAB)]});
  const after=await s.service.answer(request,'Thanks');
  expect(after).toMatchObject({status:'ready',sources:[]});expect(after.answer).toBe('You are welcome.\n\n'+RESULT_LINE);
  const plain=setup();plain.plan.mockResolvedValue({intent:'conversation',answer:'Hello. How can I help?'});
  plain.context.mockResolvedValue({exchanges:[{question:'Medicine?',answer:'A prescription [1].'}],bindings:[binding(RX)]});
  expect((await plain.service.answer(request,'Hello')).answer).toBe('Hello. How can I help?');
 });
});

describe('B2 cited-only patient sources',()=>{
 it('returns only cited sources with their original numbers, and still binds saved history to every selected source',async()=>{
  const s=summary([RX,LAB,DIAGNOSIS],'');
  s.answer.mockImplementation(async(_q:string,sources:Evidence[])=>`A prescribed medicine is recorded [${sources.findIndex(r=>r.id===RX.id)+1}].`);
  const reply=await s.service.answer(request,'What medicine?');
  const rxNumber=numberOf(s,RX);
  expect(reply.sources).toEqual([expect.objectContaining({kind:'prescription',id:RX.id,number:rxNumber})]);
  expect(reply.answer).not.toContain(RESULT_LINE);expect(reply.answer).not.toContain(DIAGNOSIS_LINE);
  expect(s.save.mock.calls[0][3].sources).toHaveLength(1);
  expect(s.save.mock.calls[0][4]).toEqual(expect.arrayContaining([binding(RX),binding(LAB),binding(DIAGNOSIS)]));
 });
 it('leaves staff sources listing every selected source',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'records',recordIntent:'summary',query:'history'});
  s.answer.mockResolvedValue('A prescribed medicine is recorded [1].');
  const reply=await s.service.answer(request,'All records',staffAccess(s,[RX,LAB,DIAGNOSIS]));
  expect(reply.sources).toHaveLength(3);expect(s.save.mock.calls[0][4]).toEqual([]);
 });
});

describe('B3 Bedrock never receives the profile',()=>{
 it('does not embed the profile (name or date of birth) and still answers from the remaining sources',async()=>{
  const profile=evidence({kind:'profile',id:patientId,version:'3',title:'Patient profile',recordedAt:null,effectiveAt:null,
   provenance:'Health ID patient profile',quality:'recorded',fields:{firstName:'Ngozi',lastName:'Testpatient',dateOfBirth:'1990-04-12',gender:'female'}});
  const note=item('note',2,{text:'Synthetic review of blood pressure; follow up booked.'});
  const s=setup([profile,note]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'blood pressure review'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:note.id,chunk_no:0}]:[]}));
  s.answer.mockResolvedValue('A blood pressure review is recorded [1].');
  const reply=await s.service.answer(request,'When was my blood pressure review?');
  const embedded=JSON.stringify(s.embed.mock.calls);
  expect(s.embed).toHaveBeenCalled();
  for(const secret of ['Ngozi','Testpatient','1990-04-12','Patient profile'])expect(embedded).not.toContain(secret);
  const inserts=s.query.mock.calls.filter(([sql])=>String(sql).includes('insert into ehr.patient_evidence_chunks'));
  expect(inserts.length).toBeGreaterThan(0);expect(inserts.every(([,args])=>(args as unknown as unknown[])[1]!=='profile')).toBe(true);
  expect(reply).toMatchObject({status:'ready'});expect(reply.sources[0]).toMatchObject({kind:'note',id:note.id});
 });
});

describe('B5 one patient per turn',()=>{
 it('refuses with 409 when the authorized patient changes between authorize calls, before the answer is generated or saved',async()=>{
  const s=setup();s.authorizeSelf.mockResolvedValueOnce(auth).mockResolvedValue({...auth,patientId:'99999999-9999-4999-8999-999999999999'});
  await expect(s.service.answer(request,'Medicine')).rejects.toMatchObject({code:'CHAT_ACCESS_CHANGED'});
  expect(s.answer).not.toHaveBeenCalled();expect(s.save).not.toHaveBeenCalled();
 });
 it('applies the same rule to a staff access strategy',async()=>{
  const s=setup();const access=staffAccess(s,[RX]) as unknown as {authorize:jest.Mock};
  access.authorize.mockResolvedValueOnce(auth).mockResolvedValue({...auth,patientId:'99999999-9999-4999-8999-999999999999'});
  await expect(s.service.answer(request,'Medicine',access as never)).rejects.toMatchObject({code:'CHAT_ACCESS_CHANGED'});
  expect(s.save).not.toHaveBeenCalled();
 });
 it('refuses an access strategy whose audience disagrees with its audit actor, before any patient data is read',async()=>{
  const s=setup();const access={...(staffAccess(s,[RX]) as object),audience:'patient'} as never;
  await expect(s.service.answer(request,'Medicine',access)).rejects.toMatchObject({code:'PATIENT_CHAT_UNAVAILABLE'});
  expect(s.plan).not.toHaveBeenCalled();
 });
});

describe('A failed turn logs its category only',()=>{
 afterEach(()=>jest.restoreAllMocks());
 const staffAccess=(s:ReturnType<typeof setup>)=>({audience:'staff',audit:{actorType:'staff'},authorize:async()=>auth,admissionKey:'staff:staff-a:facility-a',
  history:{start:async()=>'generation',context:s.context,save:s.save}}) as never;
 it('logs the model failure category and the audience, never the question, the error text or the record, and still answers 503',async()=>{
  const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
  const s=setup();s.plan.mockRejectedValue(new ClaudeCallError('answer_cut_off','Claude answer cut off'));
  await expect(s.service.answer(request,'Summarise Adaeze Okafor\'s history',staffAccess(s))).rejects.toMatchObject({code:'PATIENT_CHAT_UNAVAILABLE'});
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toEqual({message:'Record chat unavailable',category:'model_answer_cut_off',exceptionType:'ClaudeCallError',
   audience:'staff',correlationId:'synthetic-chat'});
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Adaeze|Summarise|cut off/);
 });
 it('gives the provider status for a refused request, "timeout" for the time limit, and "other" without the message for anything else',async()=>{
  const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
  const s=setup();
  s.plan.mockRejectedValueOnce(new ClaudeCallError('request_failed','Claude request failed',529));
  await expect(s.service.answer(request,'Medicine')).rejects.toMatchObject({status:503});
  s.plan.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout','TimeoutError'));
  await expect(s.service.answer(request,'Medicine')).rejects.toMatchObject({status:503});
  // A database or parser message can carry patient data; only its class name is logged.
  s.plan.mockRejectedValueOnce(new Error('duplicate key for Adaeze Okafor, 1990-03-12'));
  await expect(s.service.answer(request,'Medicine')).rejects.toMatchObject({status:503});
  expect(warn.mock.calls.map(c=>c[0])).toEqual([
   {message:'Record chat unavailable',category:'model_request_failed',exceptionType:'ClaudeCallError',providerStatus:529,audience:'patient',correlationId:'synthetic-chat'},
   {message:'Record chat unavailable',category:'timeout',exceptionType:'DOMException',audience:'patient',correlationId:'synthetic-chat'},
   {message:'Record chat unavailable',category:'other',exceptionType:'Error',audience:'patient',correlationId:'synthetic-chat'}]);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Adaeze|1990|duplicate/);
 });
 it('does not log a refusal the user is told about (a DomainProblem)',async()=>{
  const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
  await expect(setup().service.answer(request,'')).rejects.toMatchObject({status:400});
  expect(warn).not.toHaveBeenCalled();
 });
 it('ends a staff turn at 48 seconds, under the gateway\'s 50, and keeps 60 for patients',async()=>{
  const timeout=jest.spyOn(AbortSignal,'timeout');
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'I can summarise this patient\'s records.'});
  await s.service.answer(request,'Hello',staffAccess(s));
  expect(timeout).toHaveBeenCalledWith(48_000);
  timeout.mockClear();
  await s.service.answer(request,'Hello');
  expect(timeout).toHaveBeenCalledWith(60_000);
 });
 it('starts the turn timer before authorization, so authorization and history count against it',async()=>{
  const timeout=jest.spyOn(AbortSignal,'timeout');
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'I can summarise this patient\'s records.'});
  const authorize=jest.fn(async()=>auth);
  await s.service.answer(request,'Hello',{...(staffAccess(s) as object),authorize} as never);
  const turnTimer=timeout.mock.calls.findIndex(call=>call[0]===48_000);
  expect(turnTimer).toBeGreaterThanOrEqual(0);
  expect(timeout.mock.invocationCallOrder[turnTimer]!).toBeLessThan(authorize.mock.invocationCallOrder[0]!);
 });
 it('stops a turn whose authorization and history used up its time, before asking the model',async()=>{
  const warn=jest.spyOn(Logger.prototype,'warn').mockImplementation(()=>undefined);
  jest.spyOn(AbortSignal,'timeout').mockReturnValue(AbortSignal.abort(new DOMException('The operation timed out.','TimeoutError')));
  const s=setup();
  await expect(s.service.answer(request,'Hello',staffAccess(s))).rejects.toMatchObject({code:'PATIENT_CHAT_UNAVAILABLE'});
  expect(s.plan).not.toHaveBeenCalled();expect(s.save).not.toHaveBeenCalled();
  expect(warn.mock.calls[0]?.[0]).toMatchObject({category:'timeout',audience:'staff'});
 });
});

describe('B6 stale patient vectors are purged',()=>{
 const purges=(s:ReturnType<typeof setup>)=>s.query.mock.calls.filter(([sql])=>/^delete from ehr\.(patient|staff)_evidence_chunks/.test(String(sql).trim()));
 function indexed(records:Evidence[],coverage:Record<string,unknown>={}) {
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'synthetic history'});
  s.snapshot.mockResolvedValue({records,coverage:{complete:true,recordCount:records.length,selectedCount:0,pendingDocuments:0,unavailable:[],...coverage}});
  // Every current chunk is already embedded, so nothing new is embedded on this search.
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:records[0]!.kind,source_id:records[0]!.id,chunk_no:0}]
   :sql.includes('select source_kind,source_id,source_version')?records.map(r=>({source_kind:r.kind,source_id:r.id,source_version:r.version,source_hash:r.hash,chunk_no:0})):[]}));
  s.answer.mockResolvedValue('Synthetic history is recorded [1].');
  return s;
 }
 it('deletes every patient chunk not in the current snapshot on every search, for kinds with complete coverage, and still answers',async()=>{
  const records=[item('note',1),LAB];const s=indexed(records);
  const reply=await s.service.answer(request,'Synthetic history');
  expect(s.embed).toHaveBeenCalledTimes(1);// the question only
  const [sql,args]=purges(s)[0] as unknown as [string,unknown[]];
  expect(sql).toContain('ehr.patient_evidence_chunks');expect(args[0]).toBe(patientId);
  expect(args[1]).toEqual(records.map(r=>`${r.kind}:${r.id}:${r.version}:${r.hash}`));
  expect(args[2]).toEqual(expect.arrayContaining(['note','diagnosis','prescription','profile','lab_result']));
  expect(args[2]).not.toContain('document');expect(args[2]).not.toContain('attachment');
  expect(reply.status).toBe('ready');
 });
 it('keeps lab vectors while the Lab service is unavailable',async()=>{
  const s=indexed([item('note',1)],{complete:false,unavailable:['Laboratory service unavailable; result coverage is unknown']});
  await s.service.answer(request,'Synthetic history');
  const args=purges(s)[0]![1] as unknown as unknown[];expect(args[2]).toContain('note');expect(args[2]).not.toContain('lab_result');
 });
 it('leaves the staff index rule unchanged',async()=>{
  const s=setup();const records=[item('note',1)];
  s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'synthetic history'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:records[0]!.id,chunk_no:0}]
   :sql.includes('select source_kind,source_id,source_version')?records.map(r=>({source_kind:r.kind,source_id:r.id,source_version:r.version,source_hash:r.hash,chunk_no:0})):[]}));
  s.answer.mockResolvedValue('Synthetic history is recorded [1].');
  await s.service.answer(request,'Synthetic history',staffAccess(s,records));
  expect(purges(s)).toEqual([]);
 });
});

describe('Patient exclusions with the chat still answering from what remains',()=>{
 // Fictional patient; the records are cleaned by the real patient policy (Agent A) as the patient snapshot does.
 const person={firstName:'Ngozi',lastName:'Testpatient',fullName:'Ngozi Testpatient',dateOfBirth:'1990-04-12',gender:'female'};
 const raw=[
  evidence({kind:'diagnosis',id:'88888888-8888-4888-8888-000000000001',version:'1',title:'Hypertension',recordedAt:'2026-09-01T10:00:00Z',effectiveAt:null,
   provenance:'Clinician recorded condition',quality:'confirmed',fields:{condition:'Hypertension',verificationStatus:'confirmed',notes:'Synthetic clinician aside'}}),
  evidence({kind:'diagnosis',id:'88888888-8888-4888-8888-000000000002',version:'1',title:'Synthetic refuted condition',recordedAt:'2026-09-01T10:00:00Z',effectiveAt:null,
   provenance:'Clinician recorded condition',quality:'refuted',fields:{condition:'Synthetic refuted condition',verificationStatus:'refuted',notes:'Ruled out'}}),
  evidence({kind:'note',id:'88888888-8888-4888-8888-000000000003',version:'1',title:'Clinical note',recordedAt:'2026-09-01T10:00:00Z',effectiveAt:null,
   provenance:'Signed clinical note',quality:'released',fields:{noteType:'progress',text:'Ngozi Testpatient (HID-AB2CD3EF, 08031234567) reviewed for blood pressure.',_encounterStatus:'completed'}}),
  evidence({kind:'note',id:'88888888-8888-4888-8888-000000000004',version:'1',title:'Clinical note',recordedAt:'2026-11-03T10:00:00Z',effectiveAt:null,
   provenance:'Signed clinical note',quality:'released',fields:{noteType:'progress',text:'Synthetic note from a visit still in progress',_encounterStatus:'in_progress'}}),
  evidence({kind:'profile',id:patientId,version:'3',title:'Age and sex',recordedAt:null,effectiveAt:null,provenance:'Health ID patient profile',quality:'recorded',fields:{}}),
 ];
 const clean=():Evidence[]=>patientEvidence(raw,person,new Date('2026-11-03T12:00:00Z'));
 const excluded=['Synthetic refuted condition','Ruled out','Synthetic clinician aside','visit still in progress','Ngozi','Testpatient','HID-AB2CD3EF','08031234567','1990-04-12'];
 it('keeps excluded data out of Claude and Bedrock, and answers "Do I have hypertension?" from the confirmed diagnosis',async()=>{
  const records=clean();const s=setup(records);
  s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'hypertension diagnosis'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'diagnosis',source_id:raw[0]!.id,chunk_no:0}]:[]}));
  s.answer.mockImplementation(async(_q:string,sources:Evidence[])=>`A confirmed diagnosis of hypertension is recorded [${sources.findIndex(r=>r.id===raw[0]!.id)+1}].`);
  const reply=await s.service.answer(request,'Do I have hypertension?');
  const toClaude=JSON.stringify(s.answer.mock.calls[0][1]),toBedrock=JSON.stringify(s.embed.mock.calls);
  for(const secret of excluded){expect(toClaude).not.toContain(secret);expect(toBedrock).not.toContain(secret);}
  expect(s.answer).toHaveBeenCalledTimes(1);
  expect(reply).toMatchObject({status:'ready'});expect(reply.answer).toContain('[');
  expect(reply.sources).toEqual([expect.objectContaining({kind:'diagnosis',id:raw[0]!.id})]);
  expect(reply.answer.endsWith(DIAGNOSIS_LINE)).toBe(true);
 });
});

describe('The result line for results outside Lab (health profile, notes that state values)',()=>{
 it('adds the result line to "What is my genotype?" answered from the imported health profile',async()=>{
  const hp=evidence({kind:'health_profile',id:patientId,version:'2026-10-01',title:'Imported health profile',recordedAt:null,effectiveAt:null,
   provenance:'Imported patient health profile',quality:'imported',fields:{genotype:'AS',blood_group:'O+'}});
  const s=summary([hp],'Your genotype is recorded as AS [1].');
  expect((await s.service.answer(request,'What is my genotype?')).answer).toBe('Your genotype is recorded as AS [1].\n\n'+RESULT_LINE);
 });
 it('adds the result line to an answer citing a signed note that states values without the word "result"',async()=>{
  const note=item('note',7,{noteType:'consultation',text:'Hb 9.2 g/dL, MRDT positive, started ACT.'});
  const s=summary([note],'Your haemoglobin was 9.2 g/dL [1].');
  expect((await s.service.answer(request,'What was my haemoglobin?')).answer).toBe('Your haemoglobin was 9.2 g/dL [1].\n\n'+RESULT_LINE);
 });
 it('adds no result line for a note without any result, nor for a health profile without genotype or blood group',async()=>{
  const note=item('note',8,{noteType:'consultation',text:'Synthetic review; advised rest and fluids. Return in one week.'});
  const hp=evidence({kind:'health_profile',id:patientId,version:'2026-10-01',title:'Imported health profile',recordedAt:null,effectiveAt:null,
   provenance:'Imported patient health profile',quality:'imported',fields:{allergies:'Penicillin'}});
  const s=summary([note,hp],'A review and an allergy are recorded [1] [2].');
  expect((await s.service.answer(request,'Summarise')).answer).toBe('A review and an allergy are recorded [1] [2].');
 });
});

describe('Conversation replies take their lines from cited sources only',()=>{
 it('adds no line to "Thanks!" after a summary that selected a result and a diagnosis but cited only a prescription',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'You are welcome.'});
  s.context.mockResolvedValue({exchanges:[{question:'Summarise my record',answer:'A prescription is recorded [1].'}],
   bindings:[binding(RX),binding(LAB),binding(DIAGNOSIS)],cited:[binding(RX)]});
  const reply=await s.service.answer(request,'Thanks!');
  expect(reply.answer).toBe('You are welcome.');
  // Saved history stays bound to every selected source.
  expect(s.save.mock.calls[0][4]).toEqual([binding(RX),binding(LAB),binding(DIAGNOSIS)]);
 });
 it('still adds the lines owed by cited sources of an answer saved before the server added lines',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'You are welcome.'});
  s.context.mockResolvedValue({exchanges:[{question:'Blood test?',answer:'Haemoglobin 12.5 g/dL [1]. Hypertension [2].'}],
   bindings:[binding(LAB),binding(DIAGNOSIS)],cited:[binding(LAB),binding(DIAGNOSIS)]});
  expect((await s.service.answer(request,'Thanks')).answer).toBe(`You are welcome.\n\n${RESULT_LINE}\n\n${DIAGNOSIS_LINE}`);
 });
});

describe('Age and sex in a search question',()=>{
 const profile=evidence({kind:'profile',id:patientId,version:'3',title:'Age and sex',recordedAt:null,effectiveAt:null,
  provenance:'Health ID patient profile',quality:'recorded',fields:{ageYears:36,sex:'female'}});
 it('selects the age-and-sex profile for "How old am I?" without sending it to Bedrock',async()=>{
  const note=item('note',2,{text:'Synthetic review of blood pressure.'});
  const s=setup([profile,note]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'How old am I?'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:note.id,chunk_no:0}]:[]}));
  s.answer.mockImplementation(async(_q:string,sources:Evidence[])=>`You are 36 [${sources.findIndex(r=>r.kind==='profile')+1}].`);
  const reply=await s.service.answer(request,'How old am I?');
  expect((s.answer.mock.calls[0][1] as Evidence[]).map(r=>r.kind)).toContain('profile');
  expect(reply.sources).toEqual([expect.objectContaining({kind:'profile',id:patientId})]);
  expect(JSON.stringify(s.embed.mock.calls)).not.toContain('ageYears');
 });
 it('leaves the profile out of a search that is not about age or sex',async()=>{
  const note=item('note',2,{text:'Synthetic review of blood pressure.'});
  const s=setup([profile,note]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'blood pressure review'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:note.id,chunk_no:0}]:[]}));
  s.answer.mockResolvedValue('A review is recorded [1].');
  await s.service.answer(request,'When was my blood pressure review?');
  expect((s.answer.mock.calls[0][1] as Evidence[]).map(r=>r.kind)).toEqual(['note']);
 });
});

describe('Review fixes: the patient\'s own question is cleaned before any model sees it',()=>{
 const RAW='I am Adaeze Okafor, DOB 12/03/1990, phone 08031234567, HID-AB2CD3EF. What does my note say?';
 const secrets=['Adaeze','Okafor','12/03/1990','08031234567','HID-AB2CD3EF'];
 const note=item('note',2,{text:'Synthetic review of blood pressure.'});
 const searchSetup=()=>{const s=setup([note]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'note review'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:note.id,chunk_no:0}]:[]}));
  s.answer.mockResolvedValue('A review is recorded [1].');return s;};
 it('sends the cleaned question to plan, answer and embed, and saves only the cleaned question, and still answers',async()=>{
  const s=searchSetup();
  s.context.mockResolvedValue({exchanges:[{question:'Earlier question from Adaeze Okafor, 08031234567',answer:'Earlier answer.'}],bindings:[]});
  const reply=await s.service.answer(request,RAW);
  const sent=JSON.stringify([s.plan.mock.calls,s.answer.mock.calls.map(c=>[c[0],c[2]]),s.embed.mock.calls,s.save.mock.calls.map(c=>c[2])]);
  for(const secret of secrets)expect([secret,sent.includes(secret)]).toEqual([secret,false]);
  expect(s.plan.mock.calls[0][0]).toContain('What does my note say?');
  expect(s.save.mock.calls[0][2]).toContain('[date of birth removed]');
  expect(s.embed).toHaveBeenCalled();expect(reply).toMatchObject({status:'ready'});expect(reply.sources).toHaveLength(1);
 });
 it('cleans a conversation question too',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'Hello.'});
  await s.service.answer(request,RAW);
  const sent=JSON.stringify([s.plan.mock.calls,s.save.mock.calls.map(c=>c[2])]);
  for(const secret of secrets)expect([secret,sent.includes(secret)]).toEqual([secret,false]);
 });
 it('leaves the staff question exactly as typed',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'Hello.'});
  await s.service.answer(request,RAW,staffAccess(s,[RX]));
  expect(s.plan.mock.calls[0][0]).toBe(RAW);expect(s.save.mock.calls[0][2]).toBe(RAW);expect(s.redactionProfile).not.toHaveBeenCalled();
 });
});

describe('Review fixes: each server line appears once',()=>{
 it('removes a copy with a citation or inside a paragraph before adding the line once',async()=>{
  const s=summary([LAB],`Haemoglobin 12.5 g/dL [1]. ${RESULT_LINE} [1]\n\n${RESULT_LINE}\n\nMore detail. ${RESULT_LINE}`);
  const reply=await s.service.answer(request,'Blood test?');
  expect(count(reply.answer,RESULT_LINE)).toBe(1);expect(reply.answer.endsWith('\n\n'+RESULT_LINE)).toBe(true);
  expect(reply.answer).toBe(`Haemoglobin 12.5 g/dL [1].\n\nMore detail.\n\n${RESULT_LINE}`);
 });
 it('does the same for the diagnosis line, and keeps a citation that only the removed copy carried',async()=>{
  const s=summary([DIAGNOSIS,RX],`Hypertension is recorded. ${DIAGNOSIS_LINE} [1] You take a medicine [2].`);
  const reply=await s.service.answer(request,'Do I have hypertension?');
  expect(count(reply.answer,DIAGNOSIS_LINE)).toBe(1);expect(reply.answer.endsWith('\n\n'+DIAGNOSIS_LINE)).toBe(true);
  expect(reply.answer).toMatch(/\[1\]/);expect(reply.sources).toHaveLength(2);
 });
});

describe('Second review: earlier answers replayed from history are cleaned too',()=>{
 const OLD={question:'I am Adaeze Okafor born 12/03/1990, what is my Hb?',answer:'Adaeze, your Hb is 12 g/dL [1]. Okafor family noted.'};
 it('sends neither the earlier question nor the earlier answer with the name or date of birth to plan or answer',async()=>{
  const note=item('note',2,{text:'Synthetic review of blood pressure.'});
  const s=setup([note]);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'note review'});
  s.query.mockImplementation(async(sql:string)=>({rows:sql.includes('order by embedding<=>')?[{source_kind:'note',source_id:note.id,chunk_no:0}]:[]}));
  s.answer.mockResolvedValue('A review is recorded [1].');
  s.context.mockResolvedValue({exchanges:[OLD],bindings:[]});
  const reply=await s.service.answer(request,'And my blood pressure?');
  const sent=JSON.stringify([s.plan.mock.calls,s.answer.mock.calls]);
  for(const secret of ['Adaeze','Okafor','12/03/1990'])expect([secret,sent.includes(secret)]).toEqual([secret,false]);
  expect(s.plan.mock.calls[0][1]).toEqual([{question:'I am the patient born [date of birth removed], what is my Hb?',
   answer:'the patient, your Hb is 12 g/dL [1]. [name removed] family noted.'}]);
  expect(reply).toMatchObject({status:'ready'});
 });
 it('keeps the earlier lines so a conversation reply still owes them',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'You are welcome, Adaeze.'});
  s.context.mockResolvedValue({exchanges:[{question:OLD.question,answer:`Adaeze, your Hb is 12 g/dL [1].\n\n${RESULT_LINE}`}],bindings:[]});
  const reply=await s.service.answer(request,'Thanks');
  expect(reply.answer.endsWith('\n\n'+RESULT_LINE)).toBe(true);
 });
 it('leaves the staff history exactly as saved',async()=>{
  const s=setup();s.plan.mockResolvedValue({intent:'conversation',answer:'Hello.'});
  s.context.mockResolvedValue({exchanges:[OLD],bindings:[]});
  await s.service.answer(request,'Hello',staffAccess(s,[RX]));
  expect(s.plan.mock.calls[0][1]).toEqual([OLD]);
 });
});

describe('Second review: a server line is found as a sentence of its own, with any spacing or markup',()=>{
 const HB='Your Hb is 12 g/dL [1].';
 it('leaves the line\'s words inside a longer sentence as written, and adds the line once',()=>{
  const answer=`${HB} Please talk to your doctor about what this result means for your treatment [1].`;
  expect(withPatientLines(answer,[RESULT_LINE])).toBe(`${answer}\n\n${RESULT_LINE}`);
 });
 it('removes a bold, list-item or exclaimed copy without leaving markup or punctuation behind',()=>{
  for(const copy of [`**${RESULT_LINE}**`,`- ${RESULT_LINE}`,`${RESULT_LINE.replace(/\.$/,'')}!`,`_${RESULT_LINE}_ [1]`,`1. ${RESULT_LINE}`])
   expect([copy,withPatientLines(`${HB}\n\n${copy}`,[RESULT_LINE])]).toEqual([copy,`${HB}\n\n${RESULT_LINE}`]);
  expect(withPatientLines(`${HB}\n- ${RESULT_LINE}\n- Eat well.`,[RESULT_LINE])).toBe(`${HB}\n- Eat well.\n\n${RESULT_LINE}`);
 });
 it('removes a copy split by a line break or a double space',()=>{
  for(const copy of ['Talk to your doctor about\nwhat this result means.','Talk to your  doctor about what this result means.'])
   expect([copy,withPatientLines(`${HB}\n\n${copy}`,[RESULT_LINE])]).toEqual([copy,`${HB}\n\n${RESULT_LINE}`]);
  expect(withPatientLines(`${HB} Talk to your doctor\nabout what this result means. Eat well.`,[RESULT_LINE]))
   .toBe(`${HB} Eat well.\n\n${RESULT_LINE}`);
 });
});

describe('Record chat answers: dated questions and no dashes',()=>{
 const EM='\u2014';
 const dx=(n:number,date:string,condition:string)=>evidence({kind:'diagnosis',id:`55555555-5555-4555-8555-${String(n).padStart(12,'0')}`,version:'1',
  title:condition,recordedAt:date,effectiveAt:date,provenance:'Clinician recorded condition',quality:'confirmed',fields:{condition,verificationStatus:'confirmed'}});
 it('answers "first diagnosis" from the earliest diagnoses in the authorized snapshot, even when the search finds nothing',async()=>{
  const records=[dx(1,'2026-09-21T00:00:00Z','Iron deficiency anaemia'),dx(2,'2018-04-02T00:00:00Z','Synthetic asthma'),item('note',3,{text:'Visit'})];
  const s=setup(records);s.plan.mockResolvedValue({intent:'records',recordIntent:'search',query:'earliest diagnosis'});
  s.query.mockImplementation(async()=>({rows:[]}));
  s.answer.mockResolvedValue('**The earliest recorded diagnosis is Synthetic asthma, 2 April 2018.** [1]');
  await s.service.answer(request,'what was my first diagnosis');
  const sources=s.answer.mock.calls[0][1] as Evidence[];
  expect(sources[0]!.id).toBe(records[1]!.id);expect(sources.map(r=>r.id)).toContain(records[0]!.id);
  expect(s.answer.mock.calls[0][6]).toBe('earliest');
  // Only what the snapshot (the reader's access) holds is ever sent.
  expect(sources.every(r=>records.some(x=>x.id===r.id))).toBe(true);
 });
 it('never adds records outside the staff member\'s permitted snapshot',async()=>{
  const permitted=[dx(1,'2020-01-01T00:00:00Z','Synthetic condition A')];
  const s=setup([dx(2,'2001-01-01T00:00:00Z','Hidden condition'),...permitted]);
  s.plan.mockResolvedValue({intent:'records',recordIntent:'condition',query:'diagnosis'});
  s.answer.mockResolvedValue('**Synthetic condition A.** [1]');
  await s.service.answer(request,'first diagnosis of this patient',staffAccess(s,permitted));
  expect((s.answer.mock.calls[0][1] as Evidence[]).map(r=>r.id)).toEqual([permitted[0]!.id]);
 });
 it('removes dashes from staff and patient answers before saving and returning them',async()=>{
  const s=setup([RX]);s.answer.mockResolvedValue(`**A prescribed medicine ${EM} recorded 2025\u20132026.** [1]`);
  const staff=await s.service.answer(request,'Latest medicine',staffAccess(s,[RX]));
  expect(staff.answer).toBe('**A prescribed medicine, recorded 2025 to 2026.** [1]');
  expect(s.save.mock.calls[0][3].answer).toBe(staff.answer);
  const p=setup();p.plan.mockResolvedValue({intent:'conversation',answer:`Hello ${EM} ask me about your record.`});
  const reply=await p.service.answer(request,'Hello');
  expect(reply.answer).not.toMatch(/[\u2013\u2014\u2015]/);expect(p.save.mock.calls[0][3].answer).toBe(reply.answer);
 });
});
