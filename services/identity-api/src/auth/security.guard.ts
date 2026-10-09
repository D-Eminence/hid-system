import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';
import { platformActionPolicy } from '../admin/high-risk-policy';
import {
  FACILITY_OPTIONAL,
  HIGH_RISK_ACTION,
  PLATFORM_SCOPE,
  PUBLIC_ROUTE,
  PATIENT_ALLOWED,
  REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { readPlatformAssurance, stepUpProblem } from './platform-assurance';
import { TokenService } from './token.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SecurityGuard implements CanActivate {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    if (this.metadata<boolean>(PUBLIC_ROUTE, context)) return true;
    const platformScope = this.metadata<boolean>(PLATFORM_SCOPE, context) === true;

    try {
      // Platform routes read only the platform session cookie and every other
      // route only the staff/patient cookie, so one browser can hold both.
      const { token, transport } = this.extractToken(request, platformScope);
      const verified = platformScope ? await this.tokens.verify(token, 'platform') : await this.tokens.verify(token);
      request.actor = verified.actor;
      request.authTransport = transport;
      await this.enforceRuntimeControls(request);
      if (verified.actor.kind === 'patient' && !this.metadata<boolean>(PATIENT_ALLOWED, context)) {
        throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
      }
      // Platform administration requires an MFA-verified platform session; a
      // staff, patient or facility session never satisfies it, and a platform
      // session is valid nowhere else.
      if (platformScope && verified.actor.kind !== 'platform') {
        throw new DomainProblem(403, 'PLATFORM_SESSION_REQUIRED',
          'Sign in to platform administration with your authenticator to continue');
      }
      if (!platformScope && verified.actor.kind === 'platform') {
        throw new DomainProblem(403, 'PLATFORM_SESSION_SCOPE_DENIED',
          'A platform administration session cannot be used for this operation');
      }
      if (transport === 'cookie' && !SAFE_METHODS.has(request.method)) {
        this.assertCookieMutationSecurity(request, verified.claims, platformScope);
      }

      if (platformScope) {
        // Platform administration acts on the whole platform. No facility is
        // bound, even if a client sends X-Facility-ID, and the facility-derived
        // roles and permissions of the administrator's own membership are
        // removed so they can neither satisfy nor leak into a platform route.
        request.accessScope = 'platform';
        request.facilityId = undefined;
        request.actor = {
          ...verified.actor,
          facility: undefined,
          roles: [],
          role: undefined,
          permissions: [],
        };
      }

      const facilityOptional = this.metadata<boolean>(FACILITY_OPTIONAL, context);
      const facilityId = request.header('x-facility-id');
      if (platformScope) {
        // No facility context on platform routes.
      } else if (!facilityOptional) {
        if (!facilityId || !this.uuid(facilityId)) {
          throw new DomainProblem(400, 'FACILITY_REQUIRED', 'A valid X-Facility-ID header is required');
        }
        const assignment = verified.actor.facilities.find((candidate) => candidate.id === facilityId);
        if (!assignment) {
          throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
        }
        request.facilityId = facilityId;
        request.actor = {
          ...verified.actor,
          facility: assignment,
          roles: assignment.roles,
          role: assignment.roles[0],
          permissions: assignment.permissions,
        };
      } else if (facilityId && verified.actor.facilityIds.includes(facilityId)) {
        request.facilityId = facilityId;
        const assignment = verified.actor.facilities.find((candidate) => candidate.id === facilityId);
        if (assignment) {
          request.actor = {
            ...verified.actor,
            facility: assignment,
            roles: assignment.roles,
            role: assignment.roles[0],
            permissions: assignment.permissions,
          };
        }
      }

      if (!platformScope) request.accessScope = 'facility';
      const required = this.metadata<readonly string[]>(REQUIRED_PERMISSIONS, context) ?? [];
      // Platform routes accept only platform-scope grants; every other route
      // accepts only the permissions of the bound facility membership.
      const available = new Set(platformScope
        ? (request.actor?.platformPermissions ?? [])
        : (request.actor?.permissions ?? []));
      const missing = required.filter((permission) => !available.has(permission));
      if (missing.length > 0) throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
      if (platformScope) await this.enforceHighRiskPolicy(request, context);
      return true;
    } catch (error) {
      if (platformScope && request.actor && request.actor.kind !== 'patient') {
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: 'staff',
          actorSubject: request.actor.subject,
          actorAccountId: request.actor.accountId,
          accessScope: 'platform',
          action: 'security.authorization',
          resourceType: 'http-request',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { method: request.method, route: this.routeTemplate(request),
            ...(error instanceof DomainProblem ? { code: error.code } : {}),
            ...(request.highRiskAction ? { highRiskAction: request.highRiskAction } : {}) },
        });
      } else if (request.actor && request.facilityId) {
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: request.actor.kind === 'patient' ? 'patient' : 'staff',
          actorSubject: request.actor.subject,
          actorAccountId: request.actor.accountId,
          actorMembershipId: request.actor.facility?.membershipId,
          organizationId: request.actor.facility?.organizationId,
          facilityId: request.facilityId,
          action: 'security.authorization',
          resourceType: 'http-request',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { method: request.method, route: this.routeTemplate(request) },
        });
      } else if (request.actor) {
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: request.actor.kind === 'patient' ? 'patient' : 'staff',
          actorSubject: request.actor.subject,
          actorAccountId: request.actor.accountId,
          action: 'auth.authorization.denied',
          resourceType: 'authentication',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { method: request.method, route: this.routeTemplate(request) },
        });
      } else {
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: 'system',
          action: 'security.authorization.denied',
          resourceType: 'authentication',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { method: request.method, route: this.routeTemplate(request) },
          provenance: 'system',
        });
      }
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    }
  }

  /**
   * Central high-risk policy (admin/high-risk-policy.ts). A platform mutation
   * must declare a registered action; its declared controls are checked here
   * before the handler runs, and again by the service in its transaction.
   */
  private async enforceHighRiskPolicy(request: HidRequest, context: ExecutionContext): Promise<void> {
    const action = this.metadata<string>(HIGH_RISK_ACTION, context);
    if (!action) {
      if (SAFE_METHODS.has(request.method)) return;
      throw new DomainProblem(403, 'HIGH_RISK_POLICY_MISSING', 'This administration command has no security policy');
    }
    const policy = platformActionPolicy(action);
    if (!policy) throw new DomainProblem(403, 'HIGH_RISK_POLICY_MISSING', 'This administration command has no security policy');
    request.highRiskAction = action;
    const granted = new Set(request.actor?.platformPermissions ?? []);
    if (policy.permissions.some((permission) => !granted.has(permission))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    if (policy.ifMatch && !request.header('if-match')?.trim()) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    if (policy.idempotencyKey) requireIdempotencyKey(request.header('idempotency-key'));
    if (policy.reason) {
      const source = SAFE_METHODS.has(request.method) ? request.query : request.body as unknown;
      const reason = typeof source === 'object' && source !== null
        ? (source as Record<string, unknown>).reason : undefined;
      if (typeof reason !== 'string' || reason.trim().length < 8 || reason.trim().length > 500) {
        throw new DomainProblem(400, 'REASON_REQUIRED', 'A reason of 8 to 500 characters is required');
      }
    }
    if (policy.stepUp) {
      const state = request.actor ? await readPlatformAssurance(this.database, request.actor) : null;
      if (!state) {
        throw new DomainProblem(403, 'PLATFORM_SESSION_REQUIRED',
          'An MFA-verified platform administration session is required');
      }
      if (!state.stepUpFresh) throw stepUpProblem(state);
    }
  }

  private async enforceRuntimeControls(request: HidRequest): Promise<void> {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');

    const isPlatformAdmin = actor.platformPermissions?.includes('platform.admin.access') ?? false;
    if (isPlatformAdmin) return;

    const maintenance = await this.controlEnabled('maintenance_mode');
    if (maintenance) {
      throw new DomainProblem(503, 'PLATFORM_MAINTENANCE', 'HID is temporarily in maintenance mode');
    }

    const portalControl = actor.kind === 'patient'
      ? 'patient_portal_enabled'
      : 'provider_portal_enabled';
    if (!(await this.controlEnabled(portalControl))) {
      throw new DomainProblem(423, 'PLATFORM_PORTAL_DISABLED', 'This portal is temporarily disabled');
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

  private extractToken(request: HidRequest, platformScope: boolean): { token: string; transport: 'bearer' | 'cookie' } {
    const authorization = request.header('authorization');
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length).trim();
      if (token) return { token, transport: 'bearer' };
    }
    const cookies = (request as Request & { cookies?: unknown }).cookies;
    if (typeof cookies === 'object' && cookies !== null) {
      const token = (cookies as Record<string, unknown>)[this.cookieName(platformScope)];
      if (typeof token === 'string' && token) return { token, transport: 'cookie' };
    }
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
  }

  private assertCookieMutationSecurity(request: HidRequest, claims: Parameters<TokenService['verifyCsrf']>[0],
    platformScope: boolean): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    const cookies = (request as Request & { cookies?: unknown }).cookies;
    const cookieRecord = typeof cookies === 'object' && cookies !== null ? cookies as Record<string, unknown> : {};
    const csrfCookie = cookieRecord[`${this.cookieName(platformScope)}_csrf`];
    const csrfHeader = request.header('x-csrf-token');
    if (!this.tokens.verifyCsrf(
      claims,
      typeof csrfCookie === 'string' ? csrfCookie : undefined,
      csrfHeader,
    )) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed');
    }
  }

  private cookieName(platformScope: boolean): string {
    return platformScope ? `${this.environment.AUTH_COOKIE_NAME}_admin` : this.environment.AUTH_COOKIE_NAME;
  }

  private metadata<Value>(key: symbol, context: ExecutionContext): Value | undefined {
    return this.reflector.getAllAndOverride<Value>(key, [context.getHandler(), context.getClass()]);
  }

  private uuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private routeTemplate(request: HidRequest): string {
    return typeof request.route?.path === 'string' ? request.route.path : 'unresolved';
  }
}

function isDatabaseError(value: unknown): value is { code: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
