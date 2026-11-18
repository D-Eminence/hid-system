import { Module } from '@nestjs/common';
import { VisitQueueController } from './visit-queue.controller';
import { VisitQueueService } from './visit-queue.service';

/** EHR-C7 (0135): the waiting list. */
@Module({
  controllers: [VisitQueueController],
  providers: [VisitQueueService],
})
export class VisitQueueModule {}
