import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { DomainProblem } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { matchingCacIncompleteProfile, verifiedCacBinding } from './organization-applications.service';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import type { StartProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { selfServiceClosed, selfServiceDailyCap, selfServiceGateRefusal } from './provider-self-service-gate';

interface ApplicationRow {
  application_id: string;
  application_status: string;
  verification_result: string | null;
  provider_verified_registration_number: string | null;
  row_version: string;
}

interface ControlRow {
  self_service: boolean | null;
  provider_portal: boolean | null;
  maintenance: boolean | null;
}

const localNetworkKey = randomBytes(32);

/**
 * Availability's answer. Closed carries why (P4 review fix R10): 'closed'
 * when sign-up is switched off or not configured (the control, the provider
 * portal, maintenance, the daily cap, QOREID_ENABLED, the OTP key, QoreID's
 * provider_cac runtime gate), 'unavailable' when the answer could not be
 * determined (a database or other fault). The page shows "not open" only for
 * 'closed', and "try again shortly" for 'unavailable'.
 */
export type ProviderEnrollmentAvailability = { open: true } | { open: false; reason: 'closed' | 'unavailable' };

// Shown to the applicant as it is. It must be true for both cases the adapter
// answers with cacIncompleteProfile: a record missing legal fields, and a
// complete record whose company is not active. The governed organization
// application has no page in the launch portal (the public site is not
// deployed at launch), so the applicant is sent to support rather than to it.
const CAC_PROFILE_INCOMPLETE_DETAIL = 'We could not register your organization automatically from its CAC record.'
  + ' The record is missing details we need or does not show the company as active.'
  + ' Contact Health ID support.';

/**
 * The client network an accountless CAC lookup is charged to: an IPv4 address,
 * or the /64 prefix of an IPv6 address (one subscriber allocation, so rotating
 * addresses inside it does not reset the quota). IPv4-mapped IPv6 is treated as
 * IPv4. Returns null for anything that is not an IP address. Self-contained
 * (main 08c906f): Novu keys its other public limits on the raw address and has
 * no client-network module.
 */
export function quotaNetwork(remoteIp: string | undefined): string | null {
  if (!remoteIp) return null;
  const address = remoteIp.split('%', 1)[0] ?? '';
  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return null;
  let text = address.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const leading = head ? head.split(':') : [];
  const trailing = tail ? tail.split(':') : [];
  const groups = [...leading, ...Array<string>(8 - leading.length - trailing.length).fill('0'), ...trailing]
    .map((group) => Number.parseInt(group, 16));
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

@Injectable()
export class ProviderEnrollmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrations: IntegrationRuntimeService,
    private readonly qoreid: QoreIdVerificationAdapter,
    private readonly completion: OrganizationProfileCompletionService,
  ) {}

  /**
   * The gate every self sign-up route checks before it writes anything: the
   * control provider_self_service_enabled on, the provider portal on,
   * maintenance off and a valid daily cap. Closed answers 423
   * PROVIDER_ENROLLMENT_UNAVAILABLE; a control that is missing or unknown
   * (the migration not applied) is closed too. Any other fault is 503.
   */
  async assertSelfServiceOpen(): Promise<void> {
    if (selfServiceDailyCap(getEnvironment()) === null) throw selfServiceClosed();
    let row: ControlRow | undefined;
    try {
      const result = await this.database.query<ControlRow>(
        `select platform.control_enabled('provider_self_service_enabled') as self_service,
                platform.control_enabled('provider_portal_enabled') as provider_portal,
                platform.control_enabled('maintenance_mode') as maintenance`);
      row = result.rows[0];
    } catch (error) {
      throw selfServiceGateRefusal(error) ?? this.unavailable();
    }
    if (row?.self_service !== true || row.provider_portal !== true || row.maintenance !== false) {
      throw selfServiceClosed();
    }
  }

  /**
   * Whether a start would now pass the checks it makes before any
   * per-request decision: the gate, QOREID_ENABLED, the QoreID provider_cac
   * runtime gate and, in production, the OTP key. It reads no application and
   * writes nothing, and never answers an error: closed is { open: false,
   * reason: 'closed' } when sign-up is switched off or not configured, and
   * { open: false, reason: 'unavailable' } for any fault (R10).
   */
  async availability(): Promise<ProviderEnrollmentAvailability> {
    const closed = { open: false as const, reason: 'closed' as const };
    try {
      const environment = getEnvironment();
      if (!environment.QOREID_ENABLED) return closed;
      if (environment.NODE_ENV === 'production' && !environment.OTP_HMAC_KEY_B64) return closed;
      await this.assertSelfServiceOpen();
      await this.integrations.assertAvailable('qoreid', 'provider_cac');
      return { open: true };
    } catch (error) {
      if (error instanceof DomainProblem && (
        (error.getStatus() === 423 && error.code === 'PROVIDER_ENROLLMENT_UNAVAILABLE')
        || error.code === 'INTEGRATION_PAUSED')) {
        return closed;
      }
      return { open: false, reason: 'unavailable' };
    }
  }

  async start(input: StartProviderEnrollmentDto, request: HidRequest) {
    // The gate comes after Turnstile (the controller) and before anything is
    // written or charged.
    await this.assertSelfServiceOpen();
    const environment = getEnvironment();
    if (!environment.QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'External verification is not enabled');
    }
    const platformDailyLimit = selfServiceDailyCap(environment);
    if (platformDailyLimit === null) throw selfServiceClosed();
    // Derived from the server-observed address before anything is written:
    // the client network (an IPv4 address or an IPv6 /64) keys both the CAC
    // lookup quota and the public application quota (R5), so rotating IPv6
    // addresses inside one allocation resets neither.
    const network = this.quotaNetworkOrUnavailable(request.ip);
    const networkDigest = this.networkDigest(network);
    const applicationDigest = this.completion.publicApplicationNetworkDigest(network);

    // The public application quota (0049) is charged first, in its own
    // committed transaction (P4 A7, review fix R4): every start costs one of
    // the network's 10 an hour and 30 a day, including one the submit then
    // refuses (409 PROVIDER_ENROLLMENT_REQUIRES_REVIEW), so probing which
    // CACs have an application costs quota. It is the start's only charge:
    // the email code below does not charge it again (C8).
    try {
      await this.database.withSystemTransaction(request.correlationId, (client) =>
        client.query('select platform.consume_public_application_quota($1)', [applicationDigest]));
    } catch (error) {
      throw this.mapDatabaseError(error);
    }

    let applicationId: string | undefined;
    try {
      applicationId = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        const result = await client.query<{ application_id: string }>(
          'select identity.submit_self_service_organization_application($1,$2,$3,$4,$5,$6) as application_id',
          [input.productCode, input.organizationType, input.cacRegistrationNumber,
            input.administratorName, input.administratorEmail.trim().toLowerCase(), networkDigest],
        );
        return result.rows[0]?.application_id;
      });
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
    if (!applicationId) throw this.unavailable();

    let current: ApplicationRow | undefined;
    try {
      current = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        const result = await client.query<ApplicationRow>(
          'select * from identity.public_get_organization_application($1,$2,$3)',
          [input.cacRegistrationNumber, input.administratorEmail.trim().toLowerCase(), input.productCode],
        );
        return result.rows[0];
      });
    } catch (error) {
      throw this.mapDatabaseError(error);
    }

    if (!current || current.application_id !== applicationId) {
      throw new DomainProblem(409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW',
        'This provider application requires manual resolution');
    }

    if (current.application_status === 'approved') {
      throw new DomainProblem(409, 'PROVIDER_ALREADY_REGISTERED',
        'This provider organization is already registered with HID');
    }

    if (current.application_status === 'ready_for_review'
      && current.verification_result === 'verified'
      && current.provider_verified_registration_number === input.cacRegistrationNumber) {
      return this.startEmailVerification(input, request);
    }

    try {
      await this.integrations.assertAvailable('qoreid', 'provider_cac');
      await this.integrations.consumeSelfServiceCacQuota(request.correlationId, applicationId, networkDigest,
        platformDailyLimit);

      const providerResult = await this.qoreid.verifyCac(input.cacRegistrationNumber);
      if (providerResult.state !== 'verified') {
        await this.database.withSystemTransaction(request.correlationId, (client) =>
          client.query(
            'select * from identity.public_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [applicationId, Number(current.row_version), providerResult.state,
              providerResult.providerReference ?? null, null, null, null, null, null, null],
          ));
        throw new DomainProblem(422, 'CAC_NOT_VERIFIED',
          'The CAC could not be verified. Check the registration number and try again.');
      }

      const binding = verifiedCacBinding(input.cacRegistrationNumber, providerResult);
      if (!binding || !providerResult.providerReference) {
        // QoreID verified this CAC but returned too little of its legal
        // profile to register it without review. Nothing is recorded, as for
        // a malformed answer.
        if (!providerResult.cacBinding
          && matchingCacIncompleteProfile(input.cacRegistrationNumber, providerResult)) {
          throw new DomainProblem(409, 'PROVIDER_CAC_PROFILE_INCOMPLETE', CAC_PROFILE_INCOMPLETE_DETAIL);
        }
        throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
          'External verification returned an invalid response');
      }

      await this.database.withSystemTransaction(request.correlationId, (client) =>
        client.query(
          'select * from identity.public_record_organization_cac_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [applicationId, Number(current.row_version), 'verified', providerResult.providerReference,
            binding.registrationNumber, binding.companyName, binding.entityType,
            binding.registrationDate, binding.address, binding.registryStatus],
        ));
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(503, 'PROVIDER_CAC_VERIFICATION_UNAVAILABLE',
        'CAC verification is temporarily unavailable');
    }

    return this.startEmailVerification(input, request);
  }

  private mapDatabaseError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const closed = selfServiceGateRefusal(error);
    if (closed) return closed;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'P4290') {
      return new DomainProblem(429, 'APPLICATION_RATE_LIMITED',
        'Application request limit reached; try again later');
    }
    // Start makes no account check, so a unique violation here is never about
    // the email. The only one is another application opened for the same CAC
    // and product at the same moment (organization_applications_open_cac_product_uq),
    // which a retry also answers as requiring review.
    if (code === '23514' || code === '23505') {
      return new DomainProblem(409, 'PROVIDER_ENROLLMENT_REQUIRES_REVIEW',
        'This provider organization requires manual resolution');
    }
    if (code === '40001') {
      return new DomainProblem(409, 'VERSION_CONFLICT',
        'Provider enrollment changed; start again');
    }
    if (code === '42501') {
      return new DomainProblem(403, 'PROVIDER_ENROLLMENT_DENIED',
        'Provider enrollment is not available');
    }
    return this.unavailable();
  }

  private unavailable(): DomainProblem {
    return new DomainProblem(503, 'PROVIDER_ENROLLMENT_UNAVAILABLE',
      'Provider enrollment is temporarily unavailable');
  }

  private quotaNetworkOrUnavailable(remoteIp: string | undefined): string {
    const environment = getEnvironment();
    const network = quotaNetwork(remoteIp);
    if (!network || (environment.NODE_ENV === 'production' && !environment.OTP_HMAC_KEY_B64)) {
      throw new DomainProblem(503, 'PROVIDER_ENROLLMENT_RATE_LIMIT_UNAVAILABLE',
        'Provider enrollment is temporarily unavailable');
    }
    return network;
  }

  /**
   * The keyed digest of a client network for the CAC lookup quota and for
   * the application (whose network may not reopen its CAC and product for 7
   * days after support or the lapse closes it, R3).
   */
  private networkDigest(network: string): string {
    const environment = getEnvironment();
    const key = environment.OTP_HMAC_KEY_B64
      ? Buffer.from(environment.OTP_HMAC_KEY_B64, 'base64') : localNetworkKey;
    return createHmac('sha256', key)
      .update('provider-self-service-cac-network\0', 'utf8')
      .update(network, 'utf8').digest('hex');
  }

  /**
   * The emailed code. The administrator name and organization type of this
   * request go with it, and the activation takes them from the code that
   * proved the mailbox (R6).
   */
  private startEmailVerification(input: StartProviderEnrollmentDto, request: HidRequest) {
    return this.completion.start({
      productCode: input.productCode,
      cacRegistrationNumber: input.cacRegistrationNumber,
      administratorEmail: input.administratorEmail,
      turnstileAction: 'organization-completion',
      turnstileToken: input.turnstileToken,
    }, request.ip, request.correlationId, {
      publicApplicationQuotaCharged: true,
      selfService: { administratorName: input.administratorName, organizationType: input.organizationType },
    });
  }
}
