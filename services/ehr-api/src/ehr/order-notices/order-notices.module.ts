import { Module } from '@nestjs/common';
import { getEnvironment } from '../../config/environment';
import { OrderNoticesController } from './order-notices.controller';
import { OrderNoticeSweeper, OrderNoticesService, OrderNoticesSwitch } from './order-notices.service';

/**
 * ORD-11 (0159): notices to the ordering doctor. On only while
 * ORDER_NOTICES_ENABLED is true. DatabaseService comes from the global module.
 */
@Module({
  controllers: [OrderNoticesController],
  providers: [OrderNoticesService, OrderNoticeSweeper,
    { provide: OrderNoticesSwitch, useFactory: () => new OrderNoticesSwitch(getEnvironment().ORDER_NOTICES_ENABLED) }],
})
export class OrderNoticesModule {}
