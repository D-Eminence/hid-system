import { SetMetadata } from '@nestjs/common';
import type { PlatformAction } from '../admin/high-risk-policy';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const PATIENT_ALLOWED = Symbol('PATIENT_ALLOWED');
export const PatientAllowed = (): MethodDecorator & ClassDecorator => SetMetadata(PATIENT_ALLOWED, true);
export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');
export const AUDIT_ACTION = Symbol('AUDIT_ACTION');
export const FACILITY_OPTIONAL = Symbol('FACILITY_OPTIONAL');
export const NO_AUDIT = Symbol('NO_AUDIT');
export const AUDIT_FAILURES_ONLY = Symbol('AUDIT_FAILURES_ONLY');
export const PLATFORM_SCOPE = Symbol('PLATFORM_SCOPE');

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const FacilityOptional = (): MethodDecorator & ClassDecorator => SetMetadata(FACILITY_OPTIONAL, true);
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
export const AuditAction = (action: string): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_ACTION, action);
export const NoAudit = (): MethodDecorator & ClassDecorator => SetMetadata(NO_AUDIT, true);
export const AuditFailuresOnly = (): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_FAILURES_ONLY, true);
export const AUDIT_SESSION_EVENT = Symbol('AUDIT_SESSION_EVENT');
/**
 * A session route (sign-out, facility selection, session reads) whose requests
 * the AuditInterceptor records as this `auth.*` session event, not as a generic
 * `api.*` HTTP request. No facility is bound to these routes, and a staff audit
 * row without a facility is accepted only as an `auth.*` session event
 * (AuditService.assertActorFacility and the 0067 CHECK constraints). Recorded
 * as `api.*`, a staff refusal failed its own audit, so the request answered 503
 * and the refusal went unrecorded.
 */
export const AuditSessionEvent = (action: `auth.${string}`): MethodDecorator => SetMetadata(AUDIT_SESSION_EVENT, action);
/**
 * Platform administration routes act on the whole platform, not on a facility.
 * The guard binds no facility context to them, accepts only platform
 * permissions, and their audit rows are platform-scoped (no facility).
 */
export const PlatformScope = (): MethodDecorator & ClassDecorator => SetMetadata(PLATFORM_SCOPE, true);
export const HIGH_RISK_ACTION = Symbol('HIGH_RISK_ACTION');
/**
 * Declares the platform action a route performs (admin/high-risk-policy.ts).
 * The guard refuses platform mutations without one and enforces its controls.
 */
export const HighRiskAction = (action: PlatformAction): MethodDecorator => SetMetadata(HIGH_RISK_ACTION, action);
export const DELEGATED_BROWSER_REQUEST = Symbol('DELEGATED_BROWSER_REQUEST');
/**
 * A route through which another HID service (EHR, OCR, Lab or Pharmacy) asks
 * Identity about the browser request it is serving, forwarding
 * the browser's cookie on its own POST. The guard trusts the browser method the
 * service reports in X-HID-Original-Method only after that workload has
 * authenticated, and then applies the browser-write Origin and CSRF check only
 * when the reported method is unsafe.
 */
export const DelegatedBrowserRequest = (): MethodDecorator => SetMetadata(DELEGATED_BROWSER_REQUEST, true);
