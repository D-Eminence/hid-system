import {createHash} from 'node:crypto';
import {PatientChatHistoryService} from './patient-chat-history.service';
import {evidence,binding} from './patient-evidence.types';
const note=evidence({kind:'note',id:'note-a',version:'1',title:'Visit',recordedAt:null,effectiveAt:null,provenance:'Signed note',quality:'released',fields:{text:'Synthetic note'}});
const prescription=evidence({...note,kind:'prescription',id:'rx-a',fields:{medication:'Synthetic medicine'}});
const auth={patientId:'patient-a',subject:'subject-a',accountId:'account-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
const request={correlationId:'synthetic-history'} as never;
const reply={status:'ready' as const,answer:'Medicine [1].',sources:[{...binding(prescription),number:1,title:prescription.title,recordedAt:null,effectiveAt:null,provenance:prescription.provenance,quality:prescription.quality}]};
function setup() {
 let records=[note,prescription];const rows:Record<string,unknown>[]=[];
 const query=jest.fn(async(sql:string,params?:unknown[])=>{
  if(sql.includes('for update'))return {rows:[{generation:'generation-a'}]};
  if(sql.includes('select h.id'))return {rows};
  if(sql.includes('insert into ehr.patient_chat_messages'))rows.push({id:'message-a',question:params?.[2],reply:JSON.parse(String(params?.[3])),createdAt:new Date(),sourceBindings:JSON.parse(String(params?.[4]))});
  return {rows:[]};
 });
 const transaction=jest.fn(async(_a:unknown,_id:string,work:(c:unknown)=>Promise<unknown>)=>work({query}));
 const authorizeSelf=jest.fn().mockResolvedValue(auth),audit=jest.fn();
 const snapshot=jest.fn(async()=>({records,coverage:{unavailable:[]}}));
 const history=new PatientChatHistoryService({withPatientTransaction:transaction} as never,{authorizeSelf} as never,{recordWithClient:audit} as never,{snapshot} as never);
 return {history,query,rows,authorizeSelf,audit,transaction,setRecords:(r:typeof records)=>{records=r;}};
}
describe('Source-aware patient chat history',()=>{
 it('restores typed prescription evidence after a fresh login and hides private bindings/hashes',async()=>{
  const s=setup();await s.history.save(request,'generation-a','Which medicine?',reply);
  const read=await s.history.read(request);expect(read.exchanges).toHaveLength(1);expect(JSON.stringify(read)).not.toContain('hash');
  expect((await s.history.context(request,'generation-a')).bindings).toEqual([binding(prescription)]);
 });
 it('rejects cleared generations before storing a reply',async()=>{
  const s=setup();await expect(s.history.save(request,'cleared','Question',reply)).rejects.toThrow('conversation was cleared');expect(s.rows).toHaveLength(0);
 });
 it('withholds answers and inherited follow-ups after an authoritative source changes',async()=>{
  const s=setup();await s.history.save(request,'generation-a','Medicine',reply);
  await s.history.save(request,'generation-a','Follow-up',{...reply,sources:[]},[binding(prescription)]);
  s.setRecords([note,evidence({...prescription,fields:{medication:'Changed medicine'}})]);
  expect((await s.history.read(request)).exchanges).toEqual([]);
  await expect(s.history.save(request,'generation-a','Stale',{...reply,sources:[]},[binding(prescription)])).rejects.toThrow('source records changed');
 });
 it('hides revoked, deleted or invalidated sources across all supported source kinds',async()=>{
  const s=setup();await s.history.save(request,'generation-a','Medicine',reply);s.setRecords([note]);
  expect((await s.history.read(request)).exchanges).toEqual([]);
 });
 it('keeps existing note-only saved history compatible and converts its bindings to current evidence',async()=>{
  const s=setup();s.rows.push({id:'legacy',question:'Old note',reply:{...reply,sources:[]},createdAt:new Date(),sourceBindings:[{noteId:note.id,revisionNo:1,hash:createHash('sha256').update('Synthetic note').digest('hex')}]});
  expect((await s.history.read(request)).exchanges).toHaveLength(1);expect((await s.history.context(request,'generation-a')).bindings).toEqual([binding(note)]);
 });
 it('bounds prior model context to four ready exchanges and scopes the SQL to the authorized patient',async()=>{
  const s=setup();for(let i=0;i<6;i++)await s.history.save(request,'generation-a','Question '+i,reply);
  expect((await s.history.context(request,'generation-a')).exchanges).toHaveLength(4);
  const call=s.query.mock.calls.find(([sql])=>sql.includes('select h.id'));expect(call?.[1]).toEqual([auth.patientId]);expect(call?.[0]).toContain("interval '30 days'");
 });
 it('never audits clinical chat text or reads history after revocation',async()=>{
  const s=setup();await s.history.save(request,'generation-a','Private clinical question',reply);
  expect(JSON.stringify(s.audit.mock.calls)).not.toContain('Private clinical question');
  s.authorizeSelf.mockRejectedValue(new Error('revoked'));await expect(s.history.read(request)).rejects.toThrow('revoked');
 });
});
