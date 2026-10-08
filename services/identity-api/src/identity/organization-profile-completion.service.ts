import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { QueryResultRow } from 'pg';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import * as argon2 from 'argon2';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { CompleteOrganizationProfileDto, StartOrganizationProfileCompletionDto } from './dto/organization-application.dto';

const localCompletionKey = randomBytes(32);
type FieldSource = 'qoreid' | 'user_provided' | null;

interface CompletionProfileRow extends QueryResultRow {
  application_status: 'pending_verification' | 'ready_for_review';
  profile_state: 'incomplete' | 'complete';
  row_version: string;
  product_code: string;
  cac_registration_number: string;
  profile_organization_name: string | null;
  profile_organization_name_source: FieldSource;
  profile_entity_type: string | null;
  profile_entity_type_source: FieldSource;
  profile_registration_date: string | null;
  profile_registration_date_source: FieldSource;
  profile_address: string | null;
  profile_address_source: FieldSource;
  profile_registry_status: string | null;
  profile_registry_status_source: FieldSource;
}

@Injectable()
export class OrganizationProfileCompletionService {
  private readonly environment = getEnvironment();
  private readonly key = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64') : localCompletionKey;

  constructor(private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient) {}

  async start(input: StartOrganizationProfileCompletionDto, remoteIp: string | undefined,
    correlationId: string) {
    this.assertConfigured();
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const registrationNumber = input.cacRegistrationNumber.replace(/\s+/g, '').toUpperCase();
    const email = input.administratorEmail.trim().toLowerCase();
    let recipient: string | null;
    try {
      recipient = await this.database.withSystemTransaction(correlationId, async (client) => {
        await client.query('select platform.consume_public_application_quota($1)', [
          this.networkDigest(remoteIp),
        ]);
        const found = await client.query<{ recipient_email: string | null }>(
          'select identity.begin_organization_profile_completion($1,$2,$3,$4,$5) as recipient_email',
          [registrationNumber, email, input.productCode, challengeId,
            this.hmac('otp', challengeId, code)],
        );
        return found.rows[0]?.recipient_email ?? null;
      });
    } catch (error) { throw this.databaseProblem(error); }
    if (recipient) {
      const delivered = await this.notification.deliver({
        challengeId, recipient, code, purpose: 'EMAIL_VERIFY', channel: 'email', correlationId,
      }).catch(() => ({ outcome: 'unknown' as const }));
      if (delivered.outcome === 'definitive_failure') {
        await this.database.withSystemTransaction(correlationId, (client) =>
          client.query('select identity.invalidate_organization_profile_completion_challenge($1)',
            [challengeId])).catch(() => undefined);
      }
    }
    return { accepted: true as const, challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 };
  }

  async verify(challengeId: string, code: string, correlationId: string) {
    this.assertConfigured();
    if (!/^[0-9]{6}$/.test(code)) throw this.invalidCode();
    const token = randomBytes(32).toString('base64url');
    let verified: boolean;
    try {
      verified = await this.database.withSystemTransaction(correlationId, async (client) => {
        const result = await client.query<{ verified: boolean }>(
          'select identity.verify_organization_profile_completion_challenge($1,$2,$3) as verified',
          [challengeId, this.hmac('otp', challengeId, code), this.hmac('session', token)],
        );
        return result.rows[0]?.verified === true;
      });
    } catch (error) { throw this.databaseProblem(error); }
    if (!verified) throw this.invalidCode();
    return { verified: true as const, cookie: token };
  }

