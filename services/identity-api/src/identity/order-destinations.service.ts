import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { consumeRateLimit, type RateLimitWindow } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/** 60 searches per membership per hour (SPEC-FINAL §3.4, FEAS R6). */
export const ORDER_DESTINATION_SEARCH_WINDOW: RateLimitWindow = { windowSeconds: 3600, maxRequests: 60 };

export const ORDER_DESTINATION_KINDS = ['laboratory', 'pharmacy'] as const;
export type OrderDestinationKind = (typeof ORDER_DESTINATION_KINDS)[number];

const localSearchKey = randomBytes(32);

interface DestinationRow {
  facility_id: string;
  facility_name: string;
  organization_name: string;
  registered_address: string | null;
  new_on_health_id: boolean | null;
}

export interface OrderDestination {
  facilityId: string;
  facilityName: string;
  organizationName: string;
  registeredAddress: string | null;
  newOnHealthId: boolean;
}

const queryInvalid = () => new DomainProblem(400, 'ORDER_DESTINATION_QUERY_INVALID',
  'Choose laboratory or pharmacy and enter 3 to 80 characters of the facility\'s name');

export const crossFacilityOrdersUnavailable = () => new DomainProblem(423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE',
  'Orders between facilities are paused on Health ID');

/**
 * The clinician's directory of laboratories and pharmacies at other
 * facilities that can receive an order (P4c, SPEC-FINAL §3.4, §9.4, C19).
 * The member's searches are counted first, in their own committed
 * transaction, in an `account` bucket keyed by an HMAC of the membership
 * (FEAS R6, key handling as staff-invitations.service.ts): 60 an hour, the
 * 61st answers 429. Then C19 lists at most 10 eligible facilities. The
 * audit row names the kind and the count, never what was searched for.
 */
@Injectable()
export class OrderDestinationsService {
  private readonly environment = getEnvironment();
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localSearchKey;

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  /** The kind and the trimmed query, or 400 ORDER_DESTINATION_QUERY_INVALID. */
  static validate(kind: unknown, query: unknown): { kind: OrderDestinationKind; query: string } {
    if (typeof kind !== 'string' || !(ORDER_DESTINATION_KINDS as readonly string[]).includes(kind)) throw queryInvalid();
    if (typeof query !== 'string') throw queryInvalid();
    const trimmed = query.trim();
    if (trimmed.length < 3 || trimmed.length > 80) throw queryInvalid();
    return { kind: kind as OrderDestinationKind, query: trimmed };
  }

  /** The member's search bucket: HMAC-SHA-256 with the OTP key over 'order-destination-search\0' + membership id. */
  bucket(membershipId: string): string {
    if (!this.key) throw new DomainProblem(503, 'ORDER_DESTINATIONS_UNAVAILABLE', 'The directory is temporarily unavailable');
    return createHmac('sha256', this.key).update('order-destination-search\0').update(membershipId).digest('hex');
  }

  async search(context: DataAccessContext, kind: OrderDestinationKind, query: string): Promise<{ items: OrderDestination[] }> {
    const bucket = this.bucket(context.membershipId);
    let limited: boolean;
    try {
      limited = await this.database.withTransaction(context, (client) =>
        consumeRateLimit(client, 'account', bucket, ORDER_DESTINATION_SEARCH_WINDOW));
    } catch {
      throw new DomainProblem(503, 'ORDER_DESTINATIONS_UNAVAILABLE', 'The directory is temporarily unavailable');
    }
    if (limited) {
      throw new DomainProblem(429, 'ORDER_DESTINATION_SEARCH_LIMITED', 'Too many searches: try again in an hour');
    }
    try {
      return await this.database.withTransaction(context, async (client) => {
        const result = await client.query<DestinationRow>(
          `select facility_id::text as facility_id, facility_name, organization_name, registered_address, new_on_health_id
             from identity.search_order_destinations($1, $2)`,
          [kind, query],
        );
        const items = result.rows.map((row) => ({ facilityId: row.facility_id, facilityName: row.facility_name,
          organizationName: row.organization_name, registeredAddress: row.registered_address ?? null,
          newOnHealthId: row.new_on_health_id === true }));
        await this.audit.recordWithClient(client, {
          correlationId: context.correlationId, actorType: 'staff', actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId,
          action: 'identity.order-destinations.search', resourceType: 'order-destination-search',
          resourceId: context.facilityId, outcome: 'success', purposeOfUse: context.purposeOfUse,
          details: { kind, resultCount: items.length },
        });
        return { items };
      });
    } catch (error) {
      throw destinationProblem(error);
    }
  }
}

/** C19's refusals (SPEC-FINAL §8.7, §11): never the database's text. */
export function destinationProblem(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message : '';
  if ((code === '55000' && (message === 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled'
    || message === 'PLATFORM_CONTROL_UNAVAILABLE')) || (code === '22023' && message === 'PLATFORM_CONTROL_INVALID')) {
    return crossFacilityOrdersUnavailable();
  }
  if (code === '22023') return queryInvalid();
  if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Sending orders to other facilities is not permitted here');
  return new DomainProblem(503, 'ORDER_DESTINATIONS_UNAVAILABLE', 'The directory is temporarily unavailable');
}
