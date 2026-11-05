import {readableLines,PatientAttachmentTextService,attachmentTextQuery,ATTACHMENT_PROVENANCE} from './patient-attachment-text.service';
jest.mock('../../config/environment',()=>({getEnvironment:()=>({S3_REGION:'eu-west-1'})}));
it('omits unreadable or uncertain OCR lines instead of treating uncertain medical values as facts',()=>{
 const result=readableLines([{BlockType:'PAGE',Page:1},{BlockType:'LINE',Page:1,Text:'Recorded medicine: synthetic',Confidence:99},
  {BlockType:'LINE',Page:1,Text:'UNCERTAIN MEDICAL NUMBER',Confidence:41}]);
 expect(result.text).toContain('Recorded medicine: synthetic');expect(result.text).not.toContain('UNCERTAIN MEDICAL NUMBER');
 expect(result.unclear).toBe(1);expect(result.pages).toBe(1);
});
it('does not expose cached document text when the current object checksum or version fails verification',async()=>{
 const row={kind:'attachment',id:'file-a',source_created_at:new Date(),object_version_id:'version-a',storage_bucket:'owned-bucket',storage_key:'owned-key',
  sha256_hex:'a'.repeat(64),size_bytes:'100',scan_result:'clean',status:'ready',extracted_text:'Private document text',unclear_lines:0,page_count:1,updated_at_token:'synthetic'};
 const query=jest.fn().mockResolvedValue({rows:[row]});const transact=jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
 const storage={bucket:()=> 'owned-bucket',inspectVersion:jest.fn().mockResolvedValue({versionId:'version-a',sha256Hex:'b'.repeat(64),sizeBytes:100})};
 const svc=new PatientAttachmentTextService({withPatientTransaction:transact} as never,{authorizeSelf:jest.fn().mockResolvedValue({patientId:'patient-a'})} as never,storage as never);
 const reply=await svc.read({correlationId:'synthetic-document'} as never);expect(reply.records).toEqual([]);expect(reply.pending).toBe(1);
 expect(JSON.stringify(reply)).not.toContain('Private document text');
});
it('omits a dose line with an uncertain word even when aggregate line confidence is high',()=>{
 const result=readableLines([{BlockType:'LINE',Text:'Dose 10 mg',Confidence:99,Relationships:[{Type:'CHILD',Ids:['dose-word']}]},
 {BlockType:'WORD',Id:'dose-word',Text:'10',Confidence:40}]);
 expect(result.text).not.toContain('10 mg');expect(result.unclear).toBe(1);
});
it('reads and prepares only phi documents for the patient, and keeps the staff query separate',async()=>{
 const query=jest.fn().mockResolvedValue({rows:[]});const transact=jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
 const storage={bucket:()=> 'owned-bucket',inspectVersion:jest.fn()};
 const svc=new PatientAttachmentTextService({withPatientTransaction:transact} as never,{authorizeSelf:jest.fn().mockResolvedValue({patientId:'patient-a'})} as never,storage as never);
 await svc.read({correlationId:'synthetic-document'} as never);
 await svc.prepare({correlationId:'synthetic-document'} as never,new AbortController().signal);
 expect(query).toHaveBeenCalledTimes(2);
 // The photos and files the patient added (0117) are read too while PATIENT_ENTRY_FILES_ENABLED is on (the default).
 for(const [sql] of query.mock.calls){expect(sql).toBe(attachmentTextQuery('patient',true));expect(sql).toContain("d.classification='phi'");}
 expect(attachmentTextQuery('staff')).not.toContain('classification');
});

describe('the photos and files patients add (0117)',()=>{
 const saved=process.env.PATIENT_ENTRY_FILES_ENABLED;
 afterEach(()=>{if(saved===undefined)delete process.env.PATIENT_ENTRY_FILES_ENABLED;else process.env.PATIENT_ENTRY_FILES_ENABLED=saved;});
 it('reads only live, confirmed, clean files, into the patient\'s own extraction table, never for staff',()=>{
  const patient=attachmentTextQuery('patient',true);
  expect(patient).toContain("from ehr.patient_entry_documents_effective d left join ehr.patient_entry_document_extractions x");
  expect(patient).toContain("where d.patient_id=$1 and d.status='available'");
  expect(attachmentTextQuery('patient')).not.toContain('patient_entry_document');
  expect(attachmentTextQuery('staff')).not.toContain('patient_entry_document');
 });
 it('labels a file as the patient provided it, machine read and not checked',()=>{
  expect(ATTACHMENT_PROVENANCE.patient_entry_document).toBe('Patient provided file; machine extracted, not clinician verified');
 });
 it('leaves the files out while PATIENT_ENTRY_FILES_ENABLED is off',async()=>{
  process.env.PATIENT_ENTRY_FILES_ENABLED='false';
  const query=jest.fn().mockResolvedValue({rows:[]});const transact=jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
  const svc=new PatientAttachmentTextService({withPatientTransaction:transact} as never,{authorizeSelf:jest.fn().mockResolvedValue({patientId:'patient-a'})} as never,{bucket:()=> 'owned-bucket'} as never);
  await svc.read({correlationId:'synthetic-document'} as never);
  expect(query.mock.calls[0]![0]).toBe(attachmentTextQuery('patient'));
 });
 it('reads a clean file\'s text with the patient label',async()=>{
  const row={kind:'patient_entry_document',id:'file-p',source_created_at:new Date('2026-11-04T09:00:00Z'),object_version_id:'version-p',
   storage_bucket:'owned-bucket',storage_key:'clinical/objects/k',sha256_hex:'c'.repeat(64),size_bytes:'2048',scan_result:'clean',
   status:'ready',extracted_text:'Page 1: Malaria RDT positive',unclear_lines:0,page_count:1,updated_at_token:'2026-11-04 09:05:00+00'};
  const query=jest.fn().mockResolvedValue({rows:[row]});const transact=jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
  const storage={bucket:()=> 'owned-bucket',inspectVersion:jest.fn().mockResolvedValue({versionId:'version-p',sha256Hex:'c'.repeat(64),sizeBytes:2048})};
  const svc=new PatientAttachmentTextService({withPatientTransaction:transact} as never,{authorizeSelf:jest.fn().mockResolvedValue({patientId:'patient-a'})} as never,storage as never);
  const reply=await svc.read({correlationId:'synthetic-document'} as never);
  expect(reply.records).toHaveLength(1);
  expect(reply.records[0]).toMatchObject({kind:'patient_entry_document',origin:'patient',
   provenance:'Patient provided file; machine extracted, not clinician verified'});
 });
});
