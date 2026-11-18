import { Module } from '@nestjs/common';
import { PatientSearchController } from './patient-search.controller';
import { PatientSearchService } from './patient-search.service';

/**
 * Lane B (0132): staff patient search with the strong and weak key rule, and
 * emergency search. match-ref.ts is the matchRef reader other packages import.
 */
@Module({
  controllers: [PatientSearchController],
  providers: [PatientSearchService],
  exports: [PatientSearchService],
})
export class PatientSearchModule {}
