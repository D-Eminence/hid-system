import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import { PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { WorkloadCredentialsService } from './workload-credentials.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class OutreachSecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly workload: WorkloadCredentialsService,
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
    return true;
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
