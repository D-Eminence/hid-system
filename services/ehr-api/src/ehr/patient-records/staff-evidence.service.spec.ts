import { StaffEvidenceService } from './staff-evidence.service';
import { STAFF_SOURCE_PERMISSIONS, type StaffChatScope } from './staff-chat-scope.service';
import { binding, type SourceKind } from './patient-evidence.types';
import { DomainProblem } from '../../common/problem';
const patientId='11111111-1111-4111-8111-111111111111',sourceId='22222222-2222-4222-8222-222222222222';
function setup() {
  const row={kind:'note',id:sourceId,version:'1',title:'Synthetic note',recorded_at:new Date(),effective_at:null,
    provenance:'Signed note',quality:'released',fields:{text:'Synthetic A evidence'}};
  const query=jest.fn().mockResolvedValue({rows:[row]}),authorize=jest.fn().mockResolvedValue({patientId});
  const permissions=['ehr.note.read'];
  const scope={patientId,context:{actor:{accountId:'staff-a'},membershipId:'member-a',facilityId:'facility-a'},permissions,
    authorize,transaction:async(_auth:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}),
    allows:(kind:SourceKind)=>STAFF_SOURCE_PERMISSIONS[kind].every(p=>permissions.includes(p))} as unknown as StaffChatScope;
  const documents={prepare:jest.fn(),read:jest.fn().mockResolvedValue({records:[],pending:2,complete:false})};
  const lab={staffReleasedResults:jest.fn().mockResolvedValue({records:[],nextCursor:null})};
  const identity={staffPatientProfile:jest.fn().mockResolvedValue({patientId,version:1,firstName:'Synthetic'})};
  const service=new StaffEvidenceService(documents as never,lab as never,{recordWithClient:jest.fn()} as never,identity as never);
  const request={correlationId:'synthetic-staff-evidence'} as never;
  return {service,scope,request,row,query,authorize,permissions,documents,lab,identity};
}
it('supplies the explicit patient and allowed kinds in SQL, without querying documents, profile or Lab when permission is missing',async()=>{
  const s=setup(),snapshot=await s.service.bind(s.scope).snapshot(s.request);
  expect(s.query.mock.calls[0]![1]).toEqual([patientId,'','',['note','import','import_version','health_profile']]);
  expect(snapshot.records[0]).toMatchObject({id:sourceId,kind:'note'});expect(snapshot.coverage.complete).toBe(false);
  expect(s.documents.read).not.toHaveBeenCalled();expect(s.lab.staffReleasedResults).not.toHaveBeenCalled();expect(s.identity.staffPatientProfile).not.toHaveBeenCalled();
});
it('uses only the internal staff profile contract and rejects a different returned patient',async()=>{
  const s=setup();s.permissions.push('identity.patient.read');s.identity.staffPatientProfile.mockResolvedValue({patientId:'other',version:1,firstName:'Synthetic'});
  await expect(s.service.bind(s.scope).snapshot(s.request)).rejects.toThrow('profile authorization changed');
});
it('does not expose forged source IDs or source kinds outside the current permission scope',async()=>{
  const s=setup();await expect(s.service.source(s.scope,s.request,'note','foreign-id')).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  await expect(s.service.source(s.scope,s.request,'prescription',sourceId)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  await expect(s.service.source(s.scope,s.request,'__proto__',sourceId)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
});
it('rejects an answer binding when a source changes before delivery',async()=>{
  const s=setup(),evidence=s.service.bind(s.scope),snapshot=await evidence.snapshot(s.request);
  s.query.mockResolvedValue({rows:[{...s.row,title:'Changed source'}]});
  await expect(evidence.assertCurrent(s.request,snapshot.records.map(binding))).rejects.toMatchObject({code:'CHAT_SOURCES_CHANGED'});
});
it('discards partial Lab pages after an outage and propagates revoked Lab authorization',async()=>{
  const s=setup();s.permissions.push('lab.result.released.read');
  s.lab.staffReleasedResults.mockResolvedValueOnce({records:[{id:sourceId,version:'1',title:'Synthetic result',recordedAt:new Date().toISOString(),effectiveAt:null,fields:{numericValue:'20.05'}}],nextCursor:sourceId} as never)
    .mockRejectedValueOnce(new DomainProblem(503,'LAB_SERVICE_UNAVAILABLE','Unavailable'));
  const snapshot=await s.service.bind(s.scope).snapshot(s.request);
  expect(snapshot.records.some(r=>r.kind==='lab_result')).toBe(false);expect(snapshot.coverage.unavailable).toContain('Laboratory service unavailable; result coverage is unknown.');
  s.lab.staffReleasedResults.mockRejectedValue(new DomainProblem(403,'PERMISSION_DENIED','Revoked'));
  await expect(s.service.bind(s.scope).snapshot(s.request)).rejects.toThrow('Revoked');
});
it('uses staff-owned document extraction storage and preserves pending coverage',async()=>{
  const s=setup();s.permissions.push('ehr.document.read');
  const snapshot=await s.service.bind(s.scope).snapshot(s.request);
  const access=s.documents.read.mock.calls[0]![3] as {query:string;table:(kind:string)=>string};
  expect(access.query).toContain('ehr.staff_attachment_extractions');expect(access.query).not.toContain('ehr.patient_document_extractions');
  expect(access.table('document')).toBe('ehr.staff_document_extractions');expect(snapshot.coverage.pendingDocuments).toBe(2);
});
