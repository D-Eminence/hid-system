jest.mock('../auth/workload-auth.service',()=>({WorkloadAuthService:class {}}));
import { IdentityService } from './identity.service';
import { IdentityController } from './identity.controller';
function setup() {
  const provider={authorize:jest.fn().mockResolvedValue({allowed:true,breakGlass:false}),
    lookupPatientId:jest.fn().mockResolvedValue({id:'patient-a',rowVersion:4,firstName:'Synthetic',lastName:'Patient',fullName:'Synthetic Patient',dateOfBirth:null,gender:null,nin:'never-return'})};
  const context={actor:{kind:'staff',subject:'staff-a',permissions:['identity.patient.read']},purposeOfUse:'direct-care'} as never;
  const service=new IdentityService(provider as never,{record:jest.fn()} as never);
  return {provider,context,service};
}
it('returns only the authorized staff lookup profile fields',async()=>{
  const s=setup();expect(await s.service.staffPatientProfile('patient-a',s.context)).toEqual({patientId:'patient-a',version:4,
    firstName:'Synthetic',lastName:'Patient',fullName:'Synthetic Patient',dateOfBirth:null,gender:null});
});
it('withholds profiles when consent or the selected patient changes',async()=>{
  const s=setup();s.provider.authorize.mockResolvedValue({allowed:false,breakGlass:false});
  await expect(s.service.staffPatientProfile('patient-a',s.context)).rejects.toThrow('not authorized');
  expect(s.provider.lookupPatientId).not.toHaveBeenCalled();
  s.provider.authorize.mockResolvedValue({allowed:true,breakGlass:false});s.provider.lookupPatientId.mockResolvedValue({id:'other'} as never);
  await expect(s.service.staffPatientProfile('patient-a',s.context)).rejects.toThrow('not found');
});
it('requires an authenticated EHR workload as well as staff authorization',async()=>{
  const service=jest.fn(),workload=jest.fn();const controller=new IdentityController({staffPatientProfile:service} as never,{authenticateService:workload} as never);
  await expect(controller.staffChatProfile('patient-a',{header:()=>undefined} as never)).rejects.toThrow('EHR workload');
  expect(service).not.toHaveBeenCalled();expect(workload).not.toHaveBeenCalled();
});

it('provides read-only authorization to approved clinical workloads without accepting patient-self or emergency use',async()=>{
 const authorize=jest.fn().mockResolvedValue({allowed:true}),workload=jest.fn();
 const controller=new IdentityController({authorize} as never,{authenticateService:workload} as never);
 const request={actor:{kind:'staff',accountId:'staff-a',facility:{membershipId:'membership-a'}},facilityId:'facility-a',correlationId:'synthetic-read',
   header:(name:string)=>name==='x-hid-internal-caller'?'ehr-api':name==='x-purpose-of-use'?'direct-care':name==='cookie'?'synthetic-cookie':undefined} as never;
 await expect(controller.staffRecordRead('patient-a',request)).resolves.toEqual({allowed:true});
 expect(authorize).toHaveBeenCalledWith('patient-a','read_records','direct-care',expect.objectContaining({facilityId:'facility-a'}));
 await expect(controller.staffRecordRead('patient-a',{...request as object,actor:{kind:'patient'}} as never)).rejects.toThrow('Staff direct-care');
 const unknown={...request as object,header:()=> 'unknown'} as never;
 await expect(controller.staffRecordRead('patient-a',unknown)).rejects.toThrow('workload');
});
