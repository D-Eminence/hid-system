import { createHmac } from 'node:crypto';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { resetEnvironmentForTests } from '../config/environment';
import { MetaWebhookController } from './meta-webhook.controller';

describe('MetaWebhookController', () => {
  const original = { ...process.env };
  const verifyToken = 'hid-meta-webhook-test-token';
  const appSecret = 'hid-meta-app-secret';

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      META_WEBHOOK_VERIFY_TOKEN: verifyToken,
      META_APP_SECRET: appSecret,
    });
    resetEnvironmentForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('returns the challenge for a valid Meta verification request', () => {
    const controller = new MetaWebhookController();
    expect(controller.verify('subscribe', verifyToken, 'challenge-123')).toBe('challenge-123');
  });

  it('rejects an invalid verification token', () => {
    const controller = new MetaWebhookController();
    expect(() => controller.verify('subscribe', 'wrong-token', 'challenge-123')).toThrow(BadRequestException);
  });

  it('fails closed when the webhook credentials are absent', () => {
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    delete process.env.META_APP_SECRET;
    resetEnvironmentForTests();
    const controller = new MetaWebhookController();
    expect(() => controller.verify('subscribe', verifyToken, 'challenge-123')).toThrow(BadRequestException);
    expect(() => controller.receive(
      { object: 'whatsapp_business_account', entry: [] },
      'sha256=' + '0'.repeat(64),
      { rawBody: Buffer.from('{}') } as never,
    )).toThrow(UnauthorizedException);
  });

  it('accepts a valid signed WhatsApp webhook payload', () => {
    const controller = new MetaWebhookController();
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '867464295799986', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }],
    });
    const signature = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;
    expect(controller.receive(
      JSON.parse(payload),
      signature,
      { rawBody: Buffer.from(payload) } as never,
    )).toEqual({ status: 'ok' });
  });

  it('rejects an invalid webhook signature', () => {
    const controller = new MetaWebhookController();
    expect(() => controller.receive(
      { object: 'whatsapp_business_account', entry: [] },
      'sha256=' + '0'.repeat(64),
      { rawBody: Buffer.from('{}') } as never,
    )).toThrow(UnauthorizedException);
  });

  it('rejects a non-WhatsApp webhook payload', () => {
    const controller = new MetaWebhookController();
    const payload = JSON.stringify({ object: 'not_whatsapp', entry: [] });
    const signature = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;
    expect(() => controller.receive(
      JSON.parse(payload),
      signature,
      { rawBody: Buffer.from(payload) } as never,
    )).toThrow(BadRequestException);
  });
});
