import { BadRequestException, HttpException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import {
  isTemplateOtp, messageContent, type OtpProvider, type ProviderResult, STAFF_ROLE_LABELS, staffInvitationContent,
  staffInvitationLinkOrigin, staffInvitationReference,
} from '../providers/provider.types';
import { DeliverStaffInvitationDto, STAFF_INVITATION_FACILITY_NAME } from './dto/deliver-staff-invitation.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

// The controller is constructed with an explicit authentication stub; avoid
// loading the ESM-only JWT verifier into the CommonJS test runtime.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

const invitationId = '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d';
const token = 'Ab3_-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';
// 14:35 in Lagos (WAT, UTC+1).
const expiresAt = '2026-11-01T13:35:00.000Z';
const body = {
  channel: 'email' as const, recipient: 'invitee@example.test', facilityName: 'Synthetic Clinic Ltd',
  roleCode: 'doctor' as const, invitationId, token, code: '482913', expiresAt,
};
const page = 'https://app.healthidentitydirectory.com/provider/invitation';

function expectedText(facility: string, label: string, origin = 'https://app.healthidentitydirectory.com',
  support = 'support@healthidentitydirectory.com') {
  return 'Hello,\n\n'
    + `The administrator of ${facility} has invited you to join the facility on Health ID as a ${label}.\n\n`
    + `To accept, open this link:\n${origin}/provider/invitation#${invitationId}.${token}\n\n`
    + `If the link does not open, go to ${origin}/provider/invitation, choose "I have a code", and enter this email address and the code 482913.\n\n`
    + 'The invitation expires on 1 Nov 2026, 14:35 (WAT). If you were not expecting it, you can ignore this email: '
    + `nothing happens unless you accept. To report it, write to Health ID support at ${support} and quote reference 3F2A9C1B.`;
}

describe('Facility staff invitation email (P4b)', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
    jest.restoreAllMocks();
  });

  function provider(name: ProviderResult['provider'], outcome: ProviderResult['outcome'] = 'accepted'): OtpProvider {
    return { name, send: jest.fn().mockResolvedValue({ provider: name, outcome } satisfies ProviderResult) };
  }
  function controller(email: OtpProvider, others: OtpProvider = provider('termii'), auth?: WorkloadAuthService) {
    const service = new NotificationService({ primary: { email, sms: others, whatsapp: others }, fallback: others });
    return new NotificationController(auth ?? ({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as WorkloadAuthService), service);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;

  describe('content', () => {
    it.each(Object.entries(STAFF_ROLE_LABELS))('names the role %s as "%s", with the facility\'s name', (roleCode, label) => {
      expect(staffInvitationContent({ facilityName: 'Synthetic Clinic Ltd', roleCode: roleCode as keyof typeof STAFF_ROLE_LABELS,
        invitationId, token, code: '482913', expiresAt: new Date(expiresAt), origin: 'https://app.healthidentitydirectory.com',
        supportEmail: 'support@healthidentitydirectory.com' })).toEqual({
        subject: 'Invitation to join Synthetic Clinic Ltd on Health ID',
        text: expectedText('Synthetic Clinic Ltd', label),
      });
    });

    it('says "a facility" in the subject and the text when no facility name is sent', () => {
      for (const facilityName of [undefined, null, '']) {
        expect(staffInvitationContent({ facilityName, roleCode: 'lab', invitationId, token, code: '482913',
          expiresAt: new Date(expiresAt), origin: 'https://app.healthidentitydirectory.com',
          supportEmail: 'support@healthidentitydirectory.com' })).toEqual({
          subject: 'Invitation to join a facility on Health ID',
          text: expectedText('a facility', 'laboratory scientist'),
        });
      }
    });

    it('labels exactly the five invitable roles', () => {
      expect(STAFF_ROLE_LABELS).toEqual({ doctor: 'doctor', nurse: 'nurse', lab: 'laboratory scientist',
        pharmacist: 'pharmacist', receptionist: 'receptionist' });
    });

    it('takes the link origin from the deployment, never from a request', () => {
      expect(staffInvitationLinkOrigin('production')).toBe('https://app.healthidentitydirectory.com');
      expect(staffInvitationLinkOrigin('staging')).toBe('https://staging.healthidentitydirectory.com');
      expect(staffInvitationLinkOrigin('development')).toBe('http://localhost:5173');
    });

    it('quotes the first 8 hex characters of the invitation id, upper case, as the reference', () => {
      expect(staffInvitationReference(invitationId)).toBe('3F2A9C1B');
      expect(staffInvitationReference('00000000-0000-4000-8000-000000000000')).toBe('00000000');
    });

    it('is not an OTP: the content is set, so no WhatsApp template and no generic code wording', () => {
      const message = { channel: 'email' as const, recipient: 'invitee@example.test', code: '', purpose: 'STAFF_INVITATION',
        idempotencyKey: `staff-invitation:${invitationId}`, content: staffInvitationContent({ roleCode: 'nurse', invitationId,
          token, code: '482913', expiresAt: new Date(expiresAt), origin: 'https://app.healthidentitydirectory.com',
          supportEmail: 'support@healthidentitydirectory.com' }) };
      expect(isTemplateOtp(message)).toBe(false);
      expect(messageContent(message)).toBe(message.content);
      expect(message.content.text).not.toMatch(/verification code is|Do not share/);
    });
  });

  describe('route', () => {
    it.each([
      ['production', 'https://app.healthidentitydirectory.com'],
      ['staging', 'https://staging.healthidentitydirectory.com'],
      ['development', 'http://localhost:5173'],
    ])('delivers by email with the %s portal link, the stable key and Novu\'s response shape', async (deployment, origin) => {
      process.env.HID_DEPLOYMENT_ENV = deployment;
      resetEnvironmentForTests();
      const email = provider('ses');
      const sms = provider('termii');
      await expect(controller(email, sms).staffInvitation(body, request, `staff-invitation:${invitationId}`)).resolves.toEqual({
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), outcome: 'accepted', primary: { provider: 'ses', outcome: 'accepted' },
      });
      expect(email.send).toHaveBeenCalledWith({
        channel: 'email', recipient: 'invitee@example.test', code: '', purpose: 'STAFF_INVITATION',
        idempotencyKey: `staff-invitation:${invitationId}`,
        content: { subject: 'Invitation to join Synthetic Clinic Ltd on Health ID',
          text: expectedText('Synthetic Clinic Ltd', 'doctor', origin) },
      });
      // No SMS and no WhatsApp: only the email provider is used.
      expect(sms.send).not.toHaveBeenCalled();
    });

    it('renders the configured support email', async () => {
      Object.assign(process.env, { EMERGENCY_CONTACT_SUPPORT_EMAIL: 'help@example.test' });
      resetEnvironmentForTests();
      const email = provider('ses');
      await controller(email).staffInvitation({ ...body, facilityName: undefined, roleCode: 'pharmacist' }, request,
        `staff-invitation:${invitationId}`);
      expect((email.send as jest.Mock).mock.calls[0][0].content).toEqual({
        subject: 'Invitation to join a facility on Health ID',
        text: expectedText('a facility', 'pharmacist', 'https://app.healthidentitydirectory.com', 'help@example.test'),
      });
    });

    it('authenticates the caller before anything else', async () => {
      const email = provider('ses');
      const auth = { authenticate: jest.fn().mockRejectedValue(new UnauthorizedException('Workload authentication failed')) };
      await expect(controller(email, provider('termii'), auth as unknown as WorkloadAuthService)
        .staffInvitation(body, request, 'short')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(auth.authenticate).toHaveBeenCalledWith('identity-api', 'identity-api', 'identity-api');
      expect(email.send).not.toHaveBeenCalled();
    });

    it('refuses a missing or invalid idempotency key and a recipient that is not an email, before any provider call', async () => {
      const email = provider('ses');
      for (const key of [undefined, 'short', ' staff-invitation:0001-0001']) {
        await expect(controller(email).staffInvitation(body, request, key)).rejects.toBeInstanceOf(BadRequestException);
      }
      for (const recipient of ['+2348000000000', 'not-an-email', `${'a'.repeat(250)}@example.test`]) {
        await expect(controller(email).staffInvitation({ ...body, recipient }, request, `staff-invitation:${invitationId}`))
          .rejects.toBeInstanceOf(BadRequestException);
      }
      expect(email.send).not.toHaveBeenCalled();
    });

    it('is not switched off by the emergency-contact delivery switch: Identity\'s control gates invitations', async () => {
      Object.assign(process.env, { EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false' });
      resetEnvironmentForTests();
      const email = provider('ses');
      await expect(controller(email).staffInvitation(body, request, `staff-invitation:${invitationId}`))
        .resolves.toMatchObject({ outcome: 'accepted' });
    });

    it('works under production\'s email-brevo profile, falling back to Brevo after a definitive SES failure', async () => {
      Object.assign(process.env, { NOTIFICATION_DELIVERY_PROFILE: 'email-brevo' });
      resetEnvironmentForTests();
      const email = provider('ses', 'definitive_failure');
      const brevo = provider('brevo');
      await expect(controller(email, brevo).staffInvitation(body, request, `staff-invitation:${invitationId}`))
        .resolves.toMatchObject({ outcome: 'accepted', primary: { provider: 'ses', outcome: 'definitive_failure' },
          fallback: { provider: 'brevo', outcome: 'accepted' } });
      expect((brevo.send as jest.Mock).mock.calls[0][0]).toMatchObject({ channel: 'email', purpose: 'STAFF_INVITATION' });
    });

    it('writes no log line with the recipient, the token, the code or the link', async () => {
      Object.assign(process.env, { NOTIFICATION_PROVIDER_MODE: 'live' });
      // Live mode is refused outside production only for 'test'; build the environment directly.
      resetEnvironmentForTests();
      expect(getEnvironment().NOTIFICATION_PROVIDER_MODE).toBe('live');
      const written: string[] = [];
      const capture = (...values: unknown[]) => { written.push(values.map(String).join(' ')); };
      jest.spyOn(console, 'log').mockImplementation(capture);
      jest.spyOn(console, 'warn').mockImplementation(capture);
      jest.spyOn(console, 'error').mockImplementation(capture);
      jest.spyOn(console, 'info').mockImplementation(capture);
      jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
      jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
      const email = provider('ses', 'definitive_failure');
      const brevo = provider('brevo');
      await controller(email, brevo).staffInvitation({ ...body, plan: { capability: 'email', primary: 'ses', fallback: 'brevo',
        configuration: {} } }, request, `staff-invitation:${invitationId}`);
      jest.restoreAllMocks();
      expect(written.length).toBeGreaterThan(0);
      const log = written.join('\n');
      for (const secret of ['invitee@example.test', token, '482913', page, invitationId, 'Synthetic Clinic']) {
        expect(log).not.toContain(secret);
      }
    });
  });

  // The same options as the application's global pipe (main.ts).
  describe('DTO', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validate = (value: Record<string, unknown>) => pipe.transform(value, { type: 'body', metatype: DeliverStaffInvitationDto });

    it('accepts the fixed field set, with the facility name given, null or absent, and up to 200 characters', async () => {
      await expect(validate({ ...body, plan: { capability: 'email' } })).resolves.toBeInstanceOf(DeliverStaffInvitationDto);
      await expect(validate({ ...body, facilityName: null })).resolves.toBeDefined();
      const { facilityName: _facility, ...withoutFacility } = body;
      await expect(validate(withoutFacility)).resolves.toBeDefined();
      for (const facilityName of ['Ọlá Adébáyọ̀ Specialist Hospital', 'St. Mary\'s Hospital (Ikeja) & Maternity, Lagos',
        'A'.repeat(200), 'Clinic No. 5', 'Mother & Child 24/7 Ltd']) {
        await expect(validate({ ...body, facilityName })).resolves.toBeDefined();
      }
      for (const roleCode of Object.keys(STAFF_ROLE_LABELS)) {
        await expect(validate({ ...body, roleCode })).resolves.toBeDefined();
      }
    });

    it.each(['inviteeName', 'inviterName', 'name', 'administratorName', 'message', 'note', 'link', 'origin', 'subject', 'text'])
    ('refuses an unknown %s field, so no person\'s name, free text or link host can be sent', async (field) => {
      await expect(validate({ ...body, [field]: 'Ada Obi' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['facilityName', 'hid-payroll.com'], ['facilityName', 'Visit healthid.ng today'], ['facilityName', 'Clinic.Com Ltd'],
      ['facilityName', 'https://example.test'], ['facilityName', 'ftp://x'], ['facilityName', 'Clinic <b>'],
      ['facilityName', 'Clinic\nBcc: x@example.test'], ['facilityName', 'Clinic​'], ['facilityName', ''],
      ['facilityName', 'A'.repeat(201)],
      ['channel', 'sms'], ['channel', 'whatsapp'], ['recipient', 'a'.repeat(321)],
      ['roleCode', 'org_admin'], ['roleCode', 'clinician'], ['roleCode', 'admin'], ['roleCode', 'platform_super_admin'],
      ['invitationId', 'not-a-uuid'], ['invitationId', '3f2a9c1b-7d4e-1a5b-8c6d-0e1f2a3b4c5d'],
      ['token', token.slice(1)], ['token', `${token}A`], ['token', `${token.slice(1)}=`],
      ['code', '12345'], ['code', '1234567'], ['code', 'abcdef'],
      ['expiresAt', '1 Nov 2026'], ['expiresAt', '2026-02-30T10:00:00Z'],
    ])('refuses %s %p', async (field, value) => {
      await expect(validate({ ...body, [field]: value })).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['channel', 'recipient', 'roleCode', 'invitationId', 'token', 'code', 'expiresAt'])('requires %s', async (field) => {
      const value: Record<string, unknown> = { ...body };
      delete value[field];
      await expect(validate(value)).rejects.toBeInstanceOf(HttpException);
    });

    it('refuses a domain-like name in the pattern itself, as Identity\'s copy does', () => {
      expect(STAFF_INVITATION_FACILITY_NAME.source)
        .toBe('^(?!.*:\\/\\/)(?!.*[\\p{L}\\p{N}]\\.[\\p{L}]{2})[^\\p{Cc}\\p{Cf}<>]{1,200}$');
      expect(STAFF_INVITATION_FACILITY_NAME.flags).toBe('u');
    });
  });
});
