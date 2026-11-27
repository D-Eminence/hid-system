import { Body, Controller, type INestApplication, Module, Post, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsDateString, IsEnum, IsString, Length, MaxLength } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import { IsOptionalButNotNull } from '../../common/validation';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import { WorkItemProgressService } from '../../integrations/work-item-progress.service';
import { CatalogModule } from '../catalog/catalog.module';
import { CatalogService } from '../catalog/catalog.service';
import { CreateConsultationDto, CreateConsultationNameOnlyDto } from '../consultation/consultation.dto';
import { ConsultationsController, CreateConsultationBodyPipe } from '../consultation/consultations.controller';
import { ConsultationsService } from '../consultation/consultations.service';
import { DiagnosesController } from '../diagnoses/diagnoses.controller';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { LabRequestsController } from '../lab-requests/lab-requests.controller';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import {
  CreateDiagnosisDto, CreateDiagnosisNameOnlyDto, CreateLabRequestDto, CreateLabRequestNameOnlyDto,
  DiagnosisClinicalStatus, DiagnosisVerificationStatus, LabPriority, OrderStatus,
} from './clinical.dto';
import { ClinicalInfrastructureModule } from './clinical-infrastructure.module';
import {
  CreateDiagnosisBodyPipe, CreateLabRequestBodyPipe, NAME_ONLY_CODES_OFF, NAME_ONLY_CODES_PROVIDER, NameOnlyCodes,
} from './name-only-codes';

/*
 * Lab tests and diagnoses by name only (0156; Ola's design note on
 * hid-system#258, 7192389223): behind LAB_REQUEST_NAME_ONLY_ENABLED and
 * DIAGNOSIS_NAME_ONLY_ENABLED, both off by default. Off, the create bodies are
 * checked exactly as before. On, the code pair may be left out, both or
 * neither (400 LAB_TEST_CODE_INCOMPLETE or DIAGNOSIS_CODE_INCOMPLETE), and a
 * coded body keeps its Idempotency-Key digest. Fictional data only.
 */

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/** CreateLabRequestDto as at staging 0cfddcc9, written out, to compare answers with. */
class TodaysCreateLabRequestDto {
  @Transform(trim) @IsString() @Length(1, 255) testCodeSystem!: string;
  @Transform(trim) @IsString() @Length(1, 100) testCode!: string;
  @Transform(trim) @IsString() @Length(1, 500) testDisplay!: string;
  @IsOptionalButNotNull() @IsEnum(LabPriority) priority: LabPriority = LabPriority.Routine;
  @IsEnum(OrderStatus) status!: OrderStatus;
  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(100) specimenTypeCode?: string;
  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(4000) clinicalInformation?: string;
  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(255) externalOrderReference?: string;
}

/** CreateDiagnosisDto as at staging 0cfddcc9, written out, to compare answers with. */
class TodaysCreateDiagnosisDto {
  @Transform(trim) @IsString() @Length(1, 255) codeSystem!: string;
  @Transform(trim) @IsString() @Length(1, 100) code!: string;
  @Transform(trim) @IsString() @Length(1, 500) display!: string;
  @IsEnum(DiagnosisClinicalStatus) clinicalStatus!: DiagnosisClinicalStatus;
  @IsEnum(DiagnosisVerificationStatus) verificationStatus!: DiagnosisVerificationStatus;
  @IsOptionalButNotNull() @IsDateString({ strict: true }) onsetAt?: string;
  @IsOptionalButNotNull() @IsDateString({ strict: true }) abatementAt?: string;
  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(4000) notes?: string;
}

/** The validation main.ts installs, as before this release, written out. */
const todaysValidation = () => new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
  transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
  exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) });
const today = (metatype: new () => object, value: unknown) =>
  todaysValidation().transform(value, { type: 'body', metatype, data: undefined });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const problem = error as DomainProblem;
    return { status: problem.getStatus(), code: problem.code, detail: problem.message, errors: problem.errors };
  }
  throw new Error('expected a refusal');
};

