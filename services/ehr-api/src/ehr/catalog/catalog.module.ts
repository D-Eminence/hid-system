import { Module } from '@nestjs/common';
import { CatalogController, TerminologyController } from './catalog.controller';
import { CatalogService } from './catalog.service';

/** ORD-7 (0149): the medicine and lab-test lists; ORD-9 (0152): the ICD-11 diagnosis search. */
@Module({
  controllers: [CatalogController, TerminologyController],
  providers: [CatalogService],
})
export class CatalogModule {}
