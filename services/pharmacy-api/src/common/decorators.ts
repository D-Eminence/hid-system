import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const REQUIRED_PERMISSIONS = Symbol('REQUIRED_PERMISSIONS');
export const FACILITY_OPTIONAL = Symbol('FACILITY_OPTIONAL');
export const INTERNAL_CALLER = Symbol('INTERNAL_CALLER');

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const FacilityOptional = (): MethodDecorator & ClassDecorator => SetMetadata(FACILITY_OPTIONAL, true);
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
export const InternalCaller = (caller: 'ehr-api' | 'ocr-api'): MethodDecorator =>
  SetMetadata(INTERNAL_CALLER, caller);

/**
 * A POST that only reads (ORD-3): its ids travel in the body, not the URL. The
 * guard does not ask Identity for the browser-write (Origin and CSRF) check of
 * a forwarded cookie, because the clinician's browser request was a read. Only
 * on internal-caller routes, which a browser cannot reach.
 */
export const READ_ONLY_POST = Symbol('READ_ONLY_POST');
export const ReadOnlyPost = (): MethodDecorator => SetMetadata(READ_ONLY_POST, true);
