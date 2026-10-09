jest.mock('jose',()=>({createRemoteJWKSet:jest.fn(()=>jest.fn()),jwtVerify:jest.fn()}));
import { jwtVerify } from 'jose';
import { resetEnvironmentForTests } from '../config/environment';
import { LabWorkloadIdentityService } from './lab-workload-identity.service';

describe('LabWorkloadIdentityService',()=>{
 beforeEach(()=>{Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://test:test@localhost:5432/hid',DATABASE_SSL:'false',CORS_ORIGINS:'http://localhost:3000',LAB_SERVICE_IDENTITY_MODE:'jwt',LAB_WORKLOAD_ISSUER_URL:'https://issuer.test',LAB_WORKLOAD_AUDIENCE:'hid-lab-api',LAB_WORKLOAD_JWKS_URL:'https://issuer.test/jwks',LAB_EHR_CALLER_SUBJECT:'workload:ehr',LAB_OCR_CALLER_SUBJECT:'workload:ocr'});resetEnvironmentForTests();jest.mocked(jwtVerify).mockReset();});
 it('accepts the exact issuer, audience, and EHR subject',async()=>{jest.mocked(jwtVerify).mockResolvedValue({payload:{sub:'workload:ehr'},protectedHeader:{alg:'RS256'}} as never);await expect(new LabWorkloadIdentityService().authenticate('ehr-api','Bearer signed-token')).resolves.toBeUndefined();expect(jwtVerify).toHaveBeenCalledWith('signed-token',expect.any(Function),expect.objectContaining({issuer:'https://issuer.test',audience:'hid-lab-api'}));});
 it('rejects a valid token belonging to another workload',async()=>{jest.mocked(jwtVerify).mockResolvedValue({payload:{sub:'workload:ocr'},protectedHeader:{alg:'RS256'}} as never);await expect(new LabWorkloadIdentityService().authenticate('ehr-api','Bearer signed-token')).rejects.toMatchObject({status:403,code:'WORKLOAD_CALLER_DENIED'});});
 it('rejects a missing workload bearer independently of user auth',async()=>{await expect(new LabWorkloadIdentityService().authenticate('ocr-api',undefined)).rejects.toMatchObject({status:401,code:'INTERNAL_SERVICE_AUTH_REQUIRED'});});
 it('rejects an oversized workload token before JOSE processing',async()=>{await expect(new LabWorkloadIdentityService().authenticate('ehr-api',`Bearer ${'x'.repeat(16_385)}`)).rejects.toMatchObject({status:401,code:'INVALID_WORKLOAD_IDENTITY'});expect(jwtVerify).not.toHaveBeenCalled();});
});
