import { Module } from '@nestjs/common';
import { OcrController, OcrPublicationController } from './ocr.controller';
import { OcrPublicationSwitch } from './ocr-publication-switch';
import { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';
import { OcrQualityController } from './quality/quality-summary.controller';
import { OcrQualityService } from './quality/quality-summary.service';
import { ServiceClientsModule } from '../integrations/service-clients.module';
// SX-9: the facility's OCR job list.
import { OcrJobListController } from './job-list/ocr-job-list.controller';
import { OcrJobListService } from './job-list/ocr-job-list.service';

@Module({
  imports: [ServiceClientsModule],
  controllers: [OcrController, OcrPublicationController, OcrQualityController, OcrJobListController],
  providers: [OcrService, OcrQualityService, OcrPublicationSwitch, OcrReadingSwitch, OcrJobListService],
})
export class OcrModule {}
