import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');
export const AUDIT_ACTION = Symbol('AUDIT_ACTION');
export const FACILITY_OPTIONAL = Symbol('FACILITY_OPTIONAL');
export const NO_AUDIT = Symbol('NO_AUDIT');
export const AUDIT_FAILURES_ONLY = Symbol('AUDIT_FAILURES_ONLY');

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const FacilityOptional = (): MethodDecorator & ClassDecorator => SetMetadata(FACILITY_OPTIONAL, true);
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
export const AuditAction = (action: string): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_ACTION, action);
export const NoAudit = (): MethodDecorator & ClassDecorator => SetMetadata(NO_AUDIT, true);
export const AuditFailuresOnly = (): MethodDecorator & ClassDecorator => SetMetadata(AUDIT_FAILURES_ONLY, true);
