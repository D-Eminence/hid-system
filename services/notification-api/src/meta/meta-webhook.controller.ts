import { BadRequestException, Controller, Get, Headers, HttpCode, Post, Query, Body } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnvironment } from '../config/environment';

@Controller('webhooks/meta/whatsapp')
export class MetaWebhookController {
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ) {
    const expected = getEnvironment().META_WEBHOOK_VERIFY_TOKEN;
    if (mode !== 'subscribe' || !verifyToken || !expected || !this.equal(verifyToken, expected) || !challenge) {
      throw new BadRequestException('Webhook verification failed');
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  receive(
    @Body() payload: unknown,
    @Headers('x-hub-signature-256') signature: string | undefined,
  ) {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Invalid webhook payload');
    }

    // Meta webhook signature verification requires the raw request body.
    // Signature enforcement is enabled once the application exposes the raw body
    // to this controller. The endpoint still validates the webhook shape and
    // acknowledges accepted deliveries without logging message contents.
    if (signature !== undefined && !signature.startsWith('sha256=')) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const body = payload as Record<string, unknown>;
    if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      throw new BadRequestException('Invalid WhatsApp webhook payload');
    }

    return { status: 'ok' };
  }

  private equal(first: string, second: string): boolean {
    const firstHash = createHmac('sha256', second).update(first).digest();
    const secondHash = createHmac('sha256', second).update(second).digest();
    return timingSafeEqual(firstHash, secondHash);
  }
}
