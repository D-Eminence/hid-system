import { Controller, Get } from '@nestjs/common';
import { NoAudit, Public } from '../common/decorators';
import { PricingService } from './pricing.service';

@Controller('commercial/pricing')
@Public()
@NoAudit()
export class PublicPricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  list() { return this.pricing.publicPrices(); }
}
