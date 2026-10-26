import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FACILITY_OPTIONAL, PATIENT_ALLOWED, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { PatientStopOrderRouteDto, SendOrderRouteDto, WithdrawOrderRouteDto } from './dto/order-route.dto';
import { OrderRoutesController, PatientOrderRoutesController } from './order-routes.controller';

type Handler = (...args: unknown[]) => unknown;
const join = (...parts: string[]) => parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

function routes(controller: { prototype: object }) {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor').map((name) => {
    const handler = (controller.prototype as Record<string, Handler>)[name]!;
    return {
      name,
      path: join(base, Reflect.getMetadata(PATH_METADATA, handler) as string),
      method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
      code: Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined,
      permissions: (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[] | undefined) ?? [],
      patientAllowed: Reflect.getMetadata(PATIENT_ALLOWED, handler) ?? Reflect.getMetadata(PATIENT_ALLOWED, controller),
      facilityOptional: Reflect.getMetadata(FACILITY_OPTIONAL, handler) ?? Reflect.getMetadata(FACILITY_OPTIONAL, controller),
      isPublic: Reflect.getMetadata(PUBLIC_ROUTE, handler) ?? Reflect.getMetadata(PUBLIC_ROUTE, controller),
    };
  }).filter((route) => route.method !== undefined);
}

const LAB = 'ehr/patients/:patientId/encounters/:encounterId/lab-requests/:requestId/order-routes';
const RX = 'ehr/patients/:patientId/encounters/:encounterId/prescriptions/:prescriptionId/order-routes';

