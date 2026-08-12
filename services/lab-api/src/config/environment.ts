import { isIP } from 'node:net';
import { z } from 'zod';

const emptyToUndefined=(value:unknown)=>typeof value==='string'&&value.trim()===''?undefined:value;
const optionalString=z.preprocess(emptyToUndefined,z.string().trim().min(1).optional());
const optionalUrl=z.preprocess(emptyToUndefined,z.string().url().optional());
const optionalSecret=z.preprocess(emptyToUndefined,z.string().min(32).optional());
const booleanString=z.enum(['true','false']).default('false').transform(value=>value==='true');
function validProxy(value:string){const [address,prefix,extra]=value.split('/');if(!address||extra!==undefined)return false;const version=isIP(address);if(!version)return false;if(prefix===undefined)return true;if(!/^\d{1,3}$/.test(prefix))return false;const bits=Number(prefix);return bits>=0&&bits<=(version===4?32:128);}
function databaseUrlOverridesTls(connectionString:string){const url=new URL(connectionString);return ['ssl','sslmode','sslcert','sslkey','sslrootcert','sslnegotiation'].some(parameter=>url.searchParams.has(parameter));}

const environmentSchema=z.object({
 NODE_ENV:z.enum(['development','test','production']).default('development'),
 NODE_TLS_REJECT_UNAUTHORIZED:optionalString,
 PORT:z.coerce.number().int().min(1).max(65535).default(3003),
 DATABASE_URL:z.string().url().startsWith('postgresql://'),DATABASE_SSL:booleanString,
 DATABASE_SSL_ROOT_CERT_BASE64:optionalString,DATABASE_POOL_MAX:z.coerce.number().int().min(2).max(100).default(10),
 CORS_ORIGINS:z.string().min(1),TRUST_PROXY_CIDRS:optionalString,
 IDENTITY_API_URL:z.string().url().default('http://127.0.0.1:3001'),
 IDENTITY_SERVICE_IDENTITY_MODE:z.enum(['local-secret','jwt']).default('local-secret'),
 IDENTITY_LAB_INTERNAL_SERVICE_TOKEN:optionalSecret,
 IDENTITY_LAB_WORKLOAD_TOKEN_FILE:optionalString,
 LAB_INTERNAL_SERVICE_TOKEN:optionalSecret,
 LAB_SERVICE_IDENTITY_MODE:z.enum(['local-secret','jwt']).default('local-secret'),
 LAB_WORKLOAD_ISSUER_URL:optionalUrl,LAB_WORKLOAD_AUDIENCE:optionalString,LAB_WORKLOAD_JWKS_URL:optionalUrl,
 LAB_EHR_CALLER_SUBJECT:optionalString,LAB_OCR_CALLER_SUBJECT:optionalString,
}).superRefine((environment,context)=>{
 if(environment.LAB_SERVICE_IDENTITY_MODE==='local-secret'&&!environment.LAB_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['LAB_INTERNAL_SERVICE_TOKEN'],message:'Local service identity requires an ephemeral secret'});
 if(environment.LAB_SERVICE_IDENTITY_MODE==='jwt')for(const key of ['LAB_WORKLOAD_ISSUER_URL','LAB_WORKLOAD_AUDIENCE','LAB_WORKLOAD_JWKS_URL','LAB_EHR_CALLER_SUBJECT','LAB_OCR_CALLER_SUBJECT'] as const)if(!environment[key])context.addIssue({code:'custom',path:[key],message:`${key} is required for JWT workload identity`});
 if(environment.IDENTITY_SERVICE_IDENTITY_MODE==='jwt'&&!environment.IDENTITY_LAB_WORKLOAD_TOKEN_FILE)context.addIssue({code:'custom',path:['IDENTITY_LAB_WORKLOAD_TOKEN_FILE'],message:'IDENTITY_LAB_WORKLOAD_TOKEN_FILE is required for JWT Identity calls'});
 if(environment.NODE_ENV==='production'){
  if(environment.NODE_TLS_REJECT_UNAUTHORIZED==='0')context.addIssue({code:'custom',path:['NODE_TLS_REJECT_UNAUTHORIZED'],message:'Production TLS verification cannot be disabled globally'});
  if(databaseUrlOverridesTls(environment.DATABASE_URL))context.addIssue({code:'custom',path:['DATABASE_URL'],message:'Production database URL must not override verified TLS configuration'});
  if(environment.LAB_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['LAB_SERVICE_IDENTITY_MODE'],message:'Production Lab API requires JWT workload identity'});
  if(environment.IDENTITY_SERVICE_IDENTITY_MODE!=='jwt')context.addIssue({code:'custom',path:['IDENTITY_SERVICE_IDENTITY_MODE'],message:'Production Identity calls require JWT workload identity'});
  if(environment.LAB_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['LAB_INTERNAL_SERVICE_TOKEN'],message:'Local shared-token authentication is forbidden in production'});
  if(environment.IDENTITY_LAB_INTERNAL_SERVICE_TOKEN)context.addIssue({code:'custom',path:['IDENTITY_LAB_INTERNAL_SERVICE_TOKEN'],message:'Local Identity service tokens are forbidden in production'});
  if(!environment.DATABASE_SSL)context.addIssue({code:'custom',path:['DATABASE_SSL'],message:'TLS is required in production'});
  if(!environment.DATABASE_SSL_ROOT_CERT_BASE64)context.addIssue({code:'custom',path:['DATABASE_SSL_ROOT_CERT_BASE64'],message:'The PostgreSQL CA certificate is required in production'});
  if(!environment.TRUST_PROXY_CIDRS)context.addIssue({code:'custom',path:['TRUST_PROXY_CIDRS'],message:'Approved reverse-proxy CIDRs are required in production'});
  else if(environment.TRUST_PROXY_CIDRS.split(',').map(v=>v.trim()).some(v=>!validProxy(v)))context.addIssue({code:'custom',path:['TRUST_PROXY_CIDRS'],message:'Only explicit IP addresses or CIDRs are allowed'});
  for(const [key,value] of [['IDENTITY_API_URL',environment.IDENTITY_API_URL],['LAB_WORKLOAD_ISSUER_URL',environment.LAB_WORKLOAD_ISSUER_URL],['LAB_WORKLOAD_JWKS_URL',environment.LAB_WORKLOAD_JWKS_URL]] as const)if(value&&new URL(value).protocol!=='https:')context.addIssue({code:'custom',path:[key],message:`${key} must use HTTPS in production`});
  for(const origin of environment.CORS_ORIGINS.split(',').map(v=>v.trim()))try{const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin)throw new Error();}catch{context.addIssue({code:'custom',path:['CORS_ORIGINS'],message:'Production origins must be exact HTTPS origins'});break;}
 }
});

export type Environment=z.infer<typeof environmentSchema>;
let cachedEnvironment:Environment|undefined;
export function getEnvironment():Environment{if(cachedEnvironment)return cachedEnvironment;const result=environmentSchema.safeParse({...process.env,DATABASE_URL:process.env.LAB_DATABASE_URL??process.env.DATABASE_URL});if(!result.success)throw new Error(`Invalid Lab configuration: ${result.error.issues.map(issue=>`${issue.path.join('.')||'environment'}: ${issue.message}`).join('; ')}`);cachedEnvironment=result.data;return result.data;}
export function resetEnvironmentForTests(){cachedEnvironment=undefined;}
