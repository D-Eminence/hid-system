import { Module } from '@nestjs/common';
import { CatalogController, TerminologyController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { RecentDiagnosesService } from './recent-diagnoses.service';
import { LAB_REQUEST_GROUPS_PROVIDER } from '../lab-requests/lab-request-groups';
import { NAME_ONLY_CODES_PROVIDER } from '../shared/name-only-codes';

/**
 * ORD-7 (0149): the medicine and lab-test lists; ORD-9: the ICD-11 diagnosis
 * search (0152) and each member's recent diagnoses (0153).
 */
@Module({
  controllers: [CatalogController, TerminologyController],
  // NameOnlyCodes: the status's labTestNameOnly and diagnosisNameOnly (0156); LabRequestGroups: its
  // labRequestGroups (ORD-6, 0158).
  providers: [CatalogService, RecentDiagnosesService, NAME_ONLY_CODES_PROVIDER, LAB_REQUEST_GROUPS_PROVIDER],
})
export class CatalogModule {}