  async current(token: string | undefined, correlationId: string) {
    const sessionHash = this.sessionHash(token);
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<CompletionProfileRow>(
          'select * from identity.current_organization_profile_completion($1)', [sessionHash]));
      const row = result.rows[0];
      if (!row) throw this.invalidSession();
      return this.profile(row);
    } catch (error) { throw this.databaseProblem(error); }
  }

  async complete(token: string | undefined, expectedVersion: number,
    input: CompleteOrganizationProfileDto, correlationId: string) {
    const sessionHash = this.sessionHash(token);
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<CompletionProfileRow>(
          'select * from identity.complete_organization_profile($1,$2,$3,$4,$5,$6,$7)',
          [sessionHash, expectedVersion, input.companyName ?? null, input.entityType ?? null,
            input.registrationDate ?? null, input.address ?? null, input.registryStatus ?? null]));
      const row = result.rows[0];
      if (!row) throw this.invalidSession();
      return this.profile(row);
    } catch (error) { throw this.databaseProblem(error); }
  }

  async activate(token: string | undefined, password: string, correlationId: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new DomainProblem(400, 'PASSWORD_INVALID', 'Password must be 12–256 characters');
    }
    const sessionHash = this.sessionHash(token);
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    try {
      const result = await this.database.withSystemTransaction(correlationId, (client) =>
        client.query<{
          organization_id: string;
          facility_id: string;
          account_id: string;
          row_version: string;
          hid_subject: string;
          account_email: string;
        }>(
          // The login email is returned by the same transaction that creates the
          // account; nothing is read after the activation commits.
          'select * from identity.activate_self_service_provider_enrollment($1,$2)',
          [sessionHash, passwordHash],
        ));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'PROVIDER_ENROLLMENT_ACTIVATION_UNAVAILABLE',
        'Provider account activation is temporarily unavailable');
      return {
        organizationId: row.organization_id,
        facilityId: row.facility_id,
        accountId: row.account_id,
        email: row.account_email,
      };
    } catch (error) {
      throw this.databaseProblem(error);
    }
  }

  private profile(row: CompletionProfileRow) {
    return { status: row.application_status, profileState: row.profile_state,
      version: Number(row.row_version), productCode: row.product_code,
      registrationNumber: row.cac_registration_number,
      fields: {
        companyName: { value: row.profile_organization_name, source: row.profile_organization_name_source },
        entityType: { value: row.profile_entity_type, source: row.profile_entity_type_source },
        registrationDate: { value: row.profile_registration_date, source: row.profile_registration_date_source },
        address: { value: row.profile_address, source: row.profile_address_source },
        registryStatus: { value: row.profile_registry_status, source: row.profile_registry_status_source },
      } };
  }

  private sessionHash(token: string | undefined): string {
    this.assertConfigured();
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw this.invalidSession();
    return this.hmac('session', token);
  }

  private networkDigest(remoteIp: string | undefined): string {
    if (!remoteIp || isIP(remoteIp) === 0) {
      throw new DomainProblem(503, 'APPLICATION_RATE_LIMIT_UNAVAILABLE',
        'Organization profile completion is temporarily unavailable');
    }
    return this.hmac('ip', remoteIp);
  }

  private hmac(label: string, ...parts: string[]): string {
    const digest = createHmac('sha256', this.key).update('organization-profile-completion\0');
    digest.update(label);
    for (const part of parts) digest.update('\0').update(part);
    return digest.digest('hex');
  }

  private assertConfigured(): void {
    if (this.environment.NODE_ENV === 'production' && !this.environment.OTP_HMAC_KEY_B64) {
      throw new DomainProblem(503, 'ORGANIZATION_COMPLETION_UNAVAILABLE',
        'Organization profile completion is temporarily unavailable');
    }
  }

  private invalidCode() {
    return new DomainProblem(401, 'ORGANIZATION_COMPLETION_CODE_INVALID',
      'The confirmation code is invalid or expired');
  }

  private invalidSession() {
    return new DomainProblem(401, 'ORGANIZATION_COMPLETION_SESSION_INVALID',
      'Organization profile completion session is invalid or expired');
  }

  private databaseProblem(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'P4290') return new DomainProblem(429, 'APPLICATION_RATE_LIMITED',
      'Application request limit reached; try again later');
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT',
      'Application changed; reload before retrying');
    if (code === '22023') return new DomainProblem(400, 'ORGANIZATION_PROFILE_INVALID',
      'The organization profile contains an invalid or provider-owned field');
    if (code === '42501') return this.invalidSession();
    if (code === '23514') return new DomainProblem(409, 'ORGANIZATION_REVIEW_REQUIRED',
      'Organization profile completion is unavailable');
    return new DomainProblem(503, 'ORGANIZATION_COMPLETION_UNAVAILABLE',
      'Organization profile completion is temporarily unavailable');
  }
}
