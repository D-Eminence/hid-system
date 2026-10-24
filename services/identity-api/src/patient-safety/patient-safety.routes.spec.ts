jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { EmergencyContactController } from './emergency-contact.controller';

type Handler = (...args: never[]) => unknown;

function routes(controller: { prototype: object }) {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (controller.prototype as Record<string, Handler>)[name]!;
      return {
        name, base,
        path: Reflect.getMetadata(PATH_METADATA, handler) as string | undefined,
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined,
        patientAllowed: Reflect.getMetadata(PATIENT_ALLOWED, handler) ?? Reflect.getMetadata(PATIENT_ALLOWED, controller),
        patientOnly: Reflect.getMetadata(PATIENT_ONLY, handler) ?? Reflect.getMetadata(PATIENT_ONLY, controller),
        facilityOptional: Reflect.getMetadata(FACILITY_OPTIONAL, handler) ?? Reflect.getMetadata(FACILITY_OPTIONAL, controller),
        failuresOnly: Reflect.getMetadata(AUDIT_FAILURES_ONLY, handler) ?? Reflect.getMetadata(AUDIT_FAILURES_ONLY, controller),
        isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) ?? Reflect.getMetadata(PUBLIC_ROUTE, controller),
        permissions: Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[] | undefined,
      };
    })
    .filter((route) => route.method !== undefined);
}

describe('Emergency-contact route boundaries', () => {
  it('is patient-only, authenticated, failure-audited, and uses only GET/POST', () => {
    const declared = routes(EmergencyContactController);
    expect(declared.map((route) => [route.method, route.path, route.name])).toEqual([
      [RequestMethod.GET, '/', 'list'],
      [RequestMethod.GET, 'availability', 'availability'],
      [RequestMethod.POST, '/', 'add'],
      [RequestMethod.POST, ':contactId', 'update'],
      [RequestMethod.POST, ':contactId/deactivate', 'deactivate'],
      [RequestMethod.POST, ':contactId/verification', 'sendVerification'],
      [RequestMethod.POST, ':contactId/verification/confirm', 'confirmVerification'],
    ]);
    for (const route of declared) {
      expect(route).toMatchObject({ base: 'identity/me/emergency-contacts', isPublic: undefined, patientOnly: true,
        patientAllowed: true, facilityOptional: true, failuresOnly: true, permissions: undefined });
    }
  });
});

/** Every Identity controller class, loaded from every `.controller.ts` file under src. */
function identityControllers(): Array<{ name: string; prototype: object }> {
  const root = join(__dirname, '..');
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => file.endsWith('.controller.ts'));
  return files.flatMap((file) => Object.values(require(join(root, file)) as Record<string, unknown>))
    .filter((value): value is { name: string; prototype: object } => typeof value === 'function'
      && Reflect.getMetadata(PATH_METADATA, value) !== undefined);
}

describe('Patient-only routes (A9)', () => {
  // SecurityGuard refuses any session other than the patient's own on these
  // routes (403 PATIENT_SESSION_REQUIRED) before the handler, and records the
  // refusal without a facility. On Novu only the emergency-contact routes are
  // patient-only so far (main's W11 extends it to the other me/* routes). A
  // route that loses @PatientOnly() fails here.
  const PATIENT_ONLY_HANDLERS = [
    'EmergencyContactController.list', 'EmergencyContactController.availability', 'EmergencyContactController.add',
    'EmergencyContactController.update', 'EmergencyContactController.deactivate',
    'EmergencyContactController.sendVerification', 'EmergencyContactController.confirmVerification',
  ];
  const declared = identityControllers().flatMap((controller) => routes(controller)
    .map((route) => ({ ...route, handler: `${controller.name}.${route.name}` })));

  it('finds every controller', () => {
    expect(declared.map((route) => route.handler.split('.')[0])).toEqual(expect.arrayContaining(['AuthController',
      'PatientSelfController', 'ConsentController', 'EmergencyContactController', 'AdminController', 'HealthController']));
  });

  it('marks exactly the emergency-contact routes patient-only, each also patient-allowed and facility-optional', () => {
    const patientOnly = declared.filter((route) => route.patientOnly === true);
    expect(patientOnly.map((route) => route.handler).sort()).toEqual([...PATIENT_ONLY_HANDLERS].sort());
    for (const route of patientOnly) {
      expect(route).toMatchObject({ patientAllowed: true, facilityOptional: true, isPublic: undefined, permissions: undefined });
    }
  });

  it('serves support opt-out and the facility alert phone only to platform permissions', () => {
    const admin = declared.filter((route) => route.handler.startsWith('AdminController.'));
    expect(admin.find((route) => route.name === 'optOutEmergencyContact')).toMatchObject({
      path: 'emergency-contacts/opt-out', method: RequestMethod.POST, patientAllowed: undefined, patientOnly: undefined,
      permissions: ['platform.emergency-contact.manage'],
    });
    expect(admin.find((route) => route.name === 'setFacilityAlertPhone')).toMatchObject({
      path: 'facilities/:facilityId/alert-phone', method: RequestMethod.POST, patientAllowed: undefined,
      permissions: ['platform.facility.manage'],
    });
  });
});
