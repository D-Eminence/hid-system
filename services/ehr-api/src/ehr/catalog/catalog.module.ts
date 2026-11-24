import { Module } from '@nestjs/common';
import { CatalogController, TerminologyController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { RecentDiagnosesService } from './recent-diagnoses.service';

/**
 * ORD-7 (0149): the medicine and lab-test lists; ORD-9: the ICD-11 diagnosis
 * search (0152) and each member's recent diagnoses (0151).
 */
@Module({
  controllers: [CatalogController, TerminologyController],
  providers: [CatalogService, RecentDiagnosesService],
})
export class CatalogModule {}
