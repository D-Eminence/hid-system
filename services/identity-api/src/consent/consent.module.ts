import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';
import { StaffSearchBudget } from '../identity/staff-search-budget';

@Module({
  controllers: [ConsentController],
  providers: [ConsentService, StaffSearchBudget],
})
export class ConsentModule {}
