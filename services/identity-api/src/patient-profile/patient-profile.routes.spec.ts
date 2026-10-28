jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod, StreamableFile } from '@nestjs/common';
import {
  AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { PatientProfileController } from './patient-profile.controller';
import type { PatientContactChangeService } from './patient-contact-change.service';
import type { PatientProfileService } from './patient-profile.service';

type Handler = (...args: never[]) => unknown;

describe('Patient profile routes (0094)', () => {
  const names = Object.getOwnPropertyNames(PatientProfileController.prototype).filter((name) => name !== 'constructor');
  const routes = names.map((name) => {
    const handler = (PatientProfileController.prototype as unknown as Record<string, Handler>)[name]!;
    const meta = (key: symbol) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, PatientProfileController);
    return { name, method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      path: Reflect.getMetadata(PATH_METADATA, handler) as string, audit: Reflect.getMetadata(AUDIT_ACTION, handler),
      patientOnly: meta(PATIENT_ONLY), patientAllowed: meta(PATIENT_ALLOWED), facilityOptional: meta(FACILITY_OPTIONAL),
      failuresOnly: meta(AUDIT_FAILURES_ONLY), isPublic: meta(PUBLIC_ROUTE), permissions: meta(REQUIRED_PERMISSIONS) };
  });

  it('serves exactly the contract\'s paths under identity, patient sessions only, failures audited', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PatientProfileController)).toBe('identity');
    expect(routes.map((route) => [route.method, route.path, route.audit ?? null])).toEqual([
      [RequestMethod.GET, 'me/profile-details', null],
      [RequestMethod.PUT, 'me/profile-details', 'identity.patient.profile-details.update.command'],
      [RequestMethod.GET, 'me/photo', null],
      [RequestMethod.PUT, 'me/photo', 'identity.patient.photo.set.command'],
      [RequestMethod.DELETE, 'me/photo', 'identity.patient.photo.remove.command'],
      [RequestMethod.POST, 'me/contact-changes', 'identity.patient.contact-change.start.command'],
      [RequestMethod.POST, 'me/contact-changes/:changeId/verify', 'identity.patient.contact-change.verify.command'],
    ]);
    for (const route of routes) {
      expect(route).toMatchObject({ patientOnly: true, patientAllowed: true, facilityOptional: true, failuresOnly: true,
        isPublic: undefined, permissions: undefined });
    }
  });

  it('answers the photo as its bytes with their own type, inline', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const profile = { photo: jest.fn().mockResolvedValue({ mediaType: 'image/jpeg', bytes }) };
    const controller = new PatientProfileController(profile as unknown as PatientProfileService,
      {} as PatientContactChangeService);
    const file = await controller.photo({} as HidRequest);
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getHeaders()).toEqual({ type: 'image/jpeg', disposition: 'inline', length: 4 });
  });
});