describe('Order-route controllers (SPEC-FINAL §10.1)', () => {
  it('serves exactly the staff routes of §10.1, each with its permissions, facility required, never to patients', () => {
    expect(routes(OrderRoutesController).map(({ name: _name, ...route }) => route)).toEqual(expect.arrayContaining([
      { path: LAB, method: RequestMethod.POST, code: 201, permissions: ['ehr.lab-request.write', 'ehr.order-route.send'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: LAB, method: RequestMethod.GET, code: undefined, permissions: ['ehr.lab-request.read'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: `${LAB}/:routeId/withdraw`, method: RequestMethod.POST, code: 200, permissions: ['ehr.order-route.send'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: RX, method: RequestMethod.POST, code: 201, permissions: ['ehr.prescription.write', 'ehr.order-route.send'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: RX, method: RequestMethod.GET, code: undefined, permissions: ['ehr.prescription.read'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: `${RX}/:routeId/withdraw`, method: RequestMethod.POST, code: 200, permissions: ['ehr.order-route.send'],
        patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      { path: 'ehr/order-route-attestation', method: RequestMethod.GET, code: undefined,
        permissions: ['ehr.order-route.send'], patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
      // Item 3 (C28): the Overview card of orders reported accepted for the wrong person.
      { path: 'ehr/order-routes/wrong-patient', method: RequestMethod.GET, code: undefined,
        permissions: ['ehr.order-route.send'], patientAllowed: undefined, facilityOptional: undefined, isPublic: undefined },
    ]));
    expect(routes(OrderRoutesController)).toHaveLength(8);
  });

  it('serves the patient only GET me/order-routes and POST me/order-routes/:routeId/withdraw (Stop), without a facility', () => {
    expect(routes(PatientOrderRoutesController).map(({ path, method, permissions, patientAllowed, facilityOptional }) =>
      ({ path, method, permissions, patientAllowed, facilityOptional }))).toEqual([
      { path: 'ehr/me/order-routes', method: RequestMethod.GET, permissions: [], patientAllowed: true, facilityOptional: true },
      { path: 'ehr/me/order-routes/:routeId/withdraw', method: RequestMethod.POST, permissions: [], patientAllowed: true,
        facilityOptional: true },
    ]);
  });

  const request = (permissions: string[], purpose = 'direct-care') => ({
    actor: { id: 'actor', subject: 'staff:test', accountId: 'account', roles: ['doctor'], permissions,
      facilityIds: ['facility'], facilities: [], facility: { membershipId: 'membership' }, authenticationMethod: 'local' },
    facilityId: 'facility', correlationId: 'correlation-123456', method: 'GET',
    header: (name: string) => (name === 'x-purpose-of-use' ? purpose : undefined),
  }) as unknown as HidRequest;

  it('needs the kind\'s write permission besides ehr.order-route.send to read the attestation text (C24)', async () => {
    const service = { attestation: jest.fn().mockResolvedValue({ kind: 'lab_request', version: 'v', text: 't' }) };
    const controller = new OrderRoutesController(service as never);
    expect(() => controller.attestation(request(['ehr.order-route.send', 'ehr.prescription.write']), 'lab_request'))
      .toThrow(expect.objectContaining({ status: 403, code: 'PERMISSION_DENIED' }));
    expect(() => controller.attestation(request(['ehr.order-route.send', 'ehr.lab-request.write']), 'prescription'))
      .toThrow(expect.objectContaining({ status: 403, code: 'PERMISSION_DENIED' }));
    for (const kind of ['lab', '', undefined, ['lab_request'], 'LAB_REQUEST']) {
      expect(() => controller.attestation(request(['ehr.order-route.send', 'ehr.lab-request.write']), kind))
        .toThrow(expect.objectContaining({ status: 400, code: 'ORDER_ROUTE_INVALID' }));
    }
    expect(service.attestation).not.toHaveBeenCalled();
    await controller.attestation(request(['ehr.order-route.send', 'ehr.lab-request.write']), 'lab_request');
    expect(service.attestation).toHaveBeenCalledWith(expect.objectContaining({ purposeOfUse: 'direct-care' }), 'lab_request');
  });

  it('requires an Idempotency-Key to send, before the service is called', () => {
    const service = { send: jest.fn() };
    const controller = new OrderRoutesController(service as never);
    expect(() => controller.sendLabRequest(request(['ehr.lab-request.write', 'ehr.order-route.send']), 'p', 'e', 'r',
      undefined, {} as SendOrderRouteDto)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => controller.sendPrescription(request(['ehr.prescription.write', 'ehr.order-route.send']), 'p', 'e', 'r',
      'short', {} as SendOrderRouteDto)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(service.send).not.toHaveBeenCalled();
  });

  it('passes the emergency purpose on to the service, which refuses it (the guard accepts any known purpose)', async () => {
    const service = { send: jest.fn().mockResolvedValue({}) };
    const controller = new OrderRoutesController(service as never);
    await controller.sendLabRequest(request(['ehr.lab-request.write', 'ehr.order-route.send'], 'emergency'), 'p', 'e', 'r',
      'order-route-key-0001', {} as SendOrderRouteDto);
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ purposeOfUse: 'emergency' }), 'lab_request',
      'p', 'e', 'r', {}, 'order-route-key-0001');
  });
});

describe('Order-route DTOs', () => {
  const errors = async (type: new () => object, input: unknown) =>
    (await validate(plainToInstance(type, input), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }))
      .map((error) => error.property).sort();
  const send = { expectedRowVersion: 1, receivingFacilityId: '123e4567-e89b-42d3-a456-426614174099', patientAgreed: true,
    attestationTextVersion: 'order-route-lab-attestation-v1' };

  it('send: the attestation must be ticked (patientAgreed exactly true) and name a stored text version', async () => {
    expect(await errors(SendOrderRouteDto, send)).toEqual([]);
    expect(await errors(SendOrderRouteDto, { ...send, attestationTextVersion: 'order-route-prescription-attestation-v12' }))
      .toEqual([]);
    for (const patientAgreed of [false, 'true', 1, null, undefined]) {
      expect(await errors(SendOrderRouteDto, { ...send, patientAgreed })).toEqual(['patientAgreed']);
    }
    for (const attestationTextVersion of ['order-route-lab-attestation-v', 'order-route-lab-agreement-v1',
      'order-route-lab-attestation-v1 ', 'ORDER-ROUTE-LAB-ATTESTATION-V1', 'order-route-x-attestation-v1', 1, undefined]) {
      expect(await errors(SendOrderRouteDto, { ...send, attestationTextVersion })).toEqual(['attestationTextVersion']);
    }
    expect(await errors(SendOrderRouteDto, { ...send, expectedRowVersion: 0 })).toEqual(['expectedRowVersion']);
    expect(await errors(SendOrderRouteDto, { ...send, expectedRowVersion: '1' })).toEqual(['expectedRowVersion']);
    expect(await errors(SendOrderRouteDto, { ...send, receivingFacilityId: 'not-a-uuid' })).toEqual(['receivingFacilityId']);
    // A v1 uuid is not a facility id (every id is v4).
    expect(await errors(SendOrderRouteDto, { ...send, receivingFacilityId: '123e4567-e89b-12d3-a456-426614174099' }))
      .toEqual(['receivingFacilityId']);
    expect(await errors(SendOrderRouteDto, { ...send, explainedToPatient: true })).toEqual(['explainedToPatient']);
    expect(await errors(SendOrderRouteDto, { ...send, patientId: send.receivingFacilityId })).toEqual(['patientId']);
  });

  it('withdraw: a version and one of the three reasons; Stop: a version only', async () => {
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 2, reason: 'sent_in_error' })).toEqual([]);
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 2, reason: 'patient_request' })).toEqual([]);
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 2, reason: 'other' })).toEqual([]);
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 2, reason: 'changed my mind' })).toEqual(['reason']);
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 0, reason: 'other' })).toEqual(['expectedVersion']);
    expect(await errors(WithdrawOrderRouteDto, { expectedVersion: 2, reason: 'other', note: 'x' })).toEqual(['note']);
    expect(await errors(PatientStopOrderRouteDto, { expectedVersion: 3 })).toEqual([]);
    expect(await errors(PatientStopOrderRouteDto, {})).toEqual(['expectedVersion']);
    expect(await errors(PatientStopOrderRouteDto, { expectedVersion: 3, reason: 'other' })).toEqual(['reason']);
  });
});
