import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { generateSixDigitOtp } from '../auth/otp.service';
import { requirePatient } from '../auth/patient-self.service';
import type { PatientSessionActor } from '../auth/recent-authentication';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { databaseMessage, isDatabaseError } from './database-error';
import type {
  AddEmergencyContactDto, ConfirmEmergencyContactVerificationDto, EmergencyContactRelationship,
  UpdateEmergencyContactDto,
} from './dto/emergency-contact.dto';
import { EmergencyContactProtector, maskDestination, type EmergencyContactChannel } from './emergency-contact-protector';

interface ContactRow {
  contact_id: string;
  relationship: EmergencyContactRelationship;
  channel: EmergencyContactChannel;
  contact_ciphertext: Buffer;
  contact_key_version: string;
  notify_on_emergency_access: boolean;
  status: 'unverified' | 'verified';
  verified_at: Date | null;
  created_at: Date;
  row_version: string;
  verification_expires_at: Date | null;
  verification_delivery_outcome: 'pending' | 'accepted' | 'definitive_failure' | 'unknown' | null;
  last_notification_status: 'pending' | 'delivered' | 'failed' | 'expired' | 'suppressed' | null;
  last_notification_at: Date | null;
}

export interface EmergencyContactView {
  contactId: string;
  name: string;
  relationship: EmergencyContactRelationship;
  channel: EmergencyContactChannel;
  destinationHint: string;
  status: 'unverified' | 'verified';
  verifiedAt: Date | null;
  notifyOnEmergencyAccess: boolean;
  /** True only for a verified contact whose notification preference is on. */
  eligibleForEmergencyNotification: boolean;
  version: number;
  pendingVerification: { expiresAt: Date; deliveryOutcome: string } | null;
  lastNotification: { status: string; createdAt: Date } | null;
}

/**
 * Patient-managed emergency contacts. Ownership, verification, eligibility,
 * and lifecycle are enforced by session-bound security-definer commands; this
 * service encrypts the contact, derives verifiers, and delivers verification
 * codes through the existing notification-api OTP path.
 */
@Injectable()
export class EmergencyContactService {
  private readonly environment = getEnvironment();

  constructor(
    private readonly database: DatabaseService,
    private readonly protector: EmergencyContactProtector,
    private readonly notification: NotificationOtpClient,
  ) {}

  async list(request: HidRequest): Promise<EmergencyContactView[]> {
    const actor = requirePatient(request.actor);
    try {
      const rows = await this.asPatient(request, actor, (client) => this.rows(client, actor));
      return rows.map((row) => this.view(row));
    } catch (error) {
      throw translate(error);
    }
  }