const labBody = { testDisplay: 'Sickling test', priority: 'urgent', status: 'active', specimenTypeCode: 'blood',
  clinicalInformation: 'Bone pain (test)' };
const labCodes = { testCodeSystem: 'LOCAL', testCode: 'SICKLE' };
const diagnosisBody = { display: 'Sickle cell crisis (as written, test)', clinicalStatus: 'active',
  verificationStatus: 'provisional', onsetAt: '2026-11-30T08:00:00.000Z' };
const diagnosisCodes = { codeSystem: 'ICD-10', code: 'D57.0' };

const labPipe = (enabled: boolean) => new CreateLabRequestBodyPipe(new NameOnlyCodes(enabled, false));
const diagnosisPipe = (enabled: boolean) => new CreateDiagnosisBodyPipe(new NameOnlyCodes(false, enabled));
const consultationPipe = (enabled: boolean) => new CreateConsultationBodyPipe(new NameOnlyCodes(false, enabled));

describe('the two settings', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:3000',
    STORAGE_MODE: 'disabled' };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('are off unless set to true, each on its own', () => {
    Object.assign(process.env, base);
    delete process.env.LAB_REQUEST_NAME_ONLY_ENABLED;
    delete process.env.DIAGNOSIS_NAME_ONLY_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment()).toMatchObject({ LAB_REQUEST_NAME_ONLY_ENABLED: false, DIAGNOSIS_NAME_ONLY_ENABLED: false });
    expect(NameOnlyCodes.fromEnvironment()).toEqual(new NameOnlyCodes(false, false));
    process.env.LAB_REQUEST_NAME_ONLY_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(NameOnlyCodes.fromEnvironment()).toEqual(new NameOnlyCodes(true, false));
    process.env.LAB_REQUEST_NAME_ONLY_ENABLED = 'false';
    process.env.DIAGNOSIS_NAME_ONLY_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(NameOnlyCodes.fromEnvironment()).toEqual(new NameOnlyCodes(false, true));
    expect(NAME_ONLY_CODES_PROVIDER.useFactory()).toEqual(new NameOnlyCodes(false, true));
  });

  it.each(['LAB_REQUEST_NAME_ONLY_ENABLED', 'DIAGNOSIS_NAME_ONLY_ENABLED'])('%s refuses any value but true or false', (name) => {
    Object.assign(process.env, base, { [name]: 'yes' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(new RegExp(name));
  });

  it('are provided where they are read: the clinical routes\' module and the catalogue', () => {
    expect(Reflect.getMetadata('providers', ClinicalInfrastructureModule)).toContain(NAME_ONLY_CODES_PROVIDER);
    expect(Reflect.getMetadata('exports', ClinicalInfrastructureModule)).toContain(NameOnlyCodes);
    expect(Reflect.getMetadata('providers', CatalogModule)).toContain(NAME_ONLY_CODES_PROVIDER);
    expect((Reflect.getMetadata('design:paramtypes', DiagnosesService) as unknown[])[1]).toBe(NameOnlyCodes);
    expect((Reflect.getMetadata('design:paramtypes', CatalogService) as unknown[])[1]).toBe(NameOnlyCodes);
    expect(NAME_ONLY_CODES_OFF).toEqual(new NameOnlyCodes(false, false));
  });

  it('leave each create body to its route pipe: the declared body type is not a class the global pipe checks', () => {
    for (const controller of [LabRequestsController, DiagnosesController, ConsultationsController]) {
      const types = Reflect.getMetadata('design:paramtypes', controller.prototype, 'create') as unknown[];
      expect(types.at(-1)).toBe(Object);
    }
  });
});

