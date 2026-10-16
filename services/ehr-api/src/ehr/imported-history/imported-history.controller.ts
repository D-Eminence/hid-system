import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { AuditFailuresOnly, PatientOnly, RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { IsOptionalButNotNull } from '../../common/validation';
import { StaffImportedHistoryEnabledGuard } from './imported-history-enabled.guard';
import { ImportedHistoryService } from './imported-history.service';

export class ImportedHistoryQueryDto {
  @IsOptionalButNotNull()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{16,512}$/)
  cursor?: string;
}

/**
 * Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-067).
 * Success is audited by the service with counts only; failures by the
 * interceptor.
 */
@Controller('ehr')
@AuditFailuresOnly()
export class ImportedHistoryController {
  constructor(private readonly history: ImportedHistoryService) {}

  // Patient sessions only: the guard refuses any other session with 403
  // PATIENT_SESSION_REQUIRED, audited, before this handler runs (A9-EHR).
  @Get('me/imported-history')
  @PatientOnly()
  self(@Req() request: HidRequest, @Query() query: ImportedHistoryQueryDto = {}) {
    return this.history.self(request, query.cursor);
  }

  // Direct care only: break-glass (the purpose emergency) never discloses
  // imported history, and no other purpose reads it.
  @Get('patients/:patientId/imported-history')
  @RequirePermissions('ehr.imported-history.read')
  @UseGuards(StaffImportedHistoryEnabledGuard)
  staff(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest,
    @Query() query: ImportedHistoryQueryDto) {
    if (request.header('x-purpose-of-use') !== 'direct-care') {
      throw new DomainProblem(400, 'DIRECT_CARE_PURPOSE_REQUIRED', 'Imported medical history is read for direct care only');
    }
    return this.history.staff(patientId, requireRequestContext(request, 'direct-care'), query.cursor);
  }
}
