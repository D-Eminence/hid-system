import { Controller,Get,Header,Query,Req,Param,ParseUUIDPipe } from '@nestjs/common';
import { FacilityOptional,InternalCaller,AuditFailuresOnly,RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { PatientResultsService } from './patient-results.service';
@Controller('lab/internal/me')
@AuditFailuresOnly()
export class PatientResultsController {
  constructor(private readonly results:PatientResultsService) {}
  @Get('released-results') @FacilityOptional() @InternalCaller('ehr-api') @Header('Cache-Control','no-store')
  read(@Req() request:HidRequest,@Query('cursor') cursor?:string) {return this.results.read(request,cursor);}
}

@Controller('lab/internal/patients/:patientId')
@AuditFailuresOnly()
export class StaffResultsController {
  constructor(private readonly results:PatientResultsService) {}
  @Get('released-results') @InternalCaller('ehr-api') @RequirePermissions('lab.result.released.read') @Header('Cache-Control','no-store')
  read(@Param('patientId',new ParseUUIDPipe()) patientId:string,@Req() request:HidRequest,@Query('cursor') cursor?:string) {
    return this.results.readStaff(request,patientId,cursor);
  }
}
