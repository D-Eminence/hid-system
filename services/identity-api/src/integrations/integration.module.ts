import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { IntegrationRuntimeService } from './integration-runtime.service';

@Global()
@Module({ imports: [DatabaseModule], providers: [IntegrationRuntimeService], exports: [IntegrationRuntimeService] })
export class IntegrationModule {}
