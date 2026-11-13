import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { isTemplateOtp, messageContent, outreachGroupName, outreachHealthIdCodeContent, type OtpProvider,
  type ProviderResult } from '../providers/provider.types';
import { DeliverOtpDto, OtpPurpose } from './dto/deliver-otp.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const challengeId = '0b7e4c2a-9d1f-4e6b-8a3c-5f2d1e0c9b8a';
const body = { channel: 'email' as const, recipient: 'ada@example.test', code: '482913',
  purpose: OtpPurpose.OUTREACH_HEALTH_ID_VERIFY, groupName: 'Lagos Health Walk', expiresInMinutes: 10 };

describe('Outreach assisted Health ID code (0119, OUTREACH_HEALTH_ID_VERIFY)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function provider(name: ProviderResult['provider']): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome: 'accepted' } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider, others: OtpProvider = provider('termii')) {
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService,
      service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  it('renders the owner\'s plain-text words with the group and the minutes, the code only in the body', () => {
    const content = outreachHealthIdCodeContent({ groupName: 'Lagos Health Walk', code: '482913', expiresInMinutes: 10 });
    expect(content).toEqual({
      subject: 'Your Health ID code',
      text: 'Lagos Health Walk is creating a Health ID for you. Your code is 482913. It works for 10 minutes. '
        + 'If you are with their volunteer now, read this code to them. If you didn\'t ask for this, ignore this email: '
        + 'no Health ID is made without the code. Afterwards, set your password in the Health ID app with '
        + '\'Forgot password\'.',
    });
    expect(content.html).toBeUndefined();
    expect(outreachHealthIdCodeContent({ code: '482913', expiresInMinutes: 1 }).text)
      .toMatch(/^An outreach team is creating a Health ID for you\. Your code is 482913\. It works for 1 minute\. /);
  });

  it('strips control characters from the group name, collapses spaces and caps it at 80 characters', () => {
    expect(outreachGroupName('Kano\u0000 Care\n\tTeam‮')).toBe('Kano Care Team');
    expect(outreachGroupName('x'.repeat(200))).toHaveLength(80);
    expect(outreachGroupName('\u0007\n ')).toBe('');
    // A self-service name carrying a link or a domain is never put in the email.
    for (const linked of ['Visit https://evil.example', 'www.free-gift.ng', 'Claim at prize.xyz now', 'ftp://x']) {
      expect(outreachGroupName(linked)).toBe('');
    }
    expect(outreachGroupName('St. Mary Outreach')).toBe('St. Mary Outreach');
    expect(outreachHealthIdCodeContent({ groupName: 'go to bit.ly/abc', code: '482913', expiresInMinutes: 10 }).text)
      .toMatch(/^An outreach team is creating a Health ID for you\./);
    expect(outreachHealthIdCodeContent({ groupName: '\n\r', code: '111111', expiresInMinutes: 5 }).text)
      .toMatch(/^An outreach team /);
  });

  it('POST otp delivers it by email with the rendered content, never a WhatsApp template', async () => {
    const email = provider('ses');
    const sms = provider('termii');
    await controller(email, sms).otp({ ...body }, request, `otp:${challengeId}`);
    const sent = (email.send as jest.Mock).mock.calls[0][0];
    expect(sent).toEqual({ channel: 'email', recipient: 'ada@example.test', code: '482913',
      purpose: 'OUTREACH_HEALTH_ID_VERIFY', idempotencyKey: `otp:${challengeId}`,
      content: outreachHealthIdCodeContent({ groupName: 'Lagos Health Walk', code: '482913', expiresInMinutes: 10 }) });
    expect(messageContent(sent).subject).toBe('Your Health ID code');
    expect(isTemplateOtp(sent)).toBe(false);
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('refuses another channel, a missing expiry, and the outreach fields on any other purpose', async () => {
    const email = provider('ses');
    await expect(controller(email).otp({ ...body, channel: 'sms', recipient: '+2348012345678' }, request,
      `otp:${challengeId}`)).rejects.toBeInstanceOf(BadRequestException);
    const { expiresInMinutes: _minutes, ...withoutExpiry } = body;
    await expect(controller(email).otp(withoutExpiry, request, `otp:${challengeId}`))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).otp({ ...body, purpose: OtpPurpose.SIGNUP_VERIFY }, request, `otp:${challengeId}`))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('leaves a generic code unchanged', async () => {
    const email = provider('ses');
    await controller(email).otp({ channel: 'email', recipient: 'ada@example.test', code: '482913',
      purpose: OtpPurpose.SIGNUP_VERIFY }, request, `otp:${challengeId}`);
    expect(email.send).toHaveBeenCalledWith({ channel: 'email', recipient: 'ada@example.test', code: '482913',
      purpose: 'SIGNUP_VERIFY', idempotencyKey: `otp:${challengeId}` });
  });

  it('the DTO accepts the purpose and its fields and refuses bad ones', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform({ ...body }, { type: 'body', metatype: DeliverOtpDto })).resolves.toBeInstanceOf(DeliverOtpDto);
    for (const [field, value] of [['expiresInMinutes', 0], ['expiresInMinutes', 61], ['expiresInMinutes', '10'],
      ['groupName', 'x'.repeat(201)], ['groupName', 5]] as const) {
      await expect(pipe.transform({ ...body, [field]: value }, { type: 'body', metatype: DeliverOtpDto }))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
