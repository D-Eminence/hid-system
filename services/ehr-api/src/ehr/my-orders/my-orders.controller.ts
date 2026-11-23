import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { MyOrdersQueryDto } from './my-orders.dto';
import { MyOrdersService } from './my-orders.service';

/**
 * MY-1: "Ordered by me". No single permission is required here: lab rows
 * need ehr.lab-request.read and prescription rows ehr.prescription.read, and
 * the service answers 403 PERMISSION_DENIED for a member with neither, or
 * for a kind asked without its permission.
 */
@Controller('ehr/my-orders')
export class MyOrdersController {
  constructor(private readonly orders: MyOrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: MyOrdersQueryDto) {
    return this.orders.list(clinicalContext(request), query);
  }
}
