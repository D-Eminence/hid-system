jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ConsentController } from '../consent/consent.controller';
import {
  AUDIT_SESSION_EVENT, FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { EmergencyContactController } from './emergency-contact.controller';
import { PatientAccountDeletionController } from './patient-account-deletion.controller';

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
        sessionEvent: Reflect.getMetadata(AUDIT_SESSION_EVENT, handler) ?? Reflect.getMetadata(AUDIT_SESSION_EVENT, controller),
        isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) ?? Reflect.getMetadata(PUBLIC_ROUTE, controller),
        permissions: Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[] | undefined,
      };
    })
    .filter((route) => route.method !== undefined);
}

describe('Phase 3 patient route boundaries', () => {
  it.each([PatientAccountDeletionController, EmergencyContactController])(
    '%p is patient-only, authenticated, and uses only GET/POST', (controller) => {
      const declared = routes(controller);
      expect(declared.length).toBeGreaterThan(0);
      for (const route of declared) {
        expect(route.isPublic).toBeUndefined();
        expect(route.patientAllowed).toBe(true);
        expect([RequestMethod.GET, RequestMethod.POST]).toContain(route.method);
      }
    },
  );

  it('exposes patient grant revocation on a patient route and keeps the staff close route permissioned', () => {
    const consent = routes(ConsentController);
    const revoke = consent.find((route) => route.name === 'revokeMyConsentGrant');
    const staffClose = consent.find((route) => route.name === 'closeOwnGrant');
    expect(revoke).toMatchObject({ path: 'me/consent-grants/:grantId/revoke', patientAllowed: true, permissions: undefined });
    expect(staffClose).toMatchObject({ patientAllowed: undefined, permissions: ['identity.consent.write'] });
    expect(consent.find((route) => route.name === 'activateBreakGlass'))
      .toMatchObject({ patientAllowed: undefined, permissions: ['identity.consent.write', 'identity.break-glass.write'] });
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
  // routes (403 PATIENT_SESSION_REQUIRED), before staff MFA, Origin/CSRF,
  // facility binding and the handler, and records the refusal without a
  // facility. A staff session refused in the handler instead failed its own
  // audit and answered 503. A route that loses @PatientOnly() fails here.
  const PATIENT_ONLY_HANDLERS = [
    'PatientSelfController.profile', 'PatientSelfController.history', 'PatientSelfController.notificationInbox',
    'PatientSelfController.markNotificationRead', 'PatientSelfController.setAccessPin',
    'PatientSelfController.revokeAccessPin', 'PatientSelfController.authorize',
    'ConsentController.listMyAccessRequests', 'ConsentController.approveAccessRequest',
    'ConsentController.denyAccessRequest', 'ConsentController.revokeMyConsentGrant',
    'EmergencyContactController.list', 'EmergencyContactController.add', 'EmergencyContactController.update',
    'EmergencyContactController.deactivate', 'EmergencyContactController.sendVerification',
    'EmergencyContactController.confirmVerification',
    'PatientAccountDeletionController.status', 'PatientAccountDeletionController.requestDeletion',
    'PatientAccountDeletionController.confirm', 'PatientAccountDeletionController.cancel',
    'QoreIdVerificationController.verifyMyNin',
  ];
  const declared = identityControllers().flatMap((controller) => routes(controller)
    .map((route) => ({ ...route, handler: `${controller.name}.${route.name}` })));

  it('finds every controller', () => {
    expect(declared.map((route) => route.handler.split('.')[0])).toEqual(expect.arrayContaining(['AuthController',
      'PatientSelfController', 'ConsentController', 'EmergencyContactController', 'PatientAccountDeletionController',
      'QoreIdVerificationController', 'AdminController', 'HealthController']));
  });

  it('marks exactly the patient self-service routes patient-only, each also patient-allowed and facility-optional', () => {
    const patientOnly = declared.filter((route) => route.patientOnly === true);
    expect(patientOnly.map((route) => route.handler).sort()).toEqual([...PATIENT_ONLY_HANDLERS].sort());
    for (const route of patientOnly) {
      expect(route).toMatchObject({ patientAllowed: true, facilityOptional: true, isPublic: undefined, permissions: undefined });
    }
  });

  it('leaves no facility-optional route that is neither patient-only nor an audited session event', () => {
    // Any other facility-optional route admits a staff session with no facility
    // bound: its refusals fall back to the interceptor's facility-less auth row,
    // but a success is an `api.*` row of a staff actor without a facility, which
    // AuditService and the 0067 CHECKs refuse (503).
    expect(declared.filter((route) => route.facilityOptional === true && route.patientOnly !== true
      && route.sessionEvent === undefined).map((route) => route.handler)).toEqual([]);
  });
});
