import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { PatientSharesController } from './patient-shares.controller';
import { PatientSharesService } from './patient-shares.service';
import { StaffSharesController } from './staff-shares.controller';

@Module({
  controllers: [ConsentController, PatientSharesController, StaffSharesController],
  providers: [ConsentService, PatientSharesService],
})
export class ConsentModule {}
