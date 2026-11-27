import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateLabRequestGroupBodyPipe } from './lab-request-groups';
import type { CreateLabRequestGroupInput } from './lab-request-groups.dto';
import { LabRequestsService } from './lab-requests.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/lab-request-groups')
export class LabRequestGroupsController {
  constructor(private readonly labRequests: LabRequestsService) {}

  /**
   * ORD-6 (0158): several tests in one lab request, one Save. Anyone who may
   * create a lab request (`ehr.lab-request.write`). The body is checked by
   * CreateLabRequestGroupBodyPipe (each test as the single create checks it;
   * tests by name only while LAB_REQUEST_NAME_ONLY_ENABLED is on). One
   * Idempotency-Key covers the group. While LAB_REQUEST_GROUPS_ENABLED is
   * off the service refuses a new group, 503 LAB_REQUEST_GROUPS_UNAVAILABLE
   * (through the public gateway the browser gets the gateway's 503
   * UPSTREAM_UNAVAILABLE; the website reads the catalogue status's
   * labRequestGroups), and answers a same-key retry of a stored one. The
   * sends to Lab end 25 s after the request reached ehr-api (`receivedAt`,
   * CorrelationMiddleware).
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.lab-request.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body(CreateLabRequestGroupBodyPipe) input: CreateLabRequestGroupInput) {
    return this.labRequests.createGroup(clinicalContext(request), patientId, encounterId, input,
      requireIdempotencyKey(key), request.receivedAt ?? Date.now());
  }
}
