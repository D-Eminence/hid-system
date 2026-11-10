import { Body, Controller, Get, Header, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { AuditAction, AuditFailuresOnly, Public } from '../common/decorators';
import { assertAllowedOrigin, singleCookie } from '../common/public-flow-guards';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { RequestCardCodeDto, StopCardEmailsDto, VerifyCardCodeDto } from './card-links.dto';
import { CardLinksService } from './card-links.service';

/** Every receiver cookie is scoped to the receiver's routes only (critique 2). */
export const CARD_SHARE_COOKIE_PATH = '/api/v1/card-share';
/**
 * The browser that asked for a code: verify needs this cookie too (critique
 * 6). One per link, named for it (the first 16 hex of the link's keyed token
 * HMAC, which reveals nothing of the token), so codes for two links in one
 * browser never overwrite or clear each other's (F3).
 */
export const CARD_CODE_COOKIE_PREFIX = 'hid_card_code_';
export const cardCodeCookie = (tokenHmac: string): string => `${CARD_CODE_COOKIE_PREFIX}${tokenHmac.slice(0, 16)}`;
/** One cookie per view, named for it: two links in one browser never mix (critique 1). */
export const cardViewCookie = (viewId: string): string => `hid_cv_${viewId.replace(/-/g, '')}`;

/**
 * The person a card link went to (0118). Public: these routes never read,
 * refresh or end a patient or staff session, and never answer 401. Every
 * POST checks Origin. The link's token travels only in a POST body; the
 * view is named in X-Card-View and proved by its own HttpOnly cookie. All
 * answers are no-store; failures are audited by the interceptor without the
 * body, and every step by the database with ids and counts. 404 while
 * CARD_LINKS_ENABLED is off.
 */
@Controller('card-share')
@Public()
@AuditFailuresOnly()
export class CardLinksPublicController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly links: CardLinksService) {}

  /** 204 while card links are served (404 while off), so the receiver's page stays dormant without a token. */
  @Get('availability')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  availability(): void {
    this.links.assertServed();
  }

  /** 202 { sentTo, expiresInSeconds: 600, resendAfterSeconds: 60 } and the 10-minute browser cookie. */
  @Post('code')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @AuditAction('card-share.code')
  async code(@Body() input: RequestCardCodeDto, @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request, this.allowedOrigins);
    const issued = await this.links.requestCode(request, input);
    response.cookie(cardCodeCookie(issued.tokenHmac), issued.pendingSecret, { ...this.cookieOptions(), maxAge: 600_000 });
    return issued.body;
  }

  /** 200 the card's identity half, and the view's session cookie (no Max-Age: the server ends it after 30 minutes). */
  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AuditAction('card-share.verify')
  async verify(@Body() input: VerifyCardCodeDto, @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request, this.allowedOrigins);
    const tokenHmac = this.links.linkTokenHmac(input.token);
    const pending = tokenHmac ? singleCookie(request, cardCodeCookie(tokenHmac)) : undefined;
    const opened = await this.links.verify(request, input, pending);
    response.cookie(cardViewCookie(opened.viewId), opened.viewSecret, this.cookieOptions());
    if (tokenHmac) response.clearCookie(cardCodeCookie(tokenHmac), this.cookieOptions());
    return opened.body;
  }

  /** 200 the card for a live view; 410 CARD_SHARE_VIEW_ENDED otherwise. */
  @Get('view')
  @Header('Cache-Control', 'no-store')
  @AuditAction('card-share.view')
  view(@Req() request: HidRequest, @Headers('x-card-view') viewId: string | undefined) {
    return this.links.view(request, viewId?.toLowerCase());
  }

  /** 204, and the view's cookie cleared; unknown or ended views answer the same. */
  @Post('end-view')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @AuditAction('card-share.end-view')
  async endView(@Req() request: HidRequest, @Headers('x-card-view') viewId: string | undefined,
    @Res({ passthrough: true }) response: Response): Promise<void> {
    assertAllowedOrigin(request, this.allowedOrigins);
    const named = viewId?.toLowerCase();
    await this.links.endView(request, named);
    if (named && /^[0-9a-f-]{36}$/.test(named)) response.clearCookie(cardViewCookie(named), this.cookieOptions());
  }

  /** 204 for any well-formed stop token ("Stop these emails"); only a genuine one blocks the address. */
  @Post('stop')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @AuditAction('card-share.stop')
  async stop(@Body() input: StopCardEmailsDto, @Req() request: HidRequest): Promise<void> {
    assertAllowedOrigin(request, this.allowedOrigins);
    await this.links.stop(request, input.stopToken);
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, secure: this.environment.AUTH_COOKIE_SECURE, sameSite: 'strict', path: CARD_SHARE_COOKIE_PATH };
  }
}
