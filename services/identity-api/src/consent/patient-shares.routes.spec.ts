jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS,
} from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { PatientSharesController } from './patient-shares.controller';
import type { PatientSharesService } from './patient-shares.service';
import { StaffSharesController } from './staff-shares.controller';

type Handler = (...args: never[]) => unknown;

function routes(controller: { prototype: object }) {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor').map((name) => {
    const handler = (controller.prototype as Record<string, Handler>)[name]!;
    const meta = (key: symbol) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
    return { name, method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      path: Reflect.getMetadata(PATH_METADATA, handler) as string, audit: Reflect.getMetadata(AUDIT_ACTION, handler) ?? null,
      patientOnly: meta(PATIENT_ONLY), patientAllowed: meta(PATIENT_ALLOWED), facilityOptional: meta(FACILITY_OPTIONAL),
      failuresOnly: meta(AUDIT_FAILURES_ONLY), isPublic: meta(PUBLIC_ROUTE), permissions: meta(REQUIRED_PERMISSIONS) };
  });
}

describe('Sharing routes (0095)', () => {
  it('serves the patient routes under identity/me, patient sessions only, failures audited', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PatientSharesController)).toBe('identity');
    const declared = routes(PatientSharesController);
    expect(declared.map((route) => [route.method, route.path, route.audit])).toEqual([
      [RequestMethod.POST, 'me/share-providers/search', 'identity.share-providers.search.command'],
      [RequestMethod.POST, 'me/shares', 'identity.consent-grant.patient-share.command'],
      [RequestMethod.GET, 'me/share-invitations', null],
      [RequestMethod.POST, 'me/share-invitations', 'identity.share-invitation.create.command'],
      [RequestMethod.POST, 'me/share-invitations/:invitationId/cancel', 'identity.share-invitation.cancel.command'],
      [RequestMethod.POST, 'me/share-invitations/:invitationId/confirm', 'identity.share-invitation.confirm.command'],
    ]);
    for (const route of declared) {
      expect(route).toMatchObject({ patientOnly: true, patientAllowed: true, facilityOptional: true, failuresOnly: true,
        isPublic: undefined, permissions: undefined });
    }
  });

  it('serves the staff routes with identity.consent.write and never to a patient session', () => {
    const declared = routes(StaffSharesController);
    expect(declared.map((route) => [route.method, route.path, route.permissions])).toEqual([
      [RequestMethod.GET, 'shared-with-me', ['identity.consent.write']],
      [RequestMethod.GET, 'share-invitations', ['identity.consent.write']],
      [RequestMethod.POST, 'share-invitations/:invitationId/accept', ['identity.consent.write']],
    ]);
    for (const route of declared) expect(route).toMatchObject({ patientOnly: undefined, patientAllowed: undefined, isPublic: undefined });
  });

  it('answers 201 for a new share or invitation and 200 for a replay; refuses a missing Idempotency-Key', async () => {
    const shares = { assertServed: jest.fn(), create: jest.fn(), invite: jest.fn(), confirm: jest.fn() };
    const controller = new PatientSharesController(shares as unknown as PatientSharesService);
    const response = { status: jest.fn() };
    const request = {} as HidRequest;
    for (const replayed of [false, true]) {
      shares.create.mockResolvedValue({ replayed });
      await controller.create(request, {} as never, 'share-key-0000000000000001', response as never);
      expect(response.status).toHaveBeenLastCalledWith(replayed ? 200 : 201);
      shares.invite.mockResolvedValue({ replayed });
      await controller.invite(request, {} as never, 'share-key-0000000000000001', response as never);
      expect(response.status).toHaveBeenLastCalledWith(replayed ? 200 : 201);
      shares.confirm.mockResolvedValue({ replayed });
      await controller.confirm(request, 'i', response as never);
      expect(response.status).toHaveBeenLastCalledWith(replayed ? 200 : 201);
    }
    await expect(controller.create(request, {} as never, undefined, response as never)).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(controller.invite(request, {} as never, 'short', response as never)).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });
});
