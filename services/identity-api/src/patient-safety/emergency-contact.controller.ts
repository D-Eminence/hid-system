import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, PatientAllowed } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import {
  AddEmergencyContactDto, ConfirmEmergencyContactVerificationDto, UpdateEmergencyContactDto,
} from './dto/emergency-contact.dto';
import { EmergencyContactService } from './emergency-contact.service';

/**
 * Patient-managed emergency contacts. Commands use POST only (the Identity
 * CORS contract allows GET/POST); each security-definer command writes its
 * own success audit and the interceptor records failures.
 */
@Controller('identity/me/emergency-contacts')
@PatientAllowed()
@FacilityOptional()
@AuditFailuresOnly()
export class EmergencyContactController {
  constructor(private readonly contacts: EmergencyContactService) {}

  @Get()
  list(@Req() request: HidRequest) {
    return this.contacts.list(request);
  }

  @Post()
  @HttpCode(201)
  @AuditAction('identity.emergency-contact.create.command')
  add(@Req() request: HidRequest, @Body() input: AddEmergencyContactDto) {
    return this.contacts.add(request, input);
  }

  @Post(':contactId')
  @HttpCode(200)
  @AuditAction('identity.emergency-contact.update.command')
  update(@Req() request: HidRequest, @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() input: UpdateEmergencyContactDto) {
    return this.contacts.update(request, contactId, input);
  }

  @Post(':contactId/deactivate')
  @HttpCode(200)
  @AuditAction('identity.emergency-contact.deactivate.command')
  deactivate(@Req() request: HidRequest, @Param('contactId', new ParseUUIDPipe()) contactId: string) {
    return this.contacts.deactivate(request, contactId);
  }

  @Post(':contactId/verification')
  @HttpCode(202)
  @AuditAction('identity.emergency-contact.verification.send.command')
  sendVerification(@Req() request: HidRequest, @Param('contactId', new ParseUUIDPipe()) contactId: string) {
    return this.contacts.sendVerification(request, contactId);
  }

  @Post(':contactId/verification/confirm')
  @HttpCode(200)
  @AuditAction('identity.emergency-contact.verification.confirm.command')
  confirmVerification(@Req() request: HidRequest, @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body() input: ConfirmEmergencyContactVerificationDto) {
    return this.contacts.confirmVerification(request, contactId, input);
  }
}
