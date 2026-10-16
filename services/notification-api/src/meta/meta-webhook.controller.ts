import { BadRequestException, Controller, Get, Headers, HttpCode, Post, Query, Body, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
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
    if (mode !== 'subscribe' || !verifyToken || !expected || !challenge || !this.equal(verifyToken, expected)) {
      throw new BadRequestException('Webhook verification failed');
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  receive(
    @Body() payload: unknown,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const environment = getEnvironment();
    if (!environment.META_APP_SECRET) {
      throw new UnauthorizedException('Meta webhook is not configured');
    }
    if (!signature || !this.verifySignature(request.rawBody, signature, environment.META_APP_SECRET)) {
      throw new UnauthorizedException('Invalid Meta webhook signature');
    }
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Invalid webhook payload');
    }

    const body = payload as Record<string, unknown>;
    if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
      throw new BadRequestException('Invalid WhatsApp webhook payload');
    }

    return { status: 'ok' };
  }

  private verifySignature(rawBody: Buffer | undefined, signature: string, secret: string): boolean {
    if (!rawBody || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const received = signature.slice('sha256='.length);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(received, 'hex');
    return timingSafeEqual(expectedBuffer, receivedBuffer);
  }

  private equal(first: string, second: string): boolean {
    const firstHash = createHmac('sha256', second).update(first).digest();
    const secondHash = createHmac('sha256', second).update(second).digest();
    return timingSafeEqual(firstHash, secondHash);
  }
}
