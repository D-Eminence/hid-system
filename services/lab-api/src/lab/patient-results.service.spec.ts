import {PatientResultsService} from './patient-results.service';
jest.mock('@hid/api-client',()=>({IdentityApiClient:jest.fn().mockImplementation(()=>({authorizePatientSelf:authorize,authorizeStaffRecordRead:authorizeStaff})),IdentityApiProblem:class extends Error{}}));
jest.mock('../config/environment',()=>({getEnvironment:()=>({IDENTITY_API_URL:'https://identity.example.test'})}));
const authorize=jest.fn(),authorizeStaff=jest.fn();
const auth={patientId:'patient-a',accountId:'account-a',subject:'subject-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
function setup() {
 const query=jest.fn().mockResolvedValue({rows:[{id:'result-a',version:'2:release-a',fields:{numericValue:'12.7'}}]});
 const transaction=jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({query}));
 const service=new PatientResultsService({withPatientTransaction:transaction} as never,{identityHeaders:jest.fn()} as never,{recordWithClient:jest.fn()} as never);
 const request={actor:{kind:'patient',...auth},correlationId:'synthetic-lab',header:()=>undefined} as never;
 return {service,request,query,transaction};
}
beforeEach(()=>authorize.mockResolvedValue(auth));
it('derives the patient from fresh Identity authorization and uses exact release/verification/invalidation joins',async()=>{
 const s=setup();expect((await s.service.read(s.request)).records).toHaveLength(1);
 expect(s.query.mock.calls[0][1]).toEqual(['patient-a','']);
 expect(s.query.mock.calls[0][0]).toContain('result_invalidations');expect(s.query.mock.calls[0][0]).toContain('result_verifications');
});
it('rejects a mismatched authorization before querying results',async()=>{
 const s=setup();authorize.mockResolvedValue({...auth,patientId:'other-patient'});
 await expect(s.service.read(s.request)).rejects.toThrow('authorization changed');expect(s.transaction).not.toHaveBeenCalled();
});
it('rejects staff sessions and invalid cursors without exposing any result metadata',async()=>{
 const s=setup();await expect(s.service.read({actor:{kind:'staff'},correlationId:'synthetic-lab',header:()=>undefined} as never)).rejects.toThrow('patient session');
 await expect(s.service.read(s.request,'invalid cursor')).rejects.toThrow('Invalid record cursor');expect(s.query).not.toHaveBeenCalled();
});

function staffSetup() {
 const query=jest.fn().mockResolvedValue({rows:[{id:'result-a',fields:{numericValue:'20.05'}}]});
 const transaction=jest.fn(async(_context,work)=>work({query}));
 const service=new PatientResultsService({withTransaction:transaction} as never,{identityHeaders:jest.fn()} as never,{recordWithClient:jest.fn()} as never);
 const request={actor:{kind:'staff',sessionId:'session-a',accountId:'account-a',subject:'staff-a',permissions:['lab.result.released.read'],facility:{membershipId:'membership-a'}},
   facilityId:'facility-a',correlationId:'staff-lab-synthetic',header:(name:string)=>name==='x-purpose-of-use'?'direct-care':name==='cookie'?'synthetic-session':undefined} as never;
 authorizeStaff.mockResolvedValue({allowed:true,breakGlass:false,patientId:'patient-a',facilityId:'facility-a',membershipId:'membership-a'});
 return {service,request,query,transaction};
}
it('reads exact current released results under the delegated staff facility and consent context',async()=>{
 const s=staffSetup();const result=await s.service.readStaff(s.request,'patient-a');
 expect(result.records[0].fields.numericValue).toBe('20.05');expect(s.query.mock.calls[0][1]).toEqual(['patient-a','']);
 expect(s.transaction.mock.calls[0]![0]).toMatchObject({facilityId:'facility-a',membershipId:'membership-a',purposeOfUse:'direct-care'});
});
it.each([{allowed:false},{breakGlass:true},{membershipId:'other'},{patientId:'other'}])('withholds Lab results after a denied or mismatched staff decision %j',async patch=>{
 const s=staffSetup();authorizeStaff.mockResolvedValue({allowed:true,breakGlass:false,patientId:'patient-a',facilityId:'facility-a',membershipId:'membership-a',...patch});
 await expect(s.service.readStaff(s.request,'patient-a')).rejects.toThrow('not authorized');expect(s.query).not.toHaveBeenCalled();
});
it('does not use patient-self credentials or absent released-result permission for the staff collection',async()=>{
 const s=staffSetup();await expect(s.service.readStaff({...s.request as object,actor:{kind:'patient'}} as never,'patient-a')).rejects.toThrow('permission');
 await expect(s.service.readStaff({...s.request as object,actor:{kind:'staff',sessionId:'a',permissions:[]}} as never,'patient-a')).rejects.toThrow('permission');
 expect(s.query).not.toHaveBeenCalled();
});
