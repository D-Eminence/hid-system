import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { RemoteIdentityProvider } from './remote-identity.provider';
import { IDENTITY_PROVIDER } from './identity.types';
@Module({providers:[IdentityService,RemoteIdentityProvider,{provide:IDENTITY_PROVIDER,useExisting:RemoteIdentityProvider}],exports:[IdentityService]})
export class LabIdentityAuthorizationModule {}
