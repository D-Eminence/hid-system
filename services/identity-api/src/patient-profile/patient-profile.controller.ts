import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, StreamableFile } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { SaveProfileDetailsDto, SaveProfilePhotoDto, StartContactChangeDto, VerifyContactChangeDto } from './dto/patient-profile.dto';
import { PatientContactChangeService } from './patient-contact-change.service';
import { PatientProfileService } from './patient-profile.service';

/**
 * The patient's own profile (0094): the hospital they use and their HMO,
 * their photo, and changes of email or phone. Patient sessions only; every
 * write is a cookie write with Origin and CSRF, as the other patient writes.
 * Each command records its own success audit and the interceptor records
 * failures; reading the photo is not audited when it succeeds.
 */
@Controller('identity')
@PatientOnly()
@AuditFailuresOnly()
export class PatientProfileController {
  constructor(private readonly profile: PatientProfileService, private readonly contacts: PatientContactChangeService) {}

  @Get('me/profile-details')
  details(@Req() request: HidRequest) {
    return this.profile.details(request);
  }

  @Put('me/profile-details')
  @HttpCode(200)
  @AuditAction('identity.patient.profile-details.update.command')
  saveDetails(@Req() request: HidRequest, @Body() input: SaveProfileDetailsDto) {
    return this.profile.saveDetails(request, input);
  }

  /** The image bytes with their own type; Cache-Control private, no-store (every Identity answer). */
  @Get('me/photo')
  async photo(@Req() request: HidRequest): Promise<StreamableFile> {
    const photo = await this.profile.photo(request);
    return new StreamableFile(photo.bytes, { type: photo.mediaType, disposition: 'inline', length: photo.bytes.length });
  }

  @Put('me/photo')
  @HttpCode(200)
  @AuditAction('identity.patient.photo.set.command')
  savePhoto(@Req() request: HidRequest, @Body() input: SaveProfilePhotoDto) {
    return this.profile.savePhoto(request, input);
  }

  @Delete('me/photo')
  @HttpCode(200)
  @AuditAction('identity.patient.photo.remove.command')
  removePhoto(@Req() request: HidRequest) {
    return this.profile.removePhoto(request);
  }

  @Post('me/contact-changes')
  @HttpCode(200)
  @AuditAction('identity.patient.contact-change.start.command')
  startContactChange(@Req() request: HidRequest, @Body() input: StartContactChangeDto) {
    return this.contacts.start(request, input);
  }

  @Post('me/contact-changes/:changeId/verify')
  @HttpCode(200)
  @AuditAction('identity.patient.contact-change.verify.command')
  verifyContactChange(@Req() request: HidRequest, @Param('changeId', new ParseUUIDPipe()) changeId: string,
    @Body() input: VerifyContactChangeDto) {
    return this.contacts.verify(request, changeId, input.code);
  }
}
