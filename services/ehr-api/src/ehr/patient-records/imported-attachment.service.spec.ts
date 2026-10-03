import type {PoolClient} from 'pg';
import type {AuditService} from '../../audit/audit.service';
import type {DatabaseService} from '../../database/database.service';
import type {IdentityApiService} from '../../integrations/identity-api.service';
import type {HidRequest,DataAccessContext} from '../../common/request-context';
import type {StorageProvider} from '../../storage/storage.types';
import type {ClinicalRepository} from '../shared/clinical.repository';
import {ImportedAttachmentService} from './imported-attachment.service';

const actor={kind:'patient',patientId:'synthetic-patient',accountId:'synthetic-account',subject:'synthetic-subject',sessionId:'synthetic-session'};
const request={actor,correlationId:'synthetic-download'} as unknown as HidRequest;
const binding={file_id:'synthetic-file',patient_id:actor.patientId,storage_bucket:'synthetic-bucket',storage_key:'synthetic-key',
  object_version_id:'synthetic-version',sha256_hex:'a'.repeat(64),size_bytes:'19',file_name:'synthetic.txt',result:'clean',detected_media_type:'application/pdf'};
function setup(){
  const query=jest.fn().mockResolvedValue({rows:[binding]}),client={query} as unknown as PoolClient;
  const authorizeSelf=jest.fn().mockResolvedValue(actor),recordWithClient=jest.fn().mockResolvedValue(undefined);
  const withPatientTransaction=jest.fn(async(_auth:unknown,_correlation:string,fn:(c:PoolClient)=>Promise<unknown>)=>fn(client));
  const inspectVersion=jest.fn().mockResolvedValue({versionId:binding.object_version_id,sha256Hex:binding.sha256_hex,sizeBytes:19});
  const createDownload=jest.fn().mockResolvedValue({url:'https://example.invalid/controlled',expiresInSeconds:60});
  const run=jest.fn(async(_context:unknown,_id:string,_scope:string,_audit:unknown,fn:(c:PoolClient)=>Promise<{value:unknown}>)=>(await fn(client)).value);
  const service=new ImportedAttachmentService({withPatientTransaction} as unknown as DatabaseService,
    {authorizeSelf} as unknown as IdentityApiService,{recordWithClient} as unknown as AuditService,
    {run} as unknown as ClinicalRepository,{bucket:()=>binding.storage_bucket,inspectVersion,createDownload} as unknown as StorageProvider);
  return {service,query,authorizeSelf,recordWithClient,withPatientTransaction,inspectVersion,createDownload,run};
}
describe('Imported attachment disclosure boundary',()=>{
  it('checks fresh self authority, records audit, inspects the pinned version and only then signs',async()=>{
    const s=setup();await expect(s.service.self(binding.file_id,request)).resolves.toMatchObject({expiresInSeconds:60});
    expect(s.query.mock.calls[0][1]).toEqual([binding.file_id,actor.patientId]);
    expect(s.recordWithClient.mock.invocationCallOrder[0]).toBeLessThan(s.createDownload.mock.invocationCallOrder[0]!);
    expect(s.createDownload).toHaveBeenCalledWith(binding.storage_key,binding.object_version_id,{fileName:'synthetic.txt',mediaType:'application/pdf'});
  });
  it('rejects changed patient/session mappings before opening a transaction',async()=>{
    const s=setup();s.authorizeSelf.mockResolvedValue({...actor,patientId:'other'});
    await expect(s.service.self(binding.file_id,request)).rejects.toThrow('authorization changed');
    expect(s.withPatientTransaction).not.toHaveBeenCalled();expect(s.createDownload).not.toHaveBeenCalled();
  });
  it.each([null,'infected','error'])('does not sign an attachment with scan result %s',async result=>{
    const s=setup();s.query.mockResolvedValue({rows:[{...binding,result}]});
    await expect(s.service.self(binding.file_id,request)).rejects.toThrow('safety verification');expect(s.createDownload).not.toHaveBeenCalled();
  });
  it('does not disclose a link if durable audit fails',async()=>{
    const s=setup();s.recordWithClient.mockRejectedValue(new Error('audit unavailable'));
    await expect(s.service.self(binding.file_id,request)).rejects.toThrow('audit unavailable');expect(s.createDownload).not.toHaveBeenCalled();
  });
  it.each(['versionId','sha256Hex','sizeBytes'])('rejects changed object %s',async key=>{
    const s=setup();s.inspectVersion.mockResolvedValue({versionId:binding.object_version_id,sha256Hex:binding.sha256_hex,sizeBytes:19,[key]:key==='sizeBytes'?20:'other'});
    await expect(s.service.self(binding.file_id,request)).rejects.toThrow('integrity verification');expect(s.createDownload).not.toHaveBeenCalled();
  });
  it('staff reads use the consent repository and denied consent never signs',async()=>{
    const s=setup(),context={} as DataAccessContext;s.run.mockRejectedValue(new Error('consent denied'));
    await expect(s.service.staff(actor.patientId,binding.file_id,context)).rejects.toThrow('consent denied');
    expect(s.run).toHaveBeenCalledWith(context,actor.patientId,'read_records',expect.objectContaining({action:'ehr.imported.attachment.download'}),expect.any(Function));
    expect(s.createDownload).not.toHaveBeenCalled();
  });
});
