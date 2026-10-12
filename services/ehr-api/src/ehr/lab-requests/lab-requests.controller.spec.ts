import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { LabRequestsController } from './lab-requests.controller';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const requestId = '123e4567-e89b-42d3-a456-426614174005';

// The explicit send (or re-send) of an active lab request to Lab, mirroring
// POST .../prescriptions/:prescriptionId/pharmacy-work-item.
const route = (): ((...args: unknown[]) => unknown) => {
  const handler = (LabRequestsController.prototype as unknown as Record<string, unknown>).sendToLab;
  if (typeof handler !== 'function') throw new Error('LabRequestsController has no sendToLab route');
  return handler as (...args: unknown[]) => unknown;
};

describe('LabRequestsController send to Lab', () => {
  it('is POST :requestId/lab-work-item, answering 201, for actors who may write lab requests and accept Lab work', () => {
    const handler = route();
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':requestId/lab-work-item');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(201);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.lab-request.write', 'lab.work-item.accept']);
  });

  it('requires an Idempotency-Key and passes the expected version to the service', async () => {
    const labRequests = { sendToLab: jest.fn().mockResolvedValue({ id: 'work-item' }) };
    const controller = new LabRequestsController(labRequests as never);
    const request = { actor: { id: 'actor', subject: 'staff:test', accountId: 'account', roles: [], permissions: [],
      facilityIds: [facilityId], facilities: [], facility: { membershipId: 'membership' }, authenticationMethod: 'local' },
    facilityId, correlationId: 'correlation-123456', method: 'POST',
    header: (name: string) => (name === 'x-purpose-of-use' ? 'direct-care' : undefined) } as unknown as HidRequest;
    const send = (key: string | undefined) => route().call(controller, request, patientId, encounterId, requestId, key,
      { expectedRowVersion: 2 });
    expect(() => send(undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(labRequests.sendToLab).not.toHaveBeenCalled();
    await expect(send('lab-handoff-key-0001')).resolves.toEqual({ id: 'work-item' });
    expect(labRequests.sendToLab).toHaveBeenCalledWith(expect.objectContaining({ facilityId, purposeOfUse: 'direct-care' }),
      patientId, encounterId, requestId, { expectedRowVersion: 2 });
  });

  it('accepts only a positive integer expectedRowVersion in its body', async () => {
    const [body] = (Reflect.getMetadata('design:paramtypes', LabRequestsController.prototype, 'sendToLab') ?? [])
      .slice(-1) as [new () => object];
    expect(body?.name).toBe('SendLabRequestToLabDto');
    const errors = async (input: unknown) => (await validate(plainToInstance(body, input), { whitelist: true,
      forbidNonWhitelisted: true })).map((error) => error.property);
    expect(await errors({ expectedRowVersion: 2 })).toEqual([]);
    expect(await errors({ expectedRowVersion: 0 })).toEqual(['expectedRowVersion']);
    expect(await errors({ expectedRowVersion: '2' })).toEqual(['expectedRowVersion']);
    expect(await errors({})).toEqual(['expectedRowVersion']);
    expect(await errors({ expectedRowVersion: 2, reason: 'not part of this command' })).toEqual(['reason']);
  });
});
