import { getEnvironment } from '../config/environment';
import { staffRoleOffered } from './staff-licence';

/**
 * CHW-1 (0209): whether a staff role may be offered and given now, under this deployment's settings
 * (COMMUNITY_HEALTH_WORKER_ENABLED, read on every call). See staffRoleOffered.
 */
export function staffRoleOfferedNow(role: string): boolean {
  return staffRoleOffered(role, { communityHealthWorkerEnabled: getEnvironment().COMMUNITY_HEALTH_WORKER_ENABLED });
}
