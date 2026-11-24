import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditFailuresOnly, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { SearchCatalogLabTestsQueryDto, SearchCatalogMedicinesQueryDto, SearchDiagnosesQueryDto } from './catalog.dto';
import { CatalogService } from './catalog.service';

/**
 * The answers hold no patient, so a browser may keep them a minute (planned
 * contract, ORD-7). Set only on an answer: a refusal keeps the global
 * 'private, no-store', so a 429 or 503 is never kept (Nest's @Header would
 * set it on refusals too).
 */
export const CATALOG_CACHE_CONTROL = 'private, max-age=60';

export async function keptAMinute<Answer>(request: HidRequest, answer: Promise<Answer>): Promise<Answer> {
  const value = await answer;
  request.res?.setHeader('Cache-Control', CATALOG_CACHE_CONTROL);
  return value;
}

/**
 * ORD-7, first slice (0149): the national medicine and lab-test lists. Any
 * staff member of the facility (X-Facility-Id) reads the status; the
 * searches need the permissions below. No X-Purpose-Of-Use: the lists hold
 * no patient. Only a refusal is audited, and the audit row names the route,
 * never q.
 */
@Controller('ehr/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('status')
  @AuditFailuresOnly()
  status(@Req() request: HidRequest) {
    return keptAMinute(request, this.catalog.status());
  }

  @Get('medicines')
  @RequireAnyPermission('ehr.prescription.write', 'pharmacy.work-item.read')
  @AuditFailuresOnly()
  medicines(@Req() request: HidRequest, @Query() query: SearchCatalogMedicinesQueryDto) {
    return keptAMinute(request, this.catalog.searchMedicines(searchKey(request), query));
  }

  @Get('lab-tests')
  @RequireAnyPermission('ehr.lab-request.write', 'lab.work-item.read')
  @AuditFailuresOnly()
  labTests(@Req() request: HidRequest, @Query() query: SearchCatalogLabTestsQueryDto) {
    return keptAMinute(request, this.catalog.searchLabTests(searchKey(request), query));
  }
}

/**
 * ORD-9 (0152): the ICD-11 diagnosis search, for anyone who records
 * diagnoses (ehr.diagnosis.write). The catalogue's rules: X-Facility-Id, no
 * X-Purpose-Of-Use, q never a Health ID or NIN and never logged, 300
 * searches per 5 minutes per membership (counted with the catalogue's),
 * kept a minute only on an answer, only refusals audited.
 */
@Controller('ehr/terminology')
export class TerminologyController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('diagnoses')
  @RequirePermissions('ehr.diagnosis.write')
  @AuditFailuresOnly()
  diagnoses(@Req() request: HidRequest, @Query() query: SearchDiagnosesQueryDto) {
    return keptAMinute(request, this.catalog.searchDiagnoses(searchKey(request), query));
  }
}

/** Whose searches count together: the membership at this facility (the guard has set it). */
function searchKey(request: HidRequest): string {
  return request.actor?.facility?.membershipId ?? `${request.actor?.subject ?? ''}@${request.facilityId ?? ''}`;
}