  async add(request: HidRequest, input: AddEmergencyContactDto): Promise<EmergencyContactView> {
    const actor = requirePatient(request.actor);
    this.protector.assertConfigured();
    const destination = this.protector.normalizeDestination(input.channel, input.destination);
    const contactId = randomUUID();
    try {
      const row = await this.asPatient(request, actor, async (client) => {
        await client.query(
          'select identity.add_my_emergency_contact($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [actor.subject, actor.sessionId, contactId, input.relationship, input.channel,
            this.protector.encrypt(contactId, { name: input.name, destination }), this.protector.keyVersion,
            this.protector.destinationHmac(input.channel, destination), input.notifyOnEmergencyAccess ?? true],
        );
        return (await this.rows(client, actor)).find((candidate) => candidate.contact_id === contactId);
      });
      if (!row) throw unavailable();
      return this.view(row);
    } catch (error) {
      throw translate(error);
    }
  }

  async update(request: HidRequest, contactId: string, input: UpdateEmergencyContactDto): Promise<EmergencyContactView> {
    const actor = requirePatient(request.actor);
    try {
      const row = await this.asPatient(request, actor, async (client) => {
        const current = (await this.rows(client, actor)).find((candidate) => candidate.contact_id === contactId);
        if (!current) throw new DomainProblem(404, 'EMERGENCY_CONTACT_NOT_FOUND', 'The emergency contact is unavailable');
        const secret = this.protector.decrypt(contactId, current.contact_key_version, current.contact_ciphertext);
        await client.query(
          'select identity.update_my_emergency_contact($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [actor.subject, actor.sessionId, contactId, input.expectedVersion,
            input.relationship ?? current.relationship,
            this.protector.encrypt(contactId, { name: input.name ?? secret.name, destination: secret.destination }),
            this.protector.keyVersion, this.protector.destinationHmac(current.channel, secret.destination),
            input.notifyOnEmergencyAccess ?? null],
        );
        return (await this.rows(client, actor)).find((candidate) => candidate.contact_id === contactId);
      });
      if (!row) throw unavailable();
      return this.view(row);
    } catch (error) {
      throw translate(error);
    }
  }

  async deactivate(request: HidRequest, contactId: string): Promise<{ contactId: string; status: 'deactivated'; replayed: boolean }> {
    const actor = requirePatient(request.actor);
    try {
      const row = await this.asPatient(request, actor, async (client) => (await client.query<{ contact_id: string; replayed: boolean }>(
        'select contact_id, replayed from identity.deactivate_my_emergency_contact($1, $2, $3)',
        [actor.subject, actor.sessionId, contactId],
      )).rows[0]);
      if (!row) throw unavailable();
      return { contactId: row.contact_id, status: 'deactivated', replayed: row.replayed };
    } catch (error) {
      throw translate(error);
    }
  }

  async sendVerification(request: HidRequest, contactId: string) {
    const actor = requirePatient(request.actor);
    if (!this.environment.EMERGENCY_CONTACT_DELIVERY_ENABLED) {
      throw new DomainProblem(503, 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE',
        'Emergency contact verification is not yet available');
    }
    this.protector.assertConfigured();
    const code = generateSixDigitOtp();
    const challengeId = randomUUID();
    let started: { challenge_id: string; expires_at: Date; channel: EmergencyContactChannel;
      contact_ciphertext: Buffer; contact_key_version: string } | undefined;
    try {
      started = await this.asPatient(request, actor, async (client) => (await client.query(
        'select challenge_id, expires_at, channel, contact_ciphertext, contact_key_version '
        + 'from identity.start_my_emergency_contact_verification($1, $2, $3, $4, $5, $6, $7, $8)',
        [actor.subject, actor.sessionId, contactId, challengeId, this.protector.verifier(challengeId, contactId, code),
          this.protector.verifierKeyVersion, this.environment.OTP_EXPIRY_SECONDS, this.environment.OTP_MAX_ATTEMPTS],
      )).rows[0]);
    } catch (error) {
      throw translate(error);
    }
    if (!started) throw unavailable();
    const recipient = this.protector.decrypt(contactId, started.contact_key_version, started.contact_ciphertext).destination;
    // The verification message carries only the code; no patient or clinical data.
    const delivery = await this.notification.deliver({
      challengeId, recipient, code, purpose: 'EMERGENCY_CONTACT_VERIFY', channel: started.channel,
      correlationId: request.correlationId,
    });
    await this.asPatient(request, actor, (client) => client.query(
      'select identity.record_my_emergency_contact_verification_delivery($1, $2, $3, $4, $5)',
      [actor.subject, actor.sessionId, challengeId, delivery.outcome, delivery.provider ?? null],
    ));
    if (delivery.outcome === 'definitive_failure') {
      throw new DomainProblem(502, 'EMERGENCY_CONTACT_VERIFICATION_UNDELIVERABLE',
        'The verification code could not be delivered to this contact');
    }
    return { challengeId, expiresAt: started.expires_at, deliveryOutcome: delivery.outcome };
  }

  async confirmVerification(request: HidRequest, contactId: string, input: ConfirmEmergencyContactVerificationDto) {
    const actor = requirePatient(request.actor);
    let outcome: string | undefined;
    try {
      outcome = await this.asPatient(request, actor, async (client) => (await client.query<{ outcome: string }>(
        'select identity.complete_my_emergency_contact_verification($1, $2, $3, $4, $5) as outcome',
        [actor.subject, actor.sessionId, contactId, input.challengeId,
          this.protector.verifier(input.challengeId, contactId, input.code)],
      )).rows[0]?.outcome);
    } catch (error) {
      throw translate(error);
    }
    // Failed attempts and their audit commit before the denial is reported.
    if (outcome === 'verified') return { contactId, status: 'verified' as const };
    if (outcome === 'expired') {
      throw new DomainProblem(403, 'EMERGENCY_CONTACT_CODE_EXPIRED', 'The verification code has expired. Send a new code.');
    }
    if (outcome === 'invalid') {
      throw new DomainProblem(403, 'EMERGENCY_CONTACT_CODE_INVALID', 'The verification code is invalid or expired');
    }
    throw unavailable();
  }

  private async rows(client: PoolClient, actor: PatientSessionActor): Promise<ContactRow[]> {
    return (await client.query<ContactRow>(
      'select * from identity.list_my_emergency_contacts($1, $2)', [actor.subject, actor.sessionId],
    )).rows;
  }

  private view(row: ContactRow): EmergencyContactView {
    const secret = this.protector.decrypt(row.contact_id, row.contact_key_version, row.contact_ciphertext);
    return {
      contactId: row.contact_id,
      name: secret.name,
      relationship: row.relationship,
      channel: row.channel,
      destinationHint: maskDestination(row.channel, secret.destination),
      status: row.status,
      verifiedAt: row.verified_at,
      notifyOnEmergencyAccess: row.notify_on_emergency_access,
      eligibleForEmergencyNotification: row.status === 'verified' && row.notify_on_emergency_access,
      version: Number(row.row_version),
      pendingVerification: row.verification_expires_at
        ? { expiresAt: row.verification_expires_at, deliveryOutcome: row.verification_delivery_outcome ?? 'pending' }
        : null,
      lastNotification: row.last_notification_status && row.last_notification_at
        ? { status: row.last_notification_status, createdAt: row.last_notification_at }
        : null,
    };
  }

  private asPatient<Result>(
    request: HidRequest,
    actor: PatientSessionActor,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject', $1, true)", [actor.subject]);
      return operation(client);
    });
  }
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'EMERGENCY_CONTACTS_UNAVAILABLE', 'Emergency contacts are temporarily unavailable');
}