describe('lab requests: LAB_REQUEST_NAME_ONLY_ENABLED off (the default)', () => {
  it.each([
    ['no code', labBody], ['a code system only', { ...labBody, testCodeSystem: 'LOCAL' }],
    ['a code only', { ...labBody, testCode: 'SICKLE' }], ['null codes', { ...labBody, testCodeSystem: null, testCode: null }],
    ['empty codes', { ...labBody, testCodeSystem: '', testCode: ' ' }],
    ['no code and another error', { ...labBody, testDisplay: '', status: 'sent' }],
  ])('refuses %s exactly as today\'s validation does', async (_label, input) => {
    const answer = await refusal(labPipe(false).transform(input));
    expect(answer).toEqual(await refusal(today(TodaysCreateLabRequestDto, input)));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('accepts a coded request as today\'s class, with today\'s digest', async () => {
    const input = await labPipe(false).transform({ ...labBody, ...labCodes, testDisplay: '  Sickling test ' });
    expect(input).toBeInstanceOf(CreateLabRequestDto);
    expect({ ...input }).toEqual({ ...await today(TodaysCreateLabRequestDto, { ...labBody, ...labCodes }) });
    expect(requestDigest('lab-request.create', { input }))
      .toBe(requestDigest('lab-request.create', { input: await today(TodaysCreateLabRequestDto, { ...labBody, ...labCodes }) }));
  });
});

describe('lab requests: LAB_REQUEST_NAME_ONLY_ENABLED on', () => {
  it('accepts a request with no code, keeping the name', async () => {
    const input = await labPipe(true).transform({ ...labBody });
    expect(input).toBeInstanceOf(CreateLabRequestNameOnlyDto);
    expect(input).toMatchObject({ testDisplay: 'Sickling test', priority: 'urgent', status: 'active' });
    expect(input.testCodeSystem).toBeUndefined();
    expect(input.testCode).toBeUndefined();
  });

  it('accepts a coded request as before, with the same digest as today\'s class', async () => {
    const input = await labPipe(true).transform({ ...labBody, ...labCodes });
    expect(input).toMatchObject(labCodes);
    expect(requestDigest('lab-request.create', { input }))
      .toBe(requestDigest('lab-request.create', { input: await today(TodaysCreateLabRequestDto, { ...labBody, ...labCodes }) }));
  });

  it.each([[{ testCodeSystem: 'LOCAL' }], [{ testCode: 'SICKLE' }], [{ testCodeSystem: '  LOINC ' }]])(
    'refuses %j with 400 LAB_TEST_CODE_INCOMPLETE', async (codes) => {
      expect(await refusal(labPipe(true).transform({ ...labBody, ...codes }))).toEqual({ status: 400,
        code: 'LAB_TEST_CODE_INCOMPLETE', detail: 'Test code and its code system must be supplied together.', errors: undefined });
    });

  it.each([
    ['testCodeSystem', null], ['testCode', null], ['testCodeSystem', ''], ['testCode', '   '], ['testCodeSystem', 7],
    ['testCodeSystem', 's'.repeat(256)], ['testCode', 'c'.repeat(101)], ['testDisplay', ''], ['testDisplay', null],
  ])('refuses %s %p with 400 VALIDATION_FAILED on that field', async (field, value) => {
    const answer = await refusal(labPipe(true).transform({ ...labBody, ...labCodes, [field]: value }));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(answer.errors?.map((error) => error.field)).toEqual([field]);
  });

  it('still refuses an unknown field', async () => {
    expect(await refusal(labPipe(true).transform({ ...labBody, testCodeText: 'Sickling' }))).toMatchObject({
      status: 400, code: 'VALIDATION_FAILED', errors: [{ field: 'testCodeText', messages: ['property testCodeText should not exist'] }] });
  });
});

describe('diagnoses: DIAGNOSIS_NAME_ONLY_ENABLED off (the default)', () => {
  it.each([
    ['no code', diagnosisBody], ['a code system only', { ...diagnosisBody, codeSystem: 'ICD-10' }],
    ['a code only', { ...diagnosisBody, code: 'D57.0' }], ['null codes', { ...diagnosisBody, codeSystem: null, code: null }],
    ['empty codes', { ...diagnosisBody, codeSystem: '', code: '' }],
    ['no code and two other errors', { ...diagnosisBody, display: '', clinicalStatus: 'better', extra: true }],
  ])('refuses %s exactly as today\'s validation does', async (_label, input) => {
    const answer = await refusal(diagnosisPipe(false).transform(input));
    expect(answer).toEqual(await refusal(today(TodaysCreateDiagnosisDto, input)));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('accepts a coded diagnosis as today\'s class, with today\'s digest', async () => {
    const input = await diagnosisPipe(false).transform({ ...diagnosisBody, ...diagnosisCodes });
    expect(input).toBeInstanceOf(CreateDiagnosisDto);
    expect({ ...input }).toEqual({ ...await today(TodaysCreateDiagnosisDto, { ...diagnosisBody, ...diagnosisCodes }) });
    expect(requestDigest('diagnosis.create', { input })).toBe(requestDigest('diagnosis.create',
      { input: await today(TodaysCreateDiagnosisDto, { ...diagnosisBody, ...diagnosisCodes }) }));
  });
});

describe('diagnoses: DIAGNOSIS_NAME_ONLY_ENABLED on', () => {
  it('accepts a diagnosis with no code, keeping the name', async () => {
    const input = await diagnosisPipe(true).transform({ ...diagnosisBody });
    expect(input).toBeInstanceOf(CreateDiagnosisNameOnlyDto);
    expect(input).toMatchObject({ display: 'Sickle cell crisis (as written, test)', clinicalStatus: 'active' });
    expect([input.codeSystem, input.code]).toEqual([undefined, undefined]);
  });

  it('accepts a coded diagnosis as before (ICD-10 typed codes and any other code system), with today\'s digest', async () => {
    for (const codes of [diagnosisCodes, { codeSystem: 'ICD-11', code: '3A51.0' }, { codeSystem: 'SNOMED CT', code: '127040003' }]) {
      const input = await diagnosisPipe(true).transform({ ...diagnosisBody, ...codes });
      expect(input).toMatchObject(codes);
      expect(requestDigest('diagnosis.create', { input })).toBe(requestDigest('diagnosis.create',
        { input: await today(TodaysCreateDiagnosisDto, { ...diagnosisBody, ...codes }) }));
    }
  });

  it.each([[{ codeSystem: 'ICD-11' }], [{ code: '3A51.0' }]])('refuses %j with 400 DIAGNOSIS_CODE_INCOMPLETE', async (codes) => {
    expect(await refusal(diagnosisPipe(true).transform({ ...diagnosisBody, ...codes }))).toEqual({ status: 400,
      code: 'DIAGNOSIS_CODE_INCOMPLETE', detail: 'Diagnosis code and its code system must be supplied together.',
      errors: undefined });
  });

  it.each([
    ['codeSystem', null], ['code', null], ['codeSystem', ''], ['code', ' '], ['code', 'c'.repeat(101)], ['display', ''],
  ])('refuses %s %p with 400 VALIDATION_FAILED on that field', async (field, value) => {
    const answer = await refusal(diagnosisPipe(true).transform({ ...diagnosisBody, ...diagnosisCodes, [field]: value }));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(answer.errors?.map((error) => error.field)).toEqual([field]);
  });
});

describe('the consultation\'s diagnoses (EHR-C5) follow DIAGNOSIS_NAME_ONLY_ENABLED', () => {
  const visit = { encounterType: 'ambulatory', status: 'in_progress', startedAt: '2026-11-30T09:30:00.000Z' };
  const consultation = (diagnoses: unknown[]) => ({ visit, diagnoses });

  it('off: a diagnosis with no code is refused as today\'s class refuses it', async () => {
    const input = consultation([{ ...diagnosisBody, ...diagnosisCodes }, diagnosisBody]);
    const answer = await refusal(consultationPipe(false).transform(input));
    expect(answer).toEqual(await refusal(today(CreateConsultationDto, input)));
    expect(answer).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', errors: [{ field: 'diagnoses' }] });
    await expect(consultationPipe(false).transform(consultation([{ ...diagnosisBody, ...diagnosisCodes }])))
      .resolves.toBeInstanceOf(CreateConsultationDto);
  });

  it('on: diagnoses with and without codes are taken', async () => {
    const input = await consultationPipe(true).transform(consultation([{ ...diagnosisBody, ...diagnosisCodes }, diagnosisBody]));
    expect(input).toBeInstanceOf(CreateConsultationNameOnlyDto);
    expect(input.diagnoses?.map((diagnosis) => [diagnosis.codeSystem, diagnosis.code])).toEqual([['ICD-10', 'D57.0'],
      [undefined, undefined]]);
    expect(input.diagnoses?.[1]).toBeInstanceOf(CreateDiagnosisNameOnlyDto);
  });

  it('on: names the first diagnosis with one code only', async () => {
    expect(await refusal(consultationPipe(true).transform(consultation([diagnosisBody, { ...diagnosisBody, code: 'D57.0' },
      { ...diagnosisBody, codeSystem: 'ICD-10' }])))).toEqual({ status: 400, code: 'DIAGNOSIS_CODE_INCOMPLETE',
      detail: 'Diagnosis code and its code system must be supplied together.',
      errors: [{ field: 'diagnoses.1', messages: ['codeSystem and code must be supplied together'] }] });
  });

  it('on: a coded consultation keeps its digest', async () => {
    const body = consultation([{ ...diagnosisBody, ...diagnosisCodes }]);
    expect(requestDigest('consultation.create', { input: await consultationPipe(true).transform(body) }))
      .toBe(requestDigest('consultation.create', { input: await consultationPipe(false).transform(body) }));
  });
});

// Over HTTP, through Nest with the app's global pipe and filter: off, each
// create route answers a name-only body exactly as a route declared as before
// (`@Body() input: <today's class>`) does; on, the body reaches the service.
describe('the create routes over HTTP', () => {
  const patientId = '123e4567-e89b-42d3-a456-426614174001';
  const encounterId = '123e4567-e89b-42d3-a456-426614174006';
  const facilityId = '123e4567-e89b-42d3-a456-426614174002';
  const actor = { id: 'actor', subject: 'staff:test', accountId: '123e4567-e89b-42d3-a456-426614174003',
    authenticationMethod: 'local', roles: ['doctor'], facilityIds: [facilityId], facilities: [],
    permissions: ['ehr.lab-request.write', 'ehr.diagnosis.write', 'ehr.encounter.write'],
    facility: { id: facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004' } };

  @Controller('before')
  class BeforeController {
    @Post('lab-request')
    labRequest(@Body() input: TodaysCreateLabRequestDto) {
      return { received: input };
    }

    @Post('diagnosis')
    diagnosis(@Body() input: TodaysCreateDiagnosisDto) {
      return { received: input };
    }
  }

  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const start = async (labRequests: boolean, diagnoses: boolean) => {
    const received: unknown[] = [];
    const take = jest.fn(async (...args: unknown[]) => {
      received.push(args.find((arg) => typeof arg === 'object' && arg !== null && !('actor' in arg)));
      return { id: 'created' };
    });
    @Module({ controllers: [LabRequestsController, DiagnosesController, ConsultationsController, BeforeController], providers: [
      { provide: LabRequestsService, useValue: { create: take } },
      { provide: DiagnosesService, useValue: { create: take } },
      { provide: ConsultationsService, useValue: { create: take } },
      { provide: WorkItemProgressService, useValue: {} },
      { provide: AuditService, useValue: { record: jest.fn() } },
      { provide: NameOnlyCodes, useValue: new NameOnlyCodes(labRequests, diagnoses) }] })
    class TestModule {}
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((request: Request & Record<string, unknown>, _response: Response, next: NextFunction) => {
      request.actor = actor;
      request.facilityId = facilityId;
      request.correlationId = 'correlation-123456';
      next();
    });
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const post = async (path: string, payload: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-key-0000001',
          'x-purpose-of-use': 'direct-care' } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { post, received };
  };
  const encounter = `/ehr/patients/${patientId}/encounters/${encounterId}`;
  const sameProblem = (answer: { body: Record<string, unknown> }, before: { body: Record<string, unknown> }) => {
    const { instance: _a, correlationId: _b, ...rest } = answer.body;
    const { instance: _c, correlationId: _d, ...beforeRest } = before.body;
    expect(rest).toEqual(beforeRest);
  };

  it('off: a request or diagnosis with no code gets today\'s 400, word for word, and no service is called', async () => {
    const { post, received } = await start(false, false);
    for (const payload of [labBody, { ...labBody, testCodeSystem: 'LOCAL' }, { ...labBody, testCode: null }]) {
      const answer = await post(`${encounter}/lab-requests`, payload);
      expect(answer.status).toBe(400);
      sameProblem(answer, await post('/before/lab-request', payload));
    }
    for (const payload of [diagnosisBody, { ...diagnosisBody, code: 'D57.0' }]) {
      const answer = await post(`${encounter}/diagnoses`, payload);
      expect(answer.status).toBe(400);
      sameProblem(answer, await post('/before/diagnosis', payload));
    }
    const visit = { encounterType: 'ambulatory', status: 'in_progress', startedAt: '2026-11-30T09:30:00.000Z' };
    expect((await post(`/ehr/patients/${patientId}/consultations`, { visit, diagnoses: [diagnosisBody] })).body)
      .toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(received).toHaveLength(0);
    expect((await post(`${encounter}/lab-requests`, { ...labBody, ...labCodes })).status).toBe(201);
    expect(received[0]).toBeInstanceOf(CreateLabRequestDto);
    expect((await post(`${encounter}/diagnoses`, { ...diagnosisBody, ...diagnosisCodes })).status).toBe(201);
    expect(received[1]).toBeInstanceOf(CreateDiagnosisDto);
  });

  it('on: the name-only bodies reach the services; one code alone gets the contract\'s 400', async () => {
    const { post, received } = await start(true, true);
    expect((await post(`${encounter}/lab-requests`, labBody)).status).toBe(201);
    expect(received[0]).toBeInstanceOf(CreateLabRequestNameOnlyDto);
    expect((await post(`${encounter}/diagnoses`, diagnosisBody)).status).toBe(201);
    expect(received[1]).toBeInstanceOf(CreateDiagnosisNameOnlyDto);
    const visit = { encounterType: 'ambulatory', status: 'in_progress', startedAt: '2026-11-30T09:30:00.000Z' };
    expect((await post(`/ehr/patients/${patientId}/consultations`, { visit, diagnoses: [diagnosisBody] })).status).toBe(201);
    expect(received[2]).toBeInstanceOf(CreateConsultationNameOnlyDto);
    expect(await post(`${encounter}/lab-requests`, { ...labBody, testCode: 'SICKLE' })).toMatchObject({ status: 400,
      body: { status: 400, code: 'LAB_TEST_CODE_INCOMPLETE', detail: 'Test code and its code system must be supplied together.' } });
    expect(await post(`${encounter}/diagnoses`, { ...diagnosisBody, codeSystem: 'ICD-11' })).toMatchObject({ status: 400,
      body: { status: 400, code: 'DIAGNOSIS_CODE_INCOMPLETE',
        detail: 'Diagnosis code and its code system must be supplied together.' } });
    expect(await post(`/ehr/patients/${patientId}/consultations`, { visit, diagnoses: [{ ...diagnosisBody, code: 'X' }] }))
      .toMatchObject({ status: 400, body: { code: 'DIAGNOSIS_CODE_INCOMPLETE', errors: [{ field: 'diagnoses.0' }] } });
    expect(received).toHaveLength(3);
  });

  it('each setting is its own: lab requests on leaves diagnoses as today, and the other way round', async () => {
    const labOnly = await start(true, false);
    expect((await labOnly.post(`${encounter}/lab-requests`, labBody)).status).toBe(201);
    expect((await labOnly.post(`${encounter}/diagnoses`, diagnosisBody)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    await app?.close();
    const diagnosisOnly = await start(false, true);
    expect((await diagnosisOnly.post(`${encounter}/lab-requests`, labBody)).body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await diagnosisOnly.post(`${encounter}/diagnoses`, diagnosisBody)).status).toBe(201);
  });
});
