import { CanActivate,ExecutionContext,Injectable } from '@nestjs/common';
import { createHash,timingSafeEqual } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { IdentityApiClient,IdentityApiProblem } from '@hid/api-client';
import { FACILITY_OPTIONAL,PUBLIC_ROUTE,REQUIRED_PERMISSIONS } from '../common/decorators';
import { INTERNAL_CALLER } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext,HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { LabWorkloadIdentityService } from './lab-workload-identity.service';

@Injectable()
export class LabRemoteSecurityGuard implements CanActivate {
 private readonly identity:IdentityApiClient;
 constructor(private readonly reflector:Reflector,private readonly workloadIdentity:LabWorkloadIdentityService){
  this.identity=new IdentityApiClient({baseUrl:getEnvironment().IDENTITY_API_URL,caller:'lab-api',timeoutMs:5000,workloadHeaders:()=>this.workloadIdentity.identityHeaders()});
 }
 async canActivate(execution:ExecutionContext){
  if(this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE,[execution.getHandler(),execution.getClass()]))return true;
  const request=execution.switchToHttp().getRequest<HidRequest>();
  const internalCaller=this.reflector.getAllAndOverride<'ehr-api'|'ocr-api'>(INTERNAL_CALLER,[execution.getHandler(),execution.getClass()]);
  if(internalCaller){const environment=getEnvironment();if(request.header('x-hid-internal-caller')!==internalCaller)throw new DomainProblem(401,'INTERNAL_SERVICE_AUTH_REQUIRED','Authenticated internal service identity is required');if(environment.LAB_SERVICE_IDENTITY_MODE==='jwt')await this.workloadIdentity.authenticate(internalCaller,request.header('x-hid-service-authorization'));else if(!environment.LAB_INTERNAL_SERVICE_TOKEN||!this.equal(request.header('x-hid-service-token'),environment.LAB_INTERNAL_SERVICE_TOKEN))throw new DomainProblem(401,'INTERNAL_SERVICE_AUTH_REQUIRED','Authenticated internal service identity is required');}
  const authorization=request.header('authorization');const cookie=request.header('cookie');
  if(!authorization?.startsWith('Bearer ')&&!cookie)throw new DomainProblem(401,'AUTHENTICATION_REQUIRED','Valid Identity authentication is required by the Lab service');
  const actor=await this.identity.authenticateActor({authorization,cookie,
    csrfToken:request.header('x-csrf-token'),origin:request.header('origin'),
    validateMutation:Boolean(cookie&&!authorization&&!['GET','HEAD','OPTIONS'].includes(request.method)),
    correlationId:request.correlationId,facilityId:request.header('x-facility-id')})
    .catch(error=>{if(error instanceof IdentityApiProblem)throw new DomainProblem(error.status,error.code??'AUTHENTICATION_REQUIRED',error.message);throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Identity authentication service is unavailable');}) as ActorContext;
  const facilityId=request.header('x-facility-id');const optional=this.reflector.getAllAndOverride<boolean>(FACILITY_OPTIONAL,[execution.getHandler(),execution.getClass()]);
  const assignment=facilityId?actor.facilities.find(item=>item.id===facilityId):undefined;
  if(!optional&&(!facilityId||!assignment))throw new DomainProblem(403,'FACILITY_ACCESS_DENIED','Identity did not authorize the actor at this facility');
  request.facilityId=facilityId;request.authTransport=authorization?'bearer':'cookie';request.actor=assignment?{...actor,facility:assignment,roles:assignment.roles,role:assignment.roles[0],permissions:assignment.permissions}:actor;
  const required=this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_PERMISSIONS,[execution.getHandler(),execution.getClass()])??[];
  if(required.some(permission=>!request.actor?.permissions.includes(permission)))throw new DomainProblem(403,'PERMISSION_DENIED','Required Lab permission is missing');
  return true;
 }
 private equal(candidate:string|undefined,expected:string){if(!candidate)return false;return timingSafeEqual(createHash('sha256').update(candidate).digest(),createHash('sha256').update(expected).digest());}
}
