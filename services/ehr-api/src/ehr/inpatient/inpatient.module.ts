import { Module } from '@nestjs/common';
import { InpatientChargesController, InpatientController } from './inpatient.controller';
import { InpatientBedDaySweeper, InpatientService } from './inpatient.service';

/** ADT-1 (0170-0173): inpatient admission, wards and beds, behind INPATIENT_ENABLED. */
@Module({
  controllers: [InpatientController, InpatientChargesController],
  providers: [InpatientService, InpatientBedDaySweeper],
})
export class InpatientModule {}
