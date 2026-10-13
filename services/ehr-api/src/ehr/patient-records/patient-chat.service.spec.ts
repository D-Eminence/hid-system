import type {PoolClient} from 'pg';
import {PatientChatService} from './patient-chat.service';
import {evidence,binding,type Evidence} from './patient-evidence.types';
jest.mock('../../config/environment',()=>({getEnvironment:()=>({AI_ENABLED:true,AI_EMBEDDING_MODEL_ID:'amazon.titan-embed-text-v2:0'})}));
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
});
