import {readableLines,PatientAttachmentTextService} from './patient-attachment-text.service';
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
