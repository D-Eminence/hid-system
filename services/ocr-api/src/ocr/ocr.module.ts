import { Module } from '@nestjs/common';
import { OcrController, OcrPublicationController } from './ocr.controller';
import { OcrService } from './ocr.service';
import { ServiceClientsModule } from '../integrations/service-clients.module';

@Module({
  imports: [ServiceClientsModule],
  controllers: [OcrController, OcrPublicationController],
  providers: [OcrService],
})
export class OcrModule {}
