jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AdminClinicianApplicationsController } from '../admin/clinician-application-admin.controller';
import { AttestClinicianApplicationDto } from '../admin/dto/clinician-application-command.dto';
import { AuditInterceptor } from '../audit/audit.interceptor';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem, RetryAfterProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { globalValidationPipe } from '../common/validation-problem';
import { platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { ClinicianApplicationController } from './clinician-application.controller';
import { ClinicianApplicationDetailsDto, SubmitClinicianApplicationDto } from './dto/clinician-application.dto';

/**
 * Clinician self sign-up (ADR-064) held to the launch alignment rules of
 * D-Eminence/hid-system#80 once both are merged: A23 (a refused nested field
 * is named by its dotted path, with the validator's message and never the
 * submitted value) on the three nested bodies, P4, P14 and step 1, and A17
 * (every refusal's audit row records the answered status and code, never the
 * message) on the public and the administration routes. A21 is pinned in the
 * service and admin specs.
 */
useTestEnvironment();

const submission = {
  email: 'synthetic.clinician@example.invalid', fullName: 'Ada Synthetic', password: 'a-long-synthetic-password',
  profession: 'doctor', regulator: 'MDCN', licenceNumber: 'MDCN/12345', licenceValidUntil: '2027-06-30',
  facilityId: '0d9f8e7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f', declarations: { accurate: true, verificationConsent: true },
};
const checklist = { registerChecked: true, licenceCurrentUntilRecorded: true, identityMethod: 'video_call_photo_id',
  identityConfirmed: true, employmentChannel: 'facility_public_phone', employmentConfirmed: true };
const attestation = { validUntil: '2027-06-30T22:59:59Z', evidenceReference: 'Review ticket CLIN-0001', checklist,
  authenticatorCode: '123456', reason: 'Licence and identity verified' };

async function refused(body: unknown, metatype: new () => object): Promise<DomainProblem> {
  const error = await globalValidationPipe().transform(body, { type: 'body', metatype })
    .then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  return error as DomainProblem;
}
const fields = (problem: DomainProblem) => (problem.errors ?? []).map(({ field }) => field).sort();

describe('nested clinician bodies name a refused field by its dotted path (A23)', () => {
  it('names P4\'s declarations by path, with messages, and echoes no submitted value', async () => {
    const problem = await refused({ ...submission, declarations: { accurate: false, verificationConsent: true,
      extra: 'unexpected' } }, SubmitClinicianApplicationDto);
    expect(fields(problem)).toEqual(['declarations.accurate', 'declarations.extra']);
    expect((problem.errors ?? []).every(({ messages }) => messages.length > 0)).toBe(true);
    const answer = JSON.stringify(problem.errors);
    for (const value of [submission.password, submission.email, submission.fullName, submission.licenceNumber,
      'unexpected']) expect(answer).not.toContain(value);
  });

  it('keeps a missing or non-object declarations as the parent\'s own refusal', async () => {
    const { declarations: _declarations, ...withoutDeclarations } = submission;
    expect(fields(await refused(withoutDeclarations, SubmitClinicianApplicationDto))).toEqual(['declarations']);
    const listed = await refused({ ...submission, declarations: [true, true] }, SubmitClinicianApplicationDto);
    expect(fields(listed)[0]).toBe('declarations');
    expect(listed.errors?.[0]?.messages.length).toBeGreaterThan(0);
  });

  it('names P14\'s declarations by path', async () => {
    const { email: _email, fullName: _fullName, password: _password, ...details } = submission;
    const problem = await refused({ ...details, declarations: { verificationConsent: 'yes' } },
      ClinicianApplicationDetailsDto);
    expect(fields(problem)).toEqual(['declarations.accurate', 'declarations.verificationConsent']);
  });

  it('names step 1\'s checklist by path and echoes neither the evidence, the code nor the reason', async () => {
    const problem = await refused({ ...attestation, checklist: { ...checklist, identityMethod: 'telephone',
      employmentConfirmed: false, extra: true } }, AttestClinicianApplicationDto);
    expect(fields(problem)).toEqual(['checklist.employmentConfirmed', 'checklist.extra', 'checklist.identityMethod']);
    const answer = JSON.stringify(problem.errors);
    for (const value of ['Review ticket CLIN-0001', '123456', 'Licence and identity verified', 'telephone']) {
      expect(answer).not.toContain(value);
    }
  });
});

interface Recorded { action: string; outcome: string; details: Record<string, unknown>; [key: string]: unknown }

function intercept(controller: object, handler: string, actor: ActorContext | undefined, call: CallHandler,
  route: string) {
  const request = { method: 'POST', correlationId: 'clinician-alignment-0001', ip: '203.0.113.9',
    route: { path: route }, query: {}, params: {}, actor, accessScope: actor ? 'platform' : undefined,
    header: () => undefined } as unknown as HidRequest;
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor(new Reflector(), audit as unknown as AuditService);
  const context = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 201 }) }),
    getHandler: () => (controller as unknown as { prototype: Record<string, unknown> }).prototype[handler],
    getClass: () => controller } as unknown as ExecutionContext;
  return { audit, result: lastValueFrom(interceptor.intercept(context, call)) };
}
const failing = (error: unknown): CallHandler => ({ handle: () => throwError(() => error) });

