import { type CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { getEnvironment } from '../config/environment';

/** The Outreach switches read once from the environment. */
@Injectable()
export class OutreachFeatures {
  /** Visits, the Health ID preview and link, and staff names (0115). */
  readonly visitsEnabled: boolean = getEnvironment().OUTREACH_VISITS_ENABLED;
}

/**
 * A route that exists only while OUTREACH_VISITS_ENABLED is on answers a
 * plain 404 NOT_FOUND while it is off, as identity-api's switches do. It runs
 * after the global OutreachSecurityGuard (so a request without a valid
 * session, facility or permission is refused as before) and before the body
 * is validated.
 */
@Injectable()
export class VisitsEnabledGuard implements CanActivate {
  constructor(private readonly features: OutreachFeatures) {}

  canActivate(): boolean {
    if (!this.features.visitsEnabled) throw new NotFoundException();
    return true;
  }
}
