import { StaffChatScopeService } from './staff-chat-scope.service';
const assignment={id:'facility-a',membershipId:'membership-a',permissions:['ehr.note.read','ehr.prescription.read']};
const actor={kind:'staff',subject:'staff-a',accountId:'account-a',sessionId:'session-a',facilities:[assignment],facility:assignment};
const decision={allowed:true,patientId:'patient-a',facilityId:'facility-a',membershipId:'membership-a',purpose:'direct-care',scope:'read_records',breakGlass:false};
function setup() {
  const fresh=jest.fn().mockResolvedValue(actor),authorize=jest.fn().mockResolvedValue(decision),query=jest.fn().mockResolvedValue({rows:[]});
  const transaction=jest.fn(async(_context,work)=>work({query}));
  const service=new StaffChatScopeService({withTransaction:transaction} as never,{authenticateRequest:fresh,staffRecordRead:authorize} as never);
  const request={actor,facilityId:'facility-a',correlationId:'synthetic-staff',header:(name:string)=>name==='x-purpose-of-use'?'direct-care':undefined} as never;
  return {service,request,fresh,authorize,transaction,query};
}
it('uses fresh staff consent and per-kind permissions, and establishes a short-lived patient-bound database scope',async()=>{
  const s=setup(),scope=await s.service.open(s.request,'patient-a');
  expect(scope.allows('prescription')).toBe(true);expect(scope.allows('lab_result')).toBe(false);
  expect(scope.admissionKey).toBe('staff:account-a:facility-a');
  await scope.transaction(await scope.authorize(s.request),'synthetic',async()=>42);
  expect(s.query.mock.calls[0][1]).toEqual(['patient-a','account-a',expect.any(String),expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(s.transaction.mock.calls[0]![0]).toMatchObject({facilityId:'facility-a',membershipId:'membership-a',purposeOfUse:'direct-care'});
});
it.each(['patient','membership','session','permission'])('rejects changed %s before using any stored evidence',async change=>{
  const s=setup(),scope=await s.service.open(s.request,'patient-a');
  if(change==='patient')s.fresh.mockResolvedValue({...actor,kind:'patient'});
  if(change==='membership')s.fresh.mockResolvedValue({...actor,facilities:[{...assignment,membershipId:'other'}]});
  if(change==='session')s.fresh.mockResolvedValue({...actor,sessionId:'other'});
  if(change==='permission')s.fresh.mockResolvedValue({...actor,facilities:[{...assignment,permissions:['ehr.note.read']}]});
  await expect(scope.authorize(s.request)).rejects.toThrow();expect(s.transaction).not.toHaveBeenCalled();
});
it.each([{allowed:false},{breakGlass:true},{patientId:'other'},{membershipId:'other'},{facilityId:'other'}])('denies a mismatched/revoked consent decision %j',async patch=>{
  const s=setup();s.authorize.mockResolvedValue({...decision,...patch});
  await expect(s.service.open(s.request,'patient-a')).rejects.toThrow('consent');expect(s.transaction).not.toHaveBeenCalled();
});
it('rejects emergency purpose and patient actors before any Identity or database call',async()=>{
  const s=setup();
  await expect(s.service.open({...s.request as object,header:()=> 'emergency'} as never,'patient-a')).rejects.toThrow('direct-care');
  await expect(s.service.open({...s.request as object,actor:{...actor,kind:'patient'}} as never,'patient-a')).rejects.toThrow('consent');
  expect(s.fresh).not.toHaveBeenCalled();
});
