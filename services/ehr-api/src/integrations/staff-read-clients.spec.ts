import { IdentityApiClient, LabApiClient } from '@hid/api-client';
const patientId='11111111-1111-4111-8111-111111111111';
const facilityId='22222222-2222-4222-8222-222222222222';
afterEach(()=>jest.restoreAllMocks());
it('delegates record read authorization as a safe GET with workload identity and user cookie, without inventing CSRF evidence',async()=>{
  const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({allowed:true,patientId,facilityId,
    membershipId:'33333333-3333-4333-8333-333333333333',scope:'read_records',purpose:'direct-care',breakGlass:false}),{headers:{'content-type':'application/json'}}));
  const client=new IdentityApiClient({baseUrl:'https://identity.example.test',caller:'ehr-api',workloadHeaders:async()=>({'x-hid-service-authorization':'Bearer synthetic-workload'})});
  await client.authorizeStaffRecordRead(patientId,{correlationId:'synthetic',facilityId,cookie:'hid_access=synthetic',origin:'https://ehr.example.test'});
  const [url,options]=fetch.mock.calls[0]!;
  expect(String(url)).toContain(`/service/patients/${patientId}/record-read-authorization`);expect(options?.method).toBe('GET');
  const headers=new Headers(options?.headers);expect(headers.get('cookie')).toBe('hid_access=synthetic');
  expect(headers.get('x-hid-service-authorization')).toBe('Bearer synthetic-workload');expect(headers.get('x-purpose-of-use')).toBe('direct-care');
  expect(headers.has('x-csrf-token')).toBe(false);expect(options?.body).toBeUndefined();
});
it('delegates named-patient Lab collection with the selected facility and EHR workload identity',async()=>{
  const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({records:[],nextCursor:null}),{headers:{'content-type':'application/json'}}));
  const client=new LabApiClient({baseUrl:'https://lab.example.test',serviceAuthorizationProvider:async()=> 'Bearer synthetic-workload'});
  await client.staffReleasedResults(patientId,{correlationId:'synthetic',facilityId,purposeOfUse:'direct-care',cookie:'hid_access=synthetic'});
  const [url,options]=fetch.mock.calls[0]!;
  expect(String(url)).toContain(`/internal/patients/${patientId}/released-results`);expect(options?.method).toBe('GET');
  const headers=new Headers(options?.headers);expect(headers.get('x-hid-internal-caller')).toBe('ehr-api');
  expect(headers.get('x-facility-id')).toBe(facilityId);expect(headers.get('cookie')).toBe('hid_access=synthetic');
});
