import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AuditAction, NoAudit, Public, RequireAnyPermission } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { clinicalContext } from '../ehr/shared/clinical-context';
import { parseAuditEvents } from './dto/audit-events.dto';
import { EscrowKeyDto } from './dto/escrow-key.dto';
import { parseReceiptsLookup } from './dto/receipts-lookup.dto';
import { OfflineService } from './offline.service';

/**
 * Offline-first support (contract §2.10). Apart from ping, every route needs a
 * staff session at a facility (the global guard; patients are refused),
 * X-Purpose-Of-Use: direct-care, and either permission below.
 */
@Controller('ehr/offline')
export class OfflineController {
  constructor(private readonly offline: OfflineService) {}

  /** C0: reachability and server time for the device clock. No session, no audit. */
  @Get('ping')
  @Public()
  @NoAudit()
  ping() {
    return this.offline.ping();
  }

  /** C1. The body is checked here so a bad one answers 400 INVALID_KEYS. */
  @Post('receipts/lookup')
  @HttpCode(200)
  @RequireAnyPermission('ehr.encounter.read', 'ehr.document.write')
  @AuditAction('ehr.offline.receipts.lookup.request')
  lookupReceipts(@Req() request: HidRequest, @Body() body: unknown) {
    const context = clinicalContext(request);
    return this.offline.lookupReceipts(context, parseReceiptsLookup(body));
  }

  /** C2. Bad events are listed as rejected; only a bad envelope is a 400. */
  @Post('audit-events')
  @HttpCode(200)
  @RequireAnyPermission('ehr.encounter.read', 'ehr.document.write')
  @AuditAction('ehr.offline.audit-events.request')
  ingestAuditEvents(@Req() request: HidRequest, @Body() body: unknown) {
    const context = clinicalContext(request);
    return this.offline.ingestAuditEvents(context, parseAuditEvents(body));
  }

  /** C4. 503 OFFLINE_ESCROW_UNAVAILABLE until OFFLINE_ESCROW_ENABLED is true. */
  @Post('escrow-key')
  @HttpCode(200)
  @RequireAnyPermission('ehr.encounter.read', 'ehr.document.write')
  @AuditAction('ehr.offline.escrow-key.request')
  issueEscrowKey(@Req() request: HidRequest, @Body() input: EscrowKeyDto) {
    return this.offline.issueEscrowKey(clinicalContext(request), input);
  }
}
