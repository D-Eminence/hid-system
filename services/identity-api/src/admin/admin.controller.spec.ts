jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import type { HidRequest } from '../common/request-context';
import { AdminController } from './admin.controller';
import type { AdminOperationsService } from './admin-operations.service';
import type { AdminService } from './admin.service';
import type { PricingService } from './pricing.service';
import { EmergencyContactOptOutCommandDto, FacilityAlertPhoneCommandDto } from './dto/admin-command.dto';

const facilityId = '10000000-0000-4000-8000-000000000002';
const request = {
  correlationId: 'admin-controller-test',
  actor: { id: 'staff:support', subject: 'staff:support', accountId: '20000000-0000-4000-8000-000000000001',
    roles: [], permissions: [], platformRoles: ['support_admin'],
    platformPermissions: ['platform.admin.access', 'platform.facility.manage', 'platform.emergency-contact.manage'],
    facilityIds: [], facilities: [], authenticationMethod: 'local' },
  header: () => undefined,
} as unknown as HidRequest;

function controller() {
  const admin = {
    setFacilityAlertPhone: jest.fn().mockResolvedValue({ facilityId, alertPhoneE164: null, version: 2, replayed: false }),
    optOutEmergencyContact: jest.fn().mockResolvedValue({ contacts: 1, patients: 1, replayed: false }),
  };
  return { admin, routes: new AdminController(admin as unknown as AdminService, {} as AdminOperationsService,
    {} as PricingService) };
}

// The global pipe as main.ts configures it.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true,
  transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false });
const body = (metatype: ArgumentMetadata['metatype'], value: unknown) =>
  pipe.transform(value, { type: 'body', metatype } as ArgumentMetadata);

describe('AdminController facility alert phone', () => {
  it('requires If-Match with the facility version and an Idempotency-Key', () => {
    const { admin, routes } = controller();
    const input = { phone: '08030000000', reason: 'Facility front desk line' };
    expect(() => routes.setFacilityAlertPhone(facilityId, undefined, 'admin-alert-phone-0001', input, request))
      .toThrow(expect.objectContaining({ status: 428, code: 'IF_MATCH_REQUIRED' }));
    expect(() => routes.setFacilityAlertPhone(facilityId, '"3"', undefined, input, request))
      .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(admin.setFacilityAlertPhone).not.toHaveBeenCalled();
    void routes.setFacilityAlertPhone(facilityId, 'W/"3"', 'admin-alert-phone-0001', input, request);
    expect(admin.setFacilityAlertPhone).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'admin-controller-test' }),
      facilityId, 3, input, 'admin-alert-phone-0001');
  });

  it('accepts a phone or null and refuses a missing phone, a short reason and unknown fields', async () => {
    await expect(body(FacilityAlertPhoneCommandDto, { phone: '+2348030000000', reason: 'Facility front desk line' }))
      .resolves.toMatchObject({ phone: '+2348030000000' });
    await expect(body(FacilityAlertPhoneCommandDto, { phone: null, reason: 'Facility line retired' }))
      .resolves.toMatchObject({ phone: null });
    for (const value of [{ reason: 'Facility front desk line' }, { phone: 8030000000, reason: 'Facility front desk line' },
      { phone: '08030000000', reason: 'short' }, { phone: '08030000000', reason: 'Facility front desk line', extra: 1 }]) {
      await expect(body(FacilityAlertPhoneCommandDto, value)).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('AdminController emergency-contact opt-out', () => {
  it('requires an Idempotency-Key and passes the validated command on', () => {
    const { admin, routes } = controller();
    const input = { channel: 'email' as const, destination: 'chidi@example.test', reason: 'Contact asked to stop alerts' };
    expect(() => routes.optOutEmergencyContact(undefined, input, request))
      .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    void routes.optOutEmergencyContact('admin-opt-out-key-0001', input, request);
    expect(admin.optOutEmergencyContact).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'admin-controller-test' }),
      input, 'admin-opt-out-key-0001');
  });

  it('answers 200, not 201', () => {
    expect(Reflect.getMetadata('__httpCode__', AdminController.prototype.optOutEmergencyContact)).toBe(200);
  });

  it('accepts email or SMS and refuses another channel, a short reason and unknown fields', async () => {
    await expect(body(EmergencyContactOptOutCommandDto, { channel: 'sms', destination: ' 0803 123 4567 ',
      reason: 'Contact asked to stop alerts' })).resolves.toMatchObject({ destination: '0803 123 4567' });
    for (const value of [{ channel: 'whatsapp', destination: 'chidi@example.test', reason: 'Contact asked to stop alerts' },
      { channel: 'email', destination: 'a@b', reason: 'Contact asked to stop alerts' },
      { channel: 'email', destination: 'chidi@example.test', reason: 'short' },
      { channel: 'email', destination: 'chidi@example.test', reason: 'Contact asked to stop alerts', patientId: 'x' }]) {
      await expect(body(EmergencyContactOptOutCommandDto, value)).rejects.toMatchObject({ status: 400 });
    }
  });
});
