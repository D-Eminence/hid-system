import { Module } from '@nestjs/common';
import { OcrController, OcrPublicationController } from './ocr.controller';
import { OcrPublicationSwitch } from './ocr-publication-switch';
import { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';
import { OcrQualityController } from './quality/quality-summary.controller';
import { OcrQualityService } from './quality/quality-summary.service';
import { ServiceClientsModule } from '../integrations/service-clients.module';

@Module({
  imports: [ServiceClientsModule],
  controllers: [OcrController, OcrPublicationController, OcrQualityController],
  providers: [OcrService, OcrQualityService, OcrPublicationSwitch, OcrReadingSwitch],
})
export class OcrModule {}
