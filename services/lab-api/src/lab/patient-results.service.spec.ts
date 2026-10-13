import {PatientResultsService} from './patient-results.service';
jest.mock('@hid/api-client',()=>({IdentityApiClient:jest.fn().mockImplementation(()=>({authorizePatientSelf:authorize})),IdentityApiProblem:class extends Error{}}));
jest.mock('../config/environment',()=>({getEnvironment:()=>({IDENTITY_API_URL:'https://identity.example.test'})}));
const authorize=jest.fn();
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
