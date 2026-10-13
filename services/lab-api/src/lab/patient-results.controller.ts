import { Controller,Get,Header,Query,Req } from '@nestjs/common';
import { FacilityOptional,InternalCaller,AuditFailuresOnly } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { PatientResultsService } from './patient-results.service';
@Controller('lab/internal/me')
@AuditFailuresOnly()
export class PatientResultsController {
  constructor(private readonly results:PatientResultsService) {}
  @Get('released-results') @FacilityOptional() @InternalCaller('ehr-api') @Header('Cache-Control','no-store')
  read(@Req() request:HidRequest,@Query('cursor') cursor?:string) {return this.results.read(request,cursor);}
}
