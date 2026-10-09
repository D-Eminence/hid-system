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
