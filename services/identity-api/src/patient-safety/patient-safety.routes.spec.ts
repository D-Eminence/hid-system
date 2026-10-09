import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ConsentController } from '../consent/consent.controller';
import { PATIENT_ALLOWED, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
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
