import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { OpenPatientStartupCheck } from '../auth/open-patient';
import { IdentityModule } from '../identity/identity.module';
import { OpenPatientController } from './open-patient.controller';
import { OpenPatientOffMiddleware } from './open-patient-off.middleware';
import { OpenPatientService } from './open-patient.service';

/**
 * SX-8 (0140): keep the open patient across a reload. Its own module because
 * it needs IdentityModule's access check (IdentityService.precheck) while
 * AuthModule, which IdentityModule imports, reports it on GET /auth/session:
 * AuthController resolves OpenPatientService through ModuleRef when it is
 * needed, so neither module imports the other in a cycle. DatabaseService
 * and AuditService come from the global modules. OpenPatientStartupCheck
 * refuses to start with STAFF_OPEN_PATIENT_ENABLED=true while 0140's table or
 * one of its grants is missing.
 */
@Module({
  imports: [IdentityModule],
  controllers: [OpenPatientController],
  providers: [OpenPatientService, OpenPatientStartupCheck],
  exports: [OpenPatientService],
})
export class OpenPatientModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OpenPatientOffMiddleware).forRoutes(OpenPatientController);
  }
}
