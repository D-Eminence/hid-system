import { Module } from '@nestjs/common';
import { NursingController } from './nursing.controller';
import { NursingService } from './nursing.service';

/** NUR-1 (0174-0177): nursing on the ward, behind NURSING_ENABLED (and ADT-1's INPATIENT_ENABLED). */
@Module({
  controllers: [NursingController],
  providers: [NursingService],
})
export class NursingModule {}
