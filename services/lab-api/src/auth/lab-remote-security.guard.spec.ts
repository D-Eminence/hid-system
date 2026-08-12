jest.mock('jose',()=>({createRemoteJWKSet:jest.fn(()=>jest.fn()),jwtVerify:jest.fn()}));
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { IdentityApiClient } from '@hid/api-client';
import { resetEnvironmentForTests } from '../config/environment';
import { LabRemoteSecurityGuard } from './lab-remote-security.guard';

describe('LabRemoteSecurityGuard',()=>{
 it('rejects an internal command without authenticated caller evidence',async()=>{
  process.env.DATABASE_URL='postgresql://test:test@localhost:5432/hid';process.env.DATABASE_SSL='false';process.env.CORS_ORIGINS='http://localhost:3000';process.env.LAB_INTERNAL_SERVICE_TOKEN='z'.repeat(32);
  const reflector={getAllAndOverride:jest.fn().mockReturnValueOnce(false).mockReturnValueOnce('ehr-api')} as unknown as Reflector;
  const request={header:jest.fn().mockReturnValue(undefined),correlationId:'test-correlation'};
  const execution={getHandler:()=>null,getClass:()=>null,switchToHttp:()=>({getRequest:()=>request})} as unknown as ExecutionContext;
  const workload={authenticate:jest.fn()} as never;
 await expect(new LabRemoteSecurityGuard(reflector,workload).canActivate(execution)).rejects.toMatchObject({status:401,code:'INTERNAL_SERVICE_AUTH_REQUIRED'});
 });

 it('revalidates a propagated cookie mutation and establishes cookie actor context',async()=>{
  Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost:5432/hid',DATABASE_SSL:'false',CORS_ORIGINS:'https://ehr.test',LAB_SERVICE_IDENTITY_MODE:'local-secret',LAB_INTERNAL_SERVICE_TOKEN:'z'.repeat(32)});resetEnvironmentForTests();
  const facilityId='123e4567-e89b-42d3-a456-426614174001';
  const actor={id:'actor-1',subject:'staff:test',accountId:'123e4567-e89b-42d3-a456-426614174002',roles:[],permissions:[],facilityIds:[facilityId],facilities:[{id:facilityId,membershipId:'123e4567-e89b-42d3-a456-426614174003',organizationId:'123e4567-e89b-42d3-a456-426614174004',name:'Test',roles:['clinician'],permissions:['lab.work-item.write'],isPrimary:true}],authenticationMethod:'local' as const};
  const authenticate=jest.spyOn(IdentityApiClient.prototype,'authenticateActor').mockResolvedValue(actor);
  const values:Record<string,string>={'x-hid-internal-caller':'ehr-api','x-hid-service-token':'z'.repeat(32),cookie:'hid_access=session; hid_access_csrf=csrf','x-csrf-token':'csrf',origin:'https://ehr.test','x-facility-id':facilityId};
  const request={header:jest.fn((name:string)=>values[name.toLowerCase()]),correlationId:'test-correlation',method:'POST'};
  const reflector={getAllAndOverride:jest.fn()
    .mockReturnValueOnce(false).mockReturnValueOnce('ehr-api').mockReturnValueOnce(false)
    .mockReturnValueOnce(['lab.work-item.write'])} as unknown as Reflector;
  const execution={getHandler:()=>null,getClass:()=>null,switchToHttp:()=>({getRequest:()=>request})} as unknown as ExecutionContext;

  await expect(new LabRemoteSecurityGuard(reflector,{authenticate:jest.fn()} as never)
    .canActivate(execution)).resolves.toBe(true);
  expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({cookie:values.cookie,
    csrfToken:'csrf',origin:'https://ehr.test',validateMutation:true}));
  expect(request).toMatchObject({facilityId,authTransport:'cookie'});
  authenticate.mockRestore();
 });
});
