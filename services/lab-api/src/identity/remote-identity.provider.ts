import { Injectable } from '@nestjs/common';
import { IdentityApiClient,IdentityApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import type { AuthorizationDecision,AuthorizationRequest,ConsentStatus,IdentityPatient,IdentityProvider } from './identity.types';
import type { DataAccessContext,PurposeOfUse } from '../common/request-context';
import { LabWorkloadIdentityService } from '../auth/lab-workload-identity.service';

@Injectable()
export class RemoteIdentityProvider implements IdentityProvider {
 private readonly client:IdentityApiClient;
 constructor(workloadIdentity:LabWorkloadIdentityService){this.client=new IdentityApiClient({baseUrl:getEnvironment().IDENTITY_API_URL,caller:'lab-api',timeoutMs:5000,workloadHeaders:()=>workloadIdentity.identityHeaders()});}
 async authorize(request:AuthorizationRequest):Promise<AuthorizationDecision>{
  const context=request.context;if(!context.authorization&&!context.userCookie)throw new DomainProblem(401,'SERVICE_CONTEXT_REQUIRED','Verified actor delegation is required');
  return this.client.authorizePatient(request.patientId,request.scope,request.purpose,
   {authorization:context.authorization,cookie:context.userCookie,csrfToken:context.csrfToken,
    origin:context.origin,correlationId:context.correlationId,facilityId:context.facilityId,
    purposeOfUse:request.purpose})
   .catch(error=>{if(error instanceof IdentityApiProblem)throw new DomainProblem(error.status,error.code??'IDENTITY_AUTHORIZATION_DENIED',error.message);throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Identity authorization service is unavailable');}) as Promise<AuthorizationDecision>;
 }
 lookupExactHid(_hid:string,_context:DataAccessContext):Promise<IdentityPatient|null>{throw new DomainProblem(501,'IDENTITY_OPERATION_UNAVAILABLE','Lab does not perform identity lookup');}
 consentStatus(_patientId:string,_purpose:PurposeOfUse,_context:DataAccessContext):Promise<ConsentStatus>{throw new DomainProblem(501,'IDENTITY_OPERATION_UNAVAILABLE','Lab uses explicit authorization decisions');}
}
