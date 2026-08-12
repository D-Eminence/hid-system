import { getEnvironment,resetEnvironmentForTests } from './environment';

describe('Lab production workload configuration',()=>{
 const original={...process.env};
 afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);resetEnvironmentForTests();});
 const production=()=>Object.assign(process.env,{NODE_ENV:'production',LAB_DATABASE_URL:'postgresql://lab:test@db.example/hid',DATABASE_SSL:'true',DATABASE_SSL_ROOT_CERT_BASE64:'Y2E=',DATABASE_POOL_MAX:'10',CORS_ORIGINS:'https://app.example',TRUST_PROXY_CIDRS:'10.0.0.0/8',IDENTITY_API_URL:'https://identity.example',IDENTITY_SERVICE_IDENTITY_MODE:'jwt',IDENTITY_LAB_WORKLOAD_TOKEN_FILE:'/var/run/secrets/identity-token',LAB_SERVICE_IDENTITY_MODE:'jwt',LAB_WORKLOAD_ISSUER_URL:'https://issuer.example',LAB_WORKLOAD_AUDIENCE:'hid-lab-api',LAB_WORKLOAD_JWKS_URL:'https://issuer.example/jwks',LAB_EHR_CALLER_SUBJECT:'workload:ehr',LAB_OCR_CALLER_SUBJECT:'workload:ocr'});
 it('accepts an asymmetric audience-bound production configuration',()=>{production();delete process.env.LAB_INTERNAL_SERVICE_TOKEN;resetEnvironmentForTests();expect(getEnvironment().LAB_SERVICE_IDENTITY_MODE).toBe('jwt');});
 it('rejects the local shared-secret mode in production',()=>{production();process.env.LAB_SERVICE_IDENTITY_MODE='local-secret';process.env.LAB_INTERNAL_SERVICE_TOKEN='x'.repeat(32);resetEnvironmentForTests();expect(()=>getEnvironment()).toThrow(/Production Lab API requires JWT workload identity/);});
 it('rejects database URL TLS overrides and a global verification bypass',()=>{production();process.env.LAB_DATABASE_URL+='?sslmode=no-verify';resetEnvironmentForTests();expect(()=>getEnvironment()).toThrow(/must not override/);production();process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';resetEnvironmentForTests();expect(()=>getEnvironment()).toThrow(/cannot be disabled globally/);});
});
