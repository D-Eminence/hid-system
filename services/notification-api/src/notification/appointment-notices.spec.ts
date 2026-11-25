import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import { appointmentReminderSmsText, appointmentUpdateEmailContent } from '../providers/appointment-notices';
import type { OtpProvider, ProviderResult } from '../providers/provider.types';
import { DeliverAppointmentNoticeDto } from './dto/deliver-patient-emails.dto';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

// Fictional values only.
const email = { channel: 'email' as const, recipient: 'patient@example.test', kind: 'booked' as const };
const sms = { channel: 'sms' as const, recipient: '+2348030000000', kind: 'reminder' as const,
  facilityName: 'Booking Clinic A', startsAt: '2026-12-03T09:00:00.000Z' };
const key = 'appointment-notice:0000000001';

describe('Appointment notices (APPT-1, 0161)', () => {
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
  function setup() {
    const emailProvider = provider('ses');
    const smsProvider = provider('termii');
    const fallback = provider('brevo');
    const service = new NotificationService({ primary: { email: emailProvider, sms: smsProvider, whatsapp: fallback },
      fallback });
    const controller = new NotificationController({ authenticate: jest.fn().mockResolvedValue(undefined) } as unknown as
      WorkloadAuthService, service);
    return { controller, emailProvider, smsProvider };
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  it('the email is generic: no time, facility, clinic, clinician or reason', () => {
    const content = appointmentUpdateEmailContent();
    expect(content.subject).toBe('There is an update to your appointments');
    expect(content.text).toBe('Hello there,\n\nThere is an update to your appointments.\n\n'
      + 'Sign in to Health ID and open My appointments to see it.');
    expect(content.html).toContain('Appointment Update');
  });

  it('the SMS reminder names the facility, the day and the time in Lagos, nothing else', () => {
    expect(appointmentReminderSmsText({ facilityName: 'Booking Clinic A', startsAt: new Date(sms.startsAt) }))
      .toBe('Reminder: you have an appointment at Booking Clinic A on 3 Dec 2026 at 10:00.');
  });

  it('sends an email notice through the email provider with the generic content', async () => {
    const { controller, emailProvider, smsProvider } = setup();
    const input = await pipe.transform(email, { type: 'body', metatype: DeliverAppointmentNoticeDto });
    const answer = await controller.appointmentNotice(input, request, key);
    expect(answer.outcome).toBe('accepted');
    expect(emailProvider.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email',
      recipient: 'patient@example.test', purpose: 'APPOINTMENT_NOTICE', idempotencyKey: key,
      content: appointmentUpdateEmailContent() }));
    expect(smsProvider.send).not.toHaveBeenCalled();
  });

  it('sends the SMS reminder through the SMS provider', async () => {
    const { controller, smsProvider } = setup();
    const input = await pipe.transform(sms, { type: 'body', metatype: DeliverAppointmentNoticeDto });
    await controller.appointmentNotice(input, request, key);
    expect(smsProvider.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', recipient: '+2348030000000',
      purpose: 'APPOINTMENT_REMINDER', content: { subject: 'Appointment reminder',
        text: 'Reminder: you have an appointment at Booking Clinic A on 3 Dec 2026 at 10:00.' } }));
  });

  it('refuses an SMS that is not a reminder, an email that carries the facility or time, a wrong recipient, '
    + 'a missing key, and any extra field', async () => {
    const { controller } = setup();
    for (const body of [{ ...sms, kind: 'booked' }, { ...email, facilityName: 'Booking Clinic A' },
      { ...email, startsAt: sms.startsAt }, { ...email, recipient: '+2348030000000' }]) {
      const input = await pipe.transform(body, { type: 'body', metatype: DeliverAppointmentNoticeDto });
      await expect(controller.appointmentNotice(input, request, key)).rejects.toBeInstanceOf(BadRequestException);
    }
    const input = await pipe.transform(email, { type: 'body', metatype: DeliverAppointmentNoticeDto });
    await expect(controller.appointmentNotice(input, request, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...email, reason: 'Blood pressure review' },
      { type: 'body', metatype: DeliverAppointmentNoticeDto })).rejects.toBeInstanceOf(BadRequestException);
    await expect(pipe.transform({ ...email, clinicName: 'Antenatal clinic' },
      { type: 'body', metatype: DeliverAppointmentNoticeDto })).rejects.toBeInstanceOf(BadRequestException);
  });
});
