import { IdentityApiClient, IdentityApiProblem } from '@hid/api-client';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { IdentityService } from './identity.service';

const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const patientId = '123e4567-e89b-42d3-a456-426614174005';
const context: DataAccessContext = {
  correlationId: 'correlation-12345678', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174003',
  purposeOfUse: 'direct-care', userCookie: 'hid_access=opaque', csrfToken: 'csrf', origin: 'https://outreach.example.test',
  actor: { id: 'staff:test', subject: 'staff:test', accountId: '123e4567-e89b-42d3-a456-426614174002',
    authenticationMethod: 'local', roles: ['nurse'], permissions: [], facilityIds: [facilityId], facilities: [] },
};
const lookup = (breakGlass = false) => ({
  patient: { patientId, hid: 'HID-7KQ2M9XA', firstName: 'Ada', lastName: 'Fictional', fullName: 'Ada Fictional',
    dateOfBirth: null, gender: null, version: 1 },
  authorization: { decision: 'allow' as const, facilityId, membershipId: context.membershipId,
    scope: 'read_records' as const, purpose: 'direct-care' as const, breakGlass },
});
const problem = (status: number, code: string) => new IdentityApiProblem(status, { code, detail: `Identity ${code}` });

describe('IdentityService Health ID lookup', () => {
  let service: IdentityService;
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://outreach.example.test', OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'local-secret',
      OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'outreach-test-workload-token-0123456789abcdef' });
    resetEnvironmentForTests();
    service = new IdentityService({ headers: jest.fn().mockResolvedValue({}) } as never);
  });
  afterEach(() => jest.restoreAllMocks());

  it('asks Identity with the caller\'s own credentials and keeps only the last four Health ID characters', async () => {
    const spy = jest.spyOn(IdentityApiClient.prototype, 'lookupPatient').mockResolvedValueOnce(lookup());
    await expect(service.lookupByHealthId('HID-7KQ2M9XA', context)).resolves.toEqual({ patientId,
      fullName: 'Ada Fictional', dateOfBirth: null, healthIdLast4: 'M9XA' });
    expect(spy).toHaveBeenCalledWith('HID-7KQ2M9XA', 'direct-care', expect.objectContaining({
      cookie: 'hid_access=opaque', csrfToken: 'csrf', origin: 'https://outreach.example.test', facilityId }));
  });

  it.each([
    [problem(404, 'NOT_FOUND'), 404, 'OUTREACH_HEALTH_ID_NOT_FOUND'],
    [problem(403, 'ACCESS_DENIED'), 403, 'OUTREACH_PATIENT_ACCESS_REQUIRED'],
    [problem(403, 'PERMISSION_DENIED'), 403, 'PERMISSION_DENIED'],
    [problem(403, 'FACILITY_ACCESS_DENIED'), 403, 'FACILITY_ACCESS_DENIED'],
    [problem(403, 'CSRF_VALIDATION_FAILED'), 403, 'CSRF_VALIDATION_FAILED'],
    [problem(423, 'PLATFORM_PORTAL_DISABLED'), 423, 'PLATFORM_PORTAL_DISABLED'],
    [new Error('socket hang up'), 503, 'IDENTITY_SERVICE_UNAVAILABLE'],
  ])('maps Identity refusal %# to %s %s', async (error, status, code) => {
    jest.spyOn(IdentityApiClient.prototype, 'lookupPatient').mockRejectedValueOnce(error);
    await expect(service.lookupByHealthId('HID-7KQ2M9XA', context)).rejects.toMatchObject({ status, code });
  });

  it('refuses break-glass access as the link does', async () => {
    jest.spyOn(IdentityApiClient.prototype, 'lookupPatient').mockResolvedValueOnce(lookup(true));
    await expect(service.lookupByHealthId('HID-7KQ2M9XA', context))
      .rejects.toMatchObject({ status: 403, code: 'OUTREACH_PATIENT_ACCESS_REQUIRED' });
  });

  it.each([
    ['a different Health ID', { patient: { ...lookup().patient, hid: 'HID-7KQ2M9XB' } }],
    ['a different member', { authorization: { ...lookup().authorization, membershipId: patientId } }],
    ['a different facility', { authorization: { ...lookup().authorization, facilityId: patientId } }],
  ])('answers 502 when Identity answered for %s', async (_name, change) => {
    jest.spyOn(IdentityApiClient.prototype, 'lookupPatient').mockResolvedValueOnce({ ...lookup(), ...change });
    await expect(service.lookupByHealthId('HID-7KQ2M9XA', context))
      .rejects.toMatchObject({ status: 502, code: 'IDENTITY_BAD_RESPONSE' });
  });

  it('answers canLink from the link\'s own write_records check', async () => {
    const decision = { allowed: true, patientId, facilityId, membershipId: context.membershipId,
      scope: 'write_records' as const, purpose: 'direct-care' as const, breakGlass: false };
    const spy = jest.spyOn(IdentityApiClient.prototype, 'authorizePatient')
      .mockResolvedValueOnce(decision)
      .mockResolvedValueOnce({ ...decision, allowed: false })
      .mockRejectedValueOnce(problem(403, 'PERMISSION_DENIED'))
      .mockRejectedValueOnce(new Error('down'));
    await expect(service.canLinkPatient(patientId, context)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', expect.anything());
    await expect(service.canLinkPatient(patientId, context)).resolves.toBe(false);
    await expect(service.canLinkPatient(patientId, context)).resolves.toBe(false);
    await expect(service.canLinkPatient(patientId, context)).rejects.toMatchObject({ status: 503 });
  });
});
