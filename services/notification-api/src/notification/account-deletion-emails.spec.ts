import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { accountDeletionContent } from '../providers/account-deletion-emails';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { DeliverAccountDeletionDto } from './dto/deliver-account-deletion.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const scheduled = { channel: 'email' as const, recipient: 'patient@example.test', kind: 'scheduled' as const,
  scheduledFor: '2026-11-11T09:05:00.000Z' };
const completed = { channel: 'email' as const, recipient: 'patient@example.test', kind: 'completed' as const };
const key = 'account-deletion:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d:scheduled';

describe('Account-deletion emails (0096, E4)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production',
      EMERGENCY_CONTACT_SUPPORT_EMAIL: 'support@healthidentitydirectory.com' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  function provider(name: ProviderResult['provider']): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome: 'accepted' } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider, auth?: WorkloadAuthService) {
    const others = provider('termii');
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  it('says the contract\'s words: the date (WAT) when scheduled, and nothing about the person or the record', () => {
    const support = 'support@healthidentitydirectory.com';
    const soon = accountDeletionContent({ kind: 'scheduled', scheduledFor: new Date(scheduled.scheduledFor), supportEmail: support });
    expect(soon.subject).toBe('Your Health ID account is scheduled for deletion');
    expect(soon.text).toBe('Hello there,\n\nYou asked to delete your Health ID account. It will be deleted on '
      + '11 Nov 2026, 10:05 (WAT).\n\nUntil then you can sign in and cancel it in Settings.\n\n'
      + 'If this was not you, sign in, cancel the deletion and change your password, or contact '
      + 'support@healthidentitydirectory.com.');
    const kept = accountDeletionContent({ kind: 'cancelled', supportEmail: support });
    expect(kept.subject).toBe('Your Health ID account deletion was cancelled');
    expect(kept.text).toBe('Hello there,\n\nYour Health ID account will not be deleted. It stays open.');
    const gone = accountDeletionContent({ kind: 'completed', supportEmail: support });
    expect(gone.subject).toBe('Your Health ID account was deleted');
    expect(gone.text).toBe('Hello there,\n\nYour Health ID account was deleted and you can no longer sign in.\n\n'
      + 'Your Health ID and the medical records facilities hold about you were kept, as required for your care and the law.');
    for (const email of [soon, kept, gone]) expect(`${email.text}${email.html}`).not.toMatch(/HID-|patient@/);
    expect(() => accountDeletionContent({ kind: 'scheduled', supportEmail: support })).toThrow();
  });

  it('renders and sends by email only, with the idempotency key', async () => {
    const email = provider('ses');
    const routes = controller(email);
    await routes.accountDeletion(scheduled, request, key);
    await routes.accountDeletion(completed, request, key.replace('scheduled', 'completed'));
    const sent = (email.send as jest.Mock).mock.calls.map(([message]) => message as { purpose: string; channel: string;
      idempotencyKey: string; content: { subject: string } });
    expect(sent.map((message) => [message.purpose, message.channel, message.content.subject, message.idempotencyKey])).toEqual([
      ['ACCOUNT_DELETION', 'email', 'Your Health ID account is scheduled for deletion', key],
      ['ACCOUNT_DELETION', 'email', 'Your Health ID account was deleted', key.replace('scheduled', 'completed')],
    ]);
  });

  it('refuses a missing key, a phone recipient, a scheduled email without its date and an unauthenticated caller', async () => {
    const email = provider('ses');
    await expect(controller(email).accountDeletion(completed, request, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).accountDeletion({ ...completed, recipient: '+2348012345678' }, request, key))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).accountDeletion({ ...completed, kind: 'scheduled' }, request, key))
      .rejects.toBeInstanceOf(BadRequestException);
    const denied = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException()) } as unknown as WorkloadAuthService;
    await expect(controller(email, denied).accountDeletion(completed, request, key)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('the DTO takes fixed fields only: no name, Health ID or free text', async () => {
    const check = (value: object) => pipe.transform(value, { type: 'body', metatype: DeliverAccountDeletionDto });
    await expect(check(scheduled)).resolves.toBeDefined();
    await expect(check(completed)).resolves.toBeDefined();
    await expect(check({ ...completed, kind: 'cancelled' })).resolves.toBeDefined();
    for (const value of [
      { ...completed, kind: 'scheduled' }, { ...scheduled, scheduledFor: 'in two weeks' }, { ...completed, kind: 'purged' },
      { ...completed, firstName: 'Ada' }, { ...completed, healthId: 'HID-ABC234' }, { ...completed, channel: 'sms' },
    ]) {
      await expect(check(value)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
