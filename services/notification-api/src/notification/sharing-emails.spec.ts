import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { patientShareInvitationContent, recordAccessAlertContent, shareReceivedContent } from '../providers/sharing-emails';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { DeliverPatientShareInvitationDto, DeliverRecordAccessAlertDto, DeliverShareReceivedDto }
  from './dto/deliver-sharing-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const invitation = { channel: 'email' as const, recipient: 'dr@example.test', reference: 'K7M2Q9XZ',
  level: 'clinical_review' as const, duration: '7d' as const, expiresAt: '2026-11-27T10:15:00.000Z' };
const received = { channel: 'email' as const, recipient: 'dr@example.test', facilityName: 'Lagos General Hospital' };
const alert = { channel: 'email' as const, recipient: 'patient@example.test', occurredAt: '2026-10-28T09:05:00.000Z' };

describe('Sharing emails (0095)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production',
      EMERGENCY_CONTACT_SUPPORT_EMAIL: 'support@healthidentitydirectory.com' });
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
  function controller(email: OtpProvider, auth?: WorkloadAuthService) {
    const others = provider('termii');
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  it('E1 names the level, duration, end and reference, the portal and enrolment paths, and no person', () => {
    const content = patientShareInvitationContent({ reference: 'K7M2Q9XZ', level: 'clinical_review', duration: '7d',
      expiresAt: new Date(invitation.expiresAt), origin: 'https://app.healthidentitydirectory.com' });
    expect(content.subject).toBe('A patient wants to share their health records with you on Health ID');
    expect(content.text).toBe('Hello there,\n\n'
      + 'Someone who uses Health ID wants to share their health records with you (Clinical Review, 7 days).\n\n'
      + 'To accept, sign in to the Health ID provider portal at https://app.healthidentitydirectory.com/provider '
      + 'with this email address and open Patients → Invitations.\n\n'
      + 'If you are not on Health ID yet, ask your facility\'s administrator to invite you, or set up your facility at '
      + 'https://app.healthidentitydirectory.com/provider/enroll.\n\n'
      + 'This invitation ends on 27 Nov 2026, 11:15 (WAT).\n\n'
      + 'Reference: K7M2Q9XZ\n\n'
      + 'If you were not expecting this, ignore this email.');
    expect(content.html).toContain('>K7M2Q9XZ</div>');
    expect(content.html).toContain('facility&#39;s administrator');
    expect(patientShareInvitationContent({ reference: 'K7M2Q9XZ', level: 'clinical_collaboration',
      duration: 'until_revoked', expiresAt: new Date(invitation.expiresAt), origin: 'https://x.test' }).text)
      .toContain('(Clinical Collaboration, until the patient ends it (up to 1 year))');
  });

  it('E2 names the facility only; E3 names nothing but the time and support', () => {
    const shared = shareReceivedContent({ facilityName: 'Lagos General Hospital' });
    expect(shared.subject).toBe('A patient shared their Health ID record with you');
    expect(shared.text).toBe('Hello there,\n\nA patient shared their Health ID record with you at Lagos General Hospital.\n\n'
      + 'Sign in to the Health ID provider portal and open Patients → Shared with you to see it.');
    expect(shareReceivedContent({}).text).toContain('record with you.\n\n');
    const opened = recordAccessAlertContent({ occurredAt: new Date(alert.occurredAt),
      supportEmail: 'support@healthidentitydirectory.com' });
    expect(opened.subject).toBe('Your Health ID records were opened');
    expect(opened.text).toBe('Hello there,\n\nA healthcare facility opened your Health ID records on 28 Oct 2026, 10:05 (WAT).\n\n'
      + 'Sign in to Health ID and open Notifications to see which facility.\n\n'
      + 'If you do not recognise this, end that access in Access and consent, or contact support@healthidentitydirectory.com.');
    expect(`${opened.text}${opened.html}`).not.toMatch(/HID-|Hospital|Clinic/);
  });

  it('the three routes render their email and send it by email only, with the idempotency key', async () => {
    const email = provider('ses');
    const routes = controller(email);
    await routes.patientShareInvitation(invitation, request, 'patient-share-invitation:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d');
    await routes.shareReceived(received, request, 'share-received:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d');
    await routes.recordAccessAlert(alert, request, 'record-access-alert:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d');
    const sent = (email.send as jest.Mock).mock.calls.map(([message]) => message as { purpose: string; channel: string;
      idempotencyKey: string; content: { subject: string } });
    expect(sent.map((message) => [message.purpose, message.channel, message.content.subject])).toEqual([
      ['PATIENT_SHARE_INVITATION', 'email', 'A patient wants to share their health records with you on Health ID'],
      ['SHARE_RECEIVED', 'email', 'A patient shared their Health ID record with you'],
      ['RECORD_ACCESS_ALERT', 'email', 'Your Health ID records were opened'],
    ]);
    expect(sent[2]?.idempotencyKey).toBe('record-access-alert:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d');
  });

  it('refuses a missing key, a phone recipient and an unauthenticated caller', async () => {
    const email = provider('ses');
    await expect(controller(email).recordAccessAlert(alert, request, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(email).recordAccessAlert({ ...alert, recipient: '+2348012345678' }, request,
      'record-access-alert:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d')).rejects.toBeInstanceOf(BadRequestException);
    const denied = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException()) } as unknown as WorkloadAuthService;
    await expect(controller(email, denied).shareReceived(received, request,
      'share-received:3c0e1a2b-4d5f-4a6b-8c7d-9e0f1a2b3c4d')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('the DTOs take fixed fields only: no name, Health ID or free text', async () => {
    const check = (value: object, metatype: new () => object) => pipe.transform(value, { type: 'body', metatype });
    await expect(check(invitation, DeliverPatientShareInvitationDto)).resolves.toBeDefined();
    await expect(check(received, DeliverShareReceivedDto)).resolves.toBeDefined();
    await expect(check({ channel: 'email', recipient: 'dr@example.test' }, DeliverShareReceivedDto)).resolves.toBeDefined();
    await expect(check(alert, DeliverRecordAccessAlertDto)).resolves.toBeDefined();
    for (const [value, metatype] of [
      [{ ...invitation, patientName: 'Ada' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, inviteeName: 'Dr Bello' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, reference: 'k7m2q9xz' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, reference: 'K7M2Q9X0' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, level: 'full' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, duration: '90d' }, DeliverPatientShareInvitationDto],
      [{ ...invitation, expiresAt: 'next week' }, DeliverPatientShareInvitationDto],
      [{ ...received, healthId: 'HID-ABC234' }, DeliverShareReceivedDto],
      [{ ...received, facilityName: 'evil.example.test/<a>' }, DeliverShareReceivedDto],
      [{ ...alert, facilityName: 'Lagos General Hospital' }, DeliverRecordAccessAlertDto],
      [{ ...alert, occurredAt: 'yesterday' }, DeliverRecordAccessAlertDto],
    ] as Array<[object, new () => object]>) {
      await expect(check(value, metatype)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
