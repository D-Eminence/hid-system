import { getEnvironment, isProductionProfile, type Environment } from '../config/environment';
import type { DatabaseService } from '../database/database.service';

/** The routes to prove that a person holds a NIN (ADR-062, ADR-063). */
export interface OwnershipRoutes { online: boolean; facility: boolean }

/**
 * Whether any facility takes part (0094). identity.list_participating_facilities()
 * answers only system context, so this is read in a system transaction.
 */
export const PARTICIPATING_FACILITY_READ =
  'select exists(select 1 from identity.list_participating_facilities()) as open';

/**
 * The online route: NIN_HOLDER_SMS_ENABLED, and in production an open
 * facility route too. The facility route is the remedy when someone who
 * knows a NIN closes its online route (ADR-063).
 */
export function onlineRouteOpen(
  environment: Pick<Environment, 'NIN_HOLDER_SMS_ENABLED' | 'HID_DEPLOYMENT_ENV' | 'NODE_ENV'>,
  facilityOpen: boolean): boolean {
  return environment.NIN_HOLDER_SMS_ENABLED && (facilityOpen || !isProductionProfile(environment));
}

/**
 * The keys a start needs before it reads a NIN: the NIN lookup and encryption
 * keys, and where NODE_ENV is production the OTP key. Without them a start
 * answers 503 ENROLLMENT_CONFIGURATION_UNAVAILABLE and availability answers
 * open: false, whatever the routes say.
 */
export function enrollmentKeysConfigured(environment: Pick<Environment,
  'NIN_LOOKUP_HMAC_KEY_B64' | 'NIN_ENCRYPTION_KEY_B64' | 'OTP_HMAC_KEY_B64' | 'NODE_ENV'>): boolean {
  return Boolean(environment.NIN_LOOKUP_HMAC_KEY_B64 && environment.NIN_ENCRYPTION_KEY_B64
    && (environment.NODE_ENV !== 'production' || environment.OTP_HMAC_KEY_B64));
}

/** ADR-063: the flag, then whether any facility takes part; no read while the flag is off. */
export async function facilityRouteOpen(database: Pick<DatabaseService, 'withSystemTransaction'>,
  correlationId: string): Promise<boolean> {
  if (!getEnvironment().ASSISTED_REGISTRATION_ENABLED) return false;
  const open = await database.withSystemTransaction(correlationId, (client) =>
    client.query<{ open: boolean }>(PARTICIPATING_FACILITY_READ));
  return open.rows[0]?.open === true;
}

/** Both routes from one facility read: what a start, availability and the admin status see. */
export async function ownershipRoutes(database: Pick<DatabaseService, 'withSystemTransaction'>,
  correlationId: string): Promise<OwnershipRoutes> {
  const facility = await facilityRouteOpen(database, correlationId);
  return { online: onlineRouteOpen(getEnvironment(), facility), facility };
}