describe('clinician refusals record the answered status and code (A17)', () => {
  const route = '/api/v1/identity/clinician-applications';

  it.each([
    ['submit', new RetryAfterProblem(429, 'CLINICIAN_APPLICATION_RATE_LIMITED', 'Too many requests; try again later',
      86_400), 429, 'CLINICIAN_APPLICATION_RATE_LIMITED'],
    ['submit', new DomainProblem(409, 'CLINICIAN_EMAIL_IN_USE', 'synthetic.clinician@example.invalid is in use'), 409,
      'CLINICIAN_EMAIL_IN_USE'],
    ['emailCode', new DomainProblem(503, 'CLINICIAN_SIGNUP_CLOSED', 'Clinician sign-up is not open yet.'), 503,
      'CLINICIAN_SIGNUP_CLOSED'],
    ['verifyStatusCode', new DomainProblem(401, 'CLINICIAN_APPLICATION_CODE_INVALID', 'The code is wrong or has expired.'),
      401, 'CLINICIAN_APPLICATION_CODE_INVALID'],
    ['searchFacilities', new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.'), 400,
      'VALIDATION_FAILED'],
  ])('%s: a %s refusal is one failure row with status and code only', async (handler, error, status, code) => {
    const { audit, result } = intercept(ClinicianApplicationController, handler, undefined, failing(error), route);
    await expect(result).rejects.toBe(error);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const row = audit.record.mock.calls[0]![0] as Recorded;
    expect(row).toMatchObject({ outcome: 'failure', resourceType: 'http-request' });
    expect(row.action).toMatch(/^api\.identity\.clinician-application\./);
    expect(row.details).toEqual({ method: 'POST', route, status, code, durationMs: expect.any(Number) });
    expect(JSON.stringify(row)).not.toContain((error as DomainProblem).message);
  });

  it('records no success row on the public routes, and nothing for availability', async () => {
    const success = intercept(ClinicianApplicationController, 'submit', undefined, { handle: () => of({ ok: true }) },
      route);
    await expect(success.result).resolves.toEqual({ ok: true });
    expect(success.audit.record).not.toHaveBeenCalled();
    const availability = intercept(ClinicianApplicationController, 'availability', undefined,
      failing(new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable')),
      `${route}/availability`);
    await expect(availability.result).rejects.toBeInstanceOf(DomainProblem);
    expect(availability.audit.record).not.toHaveBeenCalled();
  });

  it('records a refused step 1 as its platform request row with the status and code', async () => {
    const error = new DomainProblem(403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CODE_INVALID',
      'The applicant\'s authenticator code was not accepted');
    const { audit, result } = intercept(AdminClinicianApplicationsController, 'attest',
      platformActor({ platformPermissions: ['platform.admin.access', 'platform.workforce.manage'] }), failing(error),
      '/api/v1/admin/clinician-applications/:applicationId/attest');
    await expect(result).rejects.toBe(error);
    const row = audit.record.mock.calls[0]![0] as Recorded;
    expect(row).toMatchObject({ action: 'api.admin.clinician-application.attest.request', outcome: 'failure',
      accessScope: 'platform' });
    expect(row.details).toMatchObject({ status: 403, code: 'CLINICIAN_APPLICATION_AUTHENTICATOR_CODE_INVALID' });
    expect(JSON.stringify(row)).not.toContain('was not accepted');
  });
});
