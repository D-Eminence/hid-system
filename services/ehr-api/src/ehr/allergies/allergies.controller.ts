import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { AllergyCheckDto, CreateAllergyDto, MarkAllergyEnteredInErrorDto } from './allergies.dto';
import { AllergiesService } from './allergies.service';

/**
 * Allergies (0124): the list (recorded and patient-reported, apart), adding a
 * recorded allergy, marking one entered in error, and the check the
 * prescribing form runs. Direct care only. Reading needs ehr.note.read and
 * recording ehr.note.write (doctors, clinicians and nurses); the check needs
 * ehr.prescription.write.
 */
@Controller('ehr/patients/:patientId')
export class AllergiesController {
  constructor(private readonly allergies: AllergiesService) {}

  @Get('allergies')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.note.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Query('includeEnteredInError') includeEnteredInError?: string) {
    return this.allergies.list(clinicalContext(request), patientId, includeEnteredInError === 'true');
  }

  @Post('allergies')
  @HttpCode(201)
  @RequirePermissions('ehr.note.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateAllergyDto) {
    return this.allergies.create(clinicalContext(request), patientId, input, requireIdempotencyKey(key));
  }

  @Post('allergies/:allergyId/entered-in-error')
  @HttpCode(200)
  @RequirePermissions('ehr.note.write')
  markEnteredInError(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('allergyId', new ParseUUIDPipe()) allergyId: string, @Body() input: MarkAllergyEnteredInErrorDto) {
    return this.allergies.markEnteredInError(clinicalContext(request), patientId, allergyId, input);
  }

  @Post('allergy-check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.prescription.write')
  check(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Body() input: AllergyCheckDto) {
    return this.allergies.check(clinicalContext(request), patientId, input);
  }
}
