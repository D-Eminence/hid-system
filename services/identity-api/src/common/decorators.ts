import { applyDecorators, SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const PATIENT_ALLOWED = Symbol('PATIENT_ALLOWED');
export const PatientAllowed = (): MethodDecorator & ClassDecorator => SetMetadata(PATIENT_ALLOWED, true);
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
export const AUDIT_SUCCESS_BEST_EFFORT = Symbol('AUDIT_SUCCESS_BEST_EFFORT');
/**
 * A route whose success has already been committed with its own audit row in
 * the same database transaction, and whose answer cannot be given again (0120's
 * create-unclaimed answers a one-time claim code). The interceptor still writes
 * its post-success audit row, but a failure of that write is logged (route and
 * correlation id only) and the answer is returned, instead of a 503 that would
 * lose it. Method-level only; never for a route whose audit is its only record.
 */
export const AuditSuccessBestEffort = (): MethodDecorator => SetMetadata(AUDIT_SUCCESS_BEST_EFFORT, true);
export const DELEGATED_BROWSER_REQUEST = Symbol('DELEGATED_BROWSER_REQUEST');
/**
 * A route through which another HID service (EHR, OCR, Lab, Pharmacy or
 * Outreach) asks Identity about the browser request it is serving, forwarding
 * the browser's cookie on its own POST. The guard trusts the browser method the
 * service reports in X-HID-Original-Method only after that workload has
 * authenticated, and then applies the browser-write Origin and CSRF check only
 * when the reported method is unsafe. When it skips the check it records the
 * reported method in request.delegatedBrowserMethod.
 */
export const DelegatedBrowserRequest = (): MethodDecorator => SetMetadata(DELEGATED_BROWSER_REQUEST, true);
export const PATIENT_ONLY = Symbol('PATIENT_ONLY');
/**
 * A route only a patient session may use: patient allowed, facility optional,
 * and any other session refused by SecurityGuard with 403
 * PATIENT_SESSION_REQUIRED before the handler runs. The guard audits that
 * refusal as an auth.authorization.denied event with no facility, which the
 * audit layer accepts. Refused in the handler instead, it was recorded as a
 * staff api.* request with no facility, which the audit layer refuses, and the
 * answer became 503 with nothing recorded (A9).
 */
export const PatientOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(PATIENT_ONLY, true), PatientAllowed(), FacilityOptional());
