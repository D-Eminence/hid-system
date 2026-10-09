import { Module } from '@nestjs/common';
import { OcrInternalCallerGuard } from '../../auth/ocr-internal-caller.guard';
import { DocumentModule } from '../../documents/document.module';
import { ClinicalNotesModule } from '../clinical-notes/clinical-notes.module';
import { OcrIntegrationController } from './ocr-integration.controller';

@Module({
  imports: [DocumentModule, ClinicalNotesModule],
  controllers: [OcrIntegrationController],
  providers: [OcrInternalCallerGuard],
})
export class OcrIntegrationModule {}
