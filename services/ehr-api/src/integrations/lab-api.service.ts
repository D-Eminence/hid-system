import { Injectable } from '@nestjs/common';
import { LabApiClient,LabApiProblem } from '@hid/api-client';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';

@Injectable()
export class LabApiService {
  private readonly client:LabApiClient;
  constructor(workloadIdentity:ServiceWorkloadIdentityService){const environment=getEnvironment();this.client=new LabApiClient({baseUrl:environment.LAB_API_URL,timeoutMs:10_000,internalServiceToken:environment.LAB_INTERNAL_SERVICE_TOKEN,
    ...(environment.LAB_SERVICE_IDENTITY_MODE==='jwt'?{serviceAuthorizationProvider:()=>workloadIdentity.authorization('lab')}:{})});}
  acceptEhrOrder(context:DataAccessContext,input:unknown,key:string) {return this.translate(this.client.acceptEhrOrder(input,this.context(context),key));}
  private context(context:DataAccessContext) {
    if(!context.authorization&&!context.userCookie) throw new DomainProblem(503,'LAB_SERVICE_AUTH_UNAVAILABLE','Authenticated Lab service delegation is unavailable');
    return {authorization:context.authorization,cookie:context.userCookie,csrfToken:context.csrfToken,
      origin:context.origin,correlationId:context.correlationId,facilityId:context.facilityId,
      purposeOfUse:context.purposeOfUse};
  }
  private async translate<T>(operation:Promise<T>):Promise<T>{try{return await operation;}catch(error){if(error instanceof LabApiProblem){const payload=error.payload as {code?:unknown;detail?:unknown};throw new DomainProblem(error.status,typeof payload?.code==='string'?payload.code:'LAB_SERVICE_ERROR',typeof payload?.detail==='string'?payload.detail:'Lab service request failed');}throw new DomainProblem(503,'LAB_SERVICE_UNAVAILABLE','Lab service is unavailable');}}
}
