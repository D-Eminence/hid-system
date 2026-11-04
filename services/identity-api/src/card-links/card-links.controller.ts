import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import type { HidRequest } from '../common/request-context';
import { CreateCardShareDto } from './card-links.dto';
import { CardLinksService } from './card-links.service';

/**
 * The patient's card links (0118): list (also the website's "is it on"
 * check), send and end. Patient sessions only; every POST is a cookie write
 * with Origin and CSRF. The SQL commands audit each success; the interceptor
 * records failures without the body. 404 while CARD_LINKS_ENABLED is off.
 */
@Controller('identity/me/card-shares')
@PatientOnly()
@AuditFailuresOnly()
export class CardLinksController {
  constructor(private readonly links: CardLinksService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest) {
    return this.links.list(request);
  }

  /** 201 a new link; 200 with replayed: true for the same Idempotency-Key and body. */
  @Post()
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.card-share.create.command')
  async create(@Req() request: HidRequest, @Body() input: CreateCardShareDto,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: Response) {
    this.links.assertServed();
    const answer = await this.links.create(request, input, requireIdempotencyKey(key));
    response.status(answer.replayed ? 200 : 201);
    return answer;
  }

  @Post(':shareId/end')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.card-share.end.command')
  end(@Req() request: HidRequest, @Param('shareId', new ParseUUIDPipe()) shareId: string) {
    return this.links.end(request, shareId);
  }
}
