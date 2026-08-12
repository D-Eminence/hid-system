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
