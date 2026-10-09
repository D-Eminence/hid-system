import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import { PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { WorkloadCredentialsService } from './workload-credentials.service';
import { DatabaseService } from '../database/database.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class OutreachSecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly workload: WorkloadCredentialsService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE,
      [execution.getHandler(), execution.getClass()])) return true;
    const request = execution.switchToHttp().getRequest<HidRequest>();
    const required = this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_PERMISSIONS,
      [execution.getHandler(), execution.getClass()]) ?? [];
    if (required.length !== 1) throw new DomainProblem(500, 'OUTREACH_POLICY_INVALID',
      'The Outreach authorization policy is invalid');
    const facilityId = request.header('x-facility-id');
    if (!facilityId || !UUID.test(facilityId)) throw new DomainProblem(400, 'FACILITY_REQUIRED',
      'A valid X-Facility-ID header is required');
    const authorization = request.header('authorization');
    const cookie = request.header('cookie');
    if (!authorization?.startsWith('Bearer ') && !cookie) throw new DomainProblem(401,
      'AUTHENTICATION_REQUIRED', 'Valid Identity authentication is required');
    const origin = request.header('origin');
    const csrf = request.header('x-csrf-token');
    if (cookie && (!origin || !csrf || !this.allowedOrigins().has(origin))) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED',
        'Cookie-authenticated Outreach access requires a valid origin and CSRF token');
    }
    const actor = await this.identityClient().authorizeOutreachPermission(required[0] ?? '', {
      correlationId: request.correlationId, facilityId, authorization, cookie,
      origin, csrfToken: csrf, purposeOfUse: 'direct-care',
    }).catch((error) => { if (error instanceof IdentityApiProblem) throw new DomainProblem(error.status,
      error.code ?? 'IDENTITY_AUTHORIZATION_DENIED', error.message); throw new DomainProblem(503,
      'IDENTITY_SERVICE_UNAVAILABLE', 'Identity authorization service is unavailable'); }) as ActorContext;
    const assignment = actor.facilities.find((candidate) => candidate.id === facilityId);
    if (!assignment || !assignment.permissions.includes(required[0] ?? '')) {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED',
        'Identity did not authorize Outreach access at this facility');
    }
    request.facilityId = facilityId;
    request.actor = { ...actor, facility: assignment, roles: assignment.roles,
      role: assignment.roles[0], permissions: assignment.permissions };
    await this.enforceRuntimeControls(request);
    return true;
  }

  private async enforceRuntimeControls(request: HidRequest): Promise<void> {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const isPlatformAdmin = actor.platformPermissions?.includes('platform.admin.access') ?? false;
    if (isPlatformAdmin) return;

    if (await this.controlEnabled('maintenance_mode')) {
      throw new DomainProblem(503, 'PLATFORM_MAINTENANCE', 'HID is temporarily in maintenance mode');
    }
    if (!(await this.controlEnabled('outreach_portal_enabled'))) {
      throw new DomainProblem(423, 'PLATFORM_PORTAL_DISABLED', 'The Outreach portal is temporarily disabled');
    }
  }

  private async controlEnabled(controlKey: string): Promise<boolean> {
    try {
      const result = await this.database.query<{ enabled: boolean }>(
        'select platform.control_enabled($1) as enabled',
        [controlKey],
      );
      return result.rows[0]?.enabled === true;
    } catch (error) {
      if (isDatabaseError(error) && error.code === '55000') {
        if (String((error as { message?: unknown }).message ?? '').startsWith('PLATFORM_CONTROL_DISABLED:')) return false;
        throw new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
      }
      throw error;
    }
  }

  private allowedOrigins(): ReadonlySet<string> {
    return new Set(getEnvironment().CORS_ORIGINS.split(',').map((origin) => origin.trim()));
  }

  private identityClient(): IdentityApiClient {
    return new IdentityApiClient({ baseUrl: getEnvironment().IDENTITY_API_URL,
      caller: 'outreach-api', timeoutMs: 5_000,
      workloadHeaders: () => this.workload.headers() });
  }
}

function isDatabaseError(value: unknown): value is { code: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