function translate(error: unknown): unknown {
  if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
  const message = databaseMessage(error);
  switch (error.code) {
    case '42501':
      return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    case 'P0001':
      return message === 'EMERGENCY_CONTACT_LIMIT_REACHED'
        ? new DomainProblem(409, 'EMERGENCY_CONTACT_LIMIT_REACHED', 'You can keep up to five emergency contacts')
        : new DomainProblem(429, 'EMERGENCY_CONTACT_VERIFICATION_RATE_LIMITED',
          'Too many verification codes. Wait before sending another.');
    case 'P0002':
      return new DomainProblem(404, 'EMERGENCY_CONTACT_NOT_FOUND', 'The emergency contact is unavailable');
    case '23505':
      return new DomainProblem(409, 'EMERGENCY_CONTACT_DUPLICATE', 'This contact is already on your list');
    case '40001':
      return new DomainProblem(409, 'EMERGENCY_CONTACT_VERSION_CONFLICT', 'This contact changed. Reload and try again.');
    case '55000':
      return new DomainProblem(409, 'EMERGENCY_CONTACT_ALREADY_VERIFIED', 'This contact is already verified');
    case '22023':
    case '22P02':
    case '23514':
      return new DomainProblem(400, 'INVALID_EMERGENCY_CONTACT', 'The emergency contact is invalid');
    default:
      return error;
  }
}
