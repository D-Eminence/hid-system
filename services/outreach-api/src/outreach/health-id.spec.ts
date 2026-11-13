import { IdentityApiClient, IdentityApiProblem, OutreachApiClient, OutreachApiProblem } from '@hid/api-client';
import type { ArgumentsHost } from '@nestjs/common';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { healthIdProblem, IdentityService } from '../identity/identity.service';
import type { WorkloadCredentialsService } from '../auth/workload-credentials.service';
import { resetEnvironmentForTests } from '../config/environment';
import { OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';

// Assisted Health ID (0119) in outreach-api: the two routes, the proxy to
// Identity and the registration's healthId. Synthetic people only.
const caseId = '123e4567-e89b-42d3-a456-426614174004';
const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const context = {
  correlationId: 'health-id-test', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174009',
  purposeOfUse: 'direct-care', userCookie: 'hid_access=a; hid_access_csrf=c', csrfToken: 'c',
  origin: 'https://outreach.healthidentitydirectory.com',
  actor: { id: 'staff:v', subject: 'staff:v', accountId: 'a', roles: [], permissions: ['outreach.registration.write'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} as unknown as DataAccessContext;
const row = { id: caseId, facility_id: facilityId, campaign_id: null, local_command_id: caseId,
  temporary_patient_id: 'tmp_1', status: 'identity_resolution_pending', full_name: 'Ada Person', sex: 'female',
  age_years: 30, phone: '08012345678', operational_notes: null, resolved_patient_id: null, resolution_kind: null,
  row_version: '1', created_at: new Date('2026-11-14T08:00:00Z'), updated_at: new Date('2026-11-14T08:00:00Z') };
const audit = { recordWithClient: jest.fn() };

function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  return promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => {
    if (error instanceof DomainProblem) return error;
    throw error;
  });
}

describe('Outreach assisted Health ID routes (0119)', () => {
  it('both routes need outreach.registration.write and an Idempotency-Key', async () => {
    for (const handler of [OutreachController.prototype.startHealthId, OutreachController.prototype.confirmHealthId]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['outreach.registration.write']);
    }
    const outreach = { startHealthId: jest.fn(), confirmHealthId: jest.fn() };
    const controller = new OutreachController(outreach as unknown as OutreachService);
    const request = { header: () => undefined } as unknown as HidRequest;
    expect(() => controller.startHealthId(caseId, { channel: 'email', email: 'a@b.co' }, request))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => controller.confirmHealthId(caseId, { code: '123456' }, request))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(outreach.startHealthId).not.toHaveBeenCalled();
  });

  describe('OutreachService', () => {
    const identity = { startHealthId: jest.fn(), confirmHealthId: jest.fn() };
    const query = jest.fn();
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (c: unknown) => unknown) =>
      operation({ query })) };
    const service = () => new OutreachService(database as never, audit as never, identity as never);
    beforeEach(() => { query.mockReset(); identity.startHealthId.mockReset(); identity.confirmHealthId.mockReset(); });

    it('answers SMS 503 with its words, and a missing or bad email 422, without calling Identity', async () => {
      expect(await problem(service().startHealthId(caseId, { channel: 'sms' }, 'k'.repeat(16), context)))
        .toMatchObject({ code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', message: "Codes by SMS aren't available yet. Use the person's email." });
      for (const email of [undefined, '', 'nope']) {
        expect((await problem(service().startHealthId(caseId, { channel: 'email', email }, 'k'.repeat(16), context))).code)
          .toBe('OUTREACH_HEALTH_ID_EMAIL_INVALID');
      }
      expect(identity.startHealthId).not.toHaveBeenCalled();
    });

    it('passes a start to Identity with the trimmed email and the key', async () => {
      const started = { channel: 'email', expiresAt: '2026-11-14T08:10:00.000Z', destinationHint: 'a***@example.test',
        resendAfterSeconds: 60 };
      identity.startHealthId.mockResolvedValue(started);
      await expect(service().startHealthId(caseId, { channel: 'email', email: ' ada@example.test ' }, 'key-1234567890abcd',
        context)).resolves.toEqual(started);
      expect(identity.startHealthId).toHaveBeenCalledWith(caseId, { channel: 'email', email: 'ada@example.test' },
        'key-1234567890abcd', context);
    });

    it('confirms and answers the Health ID with the registration as GET returns it', async () => {
      identity.confirmHealthId.mockResolvedValue({ healthId: 'HID-AB2CD3', outcome: 'created' });
      query.mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rows: [{ registration_case_id: caseId, hid_code: 'HID-AB2CD3', created_via: 'email' }] });
      await expect(service().confirmHealthId(caseId, { code: ' 123456 ' }, context)).resolves.toMatchObject({
        healthId: 'HID-AB2CD3', registration: { id: caseId, healthId: 'HID-AB2CD3', healthIdCreatedByOutreach: true,
          healthIdStatus: 'verified' } });
      expect(identity.confirmHealthId).toHaveBeenCalledWith(caseId, '123456', context);
      expect(query.mock.calls[1]).toEqual([expect.stringContaining('identity.outreach_registration_health_ids_for($1::uuid[])'),
        [[caseId]]]);
      expect((await problem(service().confirmHealthId(caseId, { code: '12345' }, context))).code)
        .toBe('OUTREACH_HEALTH_ID_CODE_INVALID');
    });

    it('lists registrations with their Health IDs in one call', async () => {
      const other = { ...row, id: '123e4567-e89b-42d3-a456-426614174099' };
      const third = { ...row, id: '123e4567-e89b-42d3-a456-426614174098' };
      query.mockResolvedValueOnce({ rows: [row, other, third] })
        .mockResolvedValueOnce({ rows: [{ registration_case_id: other.id, hid_code: 'HID-ZZ9YY8', created_via: 'email' },
          { registration_case_id: third.id, hid_code: 'HID-QQ7RR6', created_via: 'unclaimed' }] });
      await expect(service().list(context)).resolves.toMatchObject([
        { id: caseId, healthId: null, healthIdCreatedByOutreach: false, healthIdStatus: null },
        { id: other.id, healthId: 'HID-ZZ9YY8', healthIdCreatedByOutreach: true, healthIdStatus: 'verified' },
        { id: third.id, healthId: 'HID-QQ7RR6', healthIdCreatedByOutreach: true, healthIdStatus: 'unclaimed' }]);
      expect(query.mock.calls[1]).toEqual([expect.stringContaining('select registration_case_id,hid_code,created_via '),
        [[caseId, other.id, third.id]]]);
    });
  });

  describe('Identity problems, mapped back verbatim', () => {
    it('keeps status, code and detail, the Health ID and Retry-After', () => {
      const created = healthIdProblem(new IdentityApiProblem(409, { code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED',
        detail: 'A Health ID was already created for this person.', healthId: 'HID-ZZ9YY8' }), 'confirm');
      expect(created).toMatchObject({ code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED',
        message: 'A Health ID was already created for this person.', problemOptions: { extensions: { healthId: 'HID-ZZ9YY8' } } });
      expect(created.getStatus()).toBe(409);
      const limited = healthIdProblem(new IdentityApiProblem(429, { code: 'OUTREACH_HEALTH_ID_TOO_MANY_CODES',
        detail: 'Too many codes for this person today. Try again tomorrow.', retryAfterSeconds: 900 }), 'start');
      expect(limited.problemOptions.headers).toEqual({ 'Retry-After': '900' });
      for (const error of [new IdentityApiProblem(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE' }), new Error('timeout')]) {
        const unavailable = healthIdProblem(error, 'start');
        expect(unavailable).toMatchObject({ code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', problemOptions: { exposeDetail: true } });
        expect(unavailable.getStatus()).toBe(503);
      }
    });

    it('the problem body carries healthId, the header Retry-After, and a 503 its plain words', () => {
      const filter = new ProblemDetailsFilter();
      const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), json: jest.fn(),
        setHeader: jest.fn() };
      const host = { switchToHttp: () => ({ getRequest: () => ({ correlationId: 'c' }), getResponse: () => response }) };
      filter.catch(new DomainProblem(409, 'OUTREACH_HEALTH_ID_ALREADY_CREATED', 'Already.', undefined,
        { extensions: { healthId: 'HID-ZZ9YY8', code: 'X' } }), host as unknown as ArgumentsHost);
      expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({ code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED',
        detail: 'Already.', healthId: 'HID-ZZ9YY8' }));
      filter.catch(new DomainProblem(429, 'OUTREACH_HEALTH_ID_TOO_MANY_CODES', 'Too many.', undefined,
        { headers: { 'Retry-After': '900' } }), host as unknown as ArgumentsHost);
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '900');
      filter.catch(new DomainProblem(503, 'OUTREACH_HEALTH_ID_UNAVAILABLE', 'Use the email.', undefined,
        { exposeDetail: true }), host as unknown as ArgumentsHost);
      expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({ detail: 'Use the email.' }));
      filter.catch(new DomainProblem(503, 'X', 'secret'), host as unknown as ArgumentsHost);
      expect(response.json).toHaveBeenLastCalledWith(expect.objectContaining({
        detail: 'The service could not complete the request.' }));
    });
  });

  describe('IdentityService over the client', () => {
    const original = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      resetEnvironmentForTests();
      jest.restoreAllMocks();
    });

    it('forwards the volunteer\'s sign-in and the key to Identity once, never retrying a start', async () => {
      const start = jest.spyOn(IdentityApiClient.prototype, 'outreachHealthIdStart')
        .mockRejectedValue(new IdentityApiProblem(409, { code: 'OUTREACH_HEALTH_ID_PHONE_TAKEN',
          detail: 'This phone number already has a Health ID. Ask them to sign in with it.' }));
      Object.assign(process.env, { NODE_ENV: 'test', IDENTITY_API_URL: 'http://identity.test',
        DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: 'https://outreach.test',
        OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'outreach-local-test-secret-0123456789abcdef' });
      resetEnvironmentForTests();
      const service = new IdentityService({ headers: jest.fn().mockResolvedValue({}) } as unknown as WorkloadCredentialsService);
      const refusal = await problem(service.startHealthId(caseId, { channel: 'email', email: 'a@b.co' }, 'key-1234567890abcd',
        context));
      expect(refusal).toMatchObject({ code: 'OUTREACH_HEALTH_ID_PHONE_TAKEN',
        message: 'This phone number already has a Health ID. Ask them to sign in with it.' });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ caseId, channel: 'email', email: 'a@b.co' }, 'key-1234567890abcd',
        expect.objectContaining({ cookie: context.userCookie, csrfToken: 'c', origin: context.origin, facilityId,
          purposeOfUse: 'direct-care' }));
    });
  });

  describe('client transport (api-client)', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } });

    it('IdentityApiClient posts start with the key and the forwarded sign-in, once even on a 503', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE' }));
      global.fetch = fetchMock;
      const client = new IdentityApiClient({ baseUrl: 'https://identity.test', caller: 'outreach-api',
        workloadHeaders: async () => ({ 'x-hid-service-token': 't' }) });
      await expect(client.outreachHealthIdStart({ caseId, channel: 'email', email: 'a@b.co' }, 'key-1234567890abcd',
        { correlationId: 'c', facilityId, cookie: 'hid_access=a', csrfToken: 'c', origin: 'https://o.test' }))
        .rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://identity.test/api/v1/identity/outreach/health-id/start');
      expect(init.headers).toMatchObject({ 'idempotency-key': 'key-1234567890abcd', 'x-hid-internal-caller': 'outreach-api',
        'x-facility-id': facilityId, 'x-purpose-of-use': 'direct-care', cookie: 'hid_access=a', 'x-csrf-token': 'c',
        origin: 'https://o.test', 'x-hid-service-token': 't' });
      fetchMock.mockResolvedValue(json(201, { healthId: 'HID-AB2CD3', outcome: 'created' }));
      await expect(client.outreachHealthIdConfirm({ caseId, code: '123456' }, { correlationId: 'c', facilityId }))
        .resolves.toEqual({ healthId: 'HID-AB2CD3', outcome: 'created' });
    });

    it('OutreachApiClient: healthIdStart and healthIdConfirm, never retried, healthId on the problem', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', detail: 'x' }));
      global.fetch = fetchMock;
      const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
      const outreachContext = { correlationId: 'c', facilityId, purposeOfUse: 'direct-care' as const, csrfToken: 'c' };
      await expect(client.healthIdStart(caseId, { channel: 'email', email: 'a@b.co' }, outreachContext, 'key-1234567890abcd'))
        .rejects.toBeInstanceOf(OutreachApiProblem);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(`https://outreach.test/api/v1/outreach/registration-cases/${caseId}/health-id/start`);
      fetchMock.mockResolvedValue(json(409, { code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', detail: 'd', healthId: 'HID-ZZ9YY8' }));
      await expect(client.healthIdConfirm(caseId, { code: '123456' }, outreachContext, 'key-1234567890abce'))
        .rejects.toMatchObject({ status: 409, code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', healthId: 'HID-ZZ9YY8' });
      expect(fetchMock.mock.calls[1]![0]).toBe(`https://outreach.test/api/v1/outreach/registration-cases/${caseId}/health-id/confirm`);
    });
  });
});
