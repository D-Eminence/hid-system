import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { PatientSharesController } from './patient-shares.controller';
import { PatientSharesService } from './patient-shares.service';
import { StaffSharesController } from './staff-shares.controller';
import { WardStayAccessController } from './ward-stay-access.controller';
import { WardStayAccessService } from './ward-stay-access.service';

@Module({
  controllers: [ConsentController, PatientSharesController, StaffSharesController, WardStayAccessController],
  providers: [ConsentService, PatientSharesService, WardStayAccessService],
})
export class ConsentModule {}
