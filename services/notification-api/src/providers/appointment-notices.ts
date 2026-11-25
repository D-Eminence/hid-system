import { hidEmailHtml, hidEmailText } from './email-layout';
import { alertTime, type MessageContent } from './provider.types';

/**
 * APPT-1 (0161, Q-APPT-3 A): the appointment notices sent outside the
 * signed-in inbox. Fixed fields only.
 *
 * The email is generic for every notice (booked, moved, cancelled, the
 * reminder): it names no time, facility, clinic, clinician or reason, so an
 * inbox someone else reads tells them nothing about the patient's care. The
 * signed-in inbox and "My appointments" show the details.
 *
 * The SMS reminder (built, switched off by the Platform control
 * appointment_sms_reminders_enabled until the SMS budget, the Termii sender
 * ID and the DPO's notice are in place) carries only the facility's name, the
 * day and the time in Lagos. It never names the clinic or the reason: a clinic
 * name can reveal a condition.
 */
export const APPOINTMENT_NOTICE_KINDS = ['booked', 'rescheduled', 'cancelled', 'reminder'] as const;
export type AppointmentNoticeKind = (typeof APPOINTMENT_NOTICE_KINDS)[number];

export function appointmentUpdateEmailContent(): MessageContent {
  const subject = 'There is an update to your appointments';
  const email = {
    title: subject,
    accent: '#1a6fd4' as const,
    heading: 'Appointment Update',
    paragraphs: [
      'There is an update to your appointments.',
      'Sign in to Health ID and open My appointments to see it.',
    ],
  };
  return { subject, text: hidEmailText(email), html: hidEmailHtml(email) };
}

/** "Reminder: you have an appointment at {facility} on {day} at {time}." (Lagos time). */
export function appointmentReminderSmsText(input: { facilityName: string; startsAt: Date }): string {
  const [day, time] = alertTime(input.startsAt).split(', ');
  return `Reminder: you have an appointment at ${input.facilityName} on ${day} at ${time}.`;
}
