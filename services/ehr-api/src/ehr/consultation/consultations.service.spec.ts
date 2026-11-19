import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { EncountersService } from '../encounters/encounters.service';
import { lagosCalendarDate } from '../encounters/lagos-day';
import {
  DiagnosisClinicalStatus,
  DiagnosisVerificationStatus,
  EncounterStatus,
  EncounterType,
  NoteStatus,
  VitalSource,
  type CreateDiagnosisDto,
} from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';
import { VitalsService } from '../vitals/vitals.service';
import { CreateConsultationDto } from './consultation.dto';
import { ConsultationsController, consultationPermissions } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

// Fictional identifiers and clinical data only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const NOW = new Date('2026-11-18T10:00:00Z');
const KEY = 'consultation-key-0001';

function contextFor(correlationId: string): DataAccessContext {
  return { correlationId, facilityId, membershipId, purposeOfUse: 'direct-care', authorization: 'Bearer user',
    actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
      permissions: [], facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
        permissions: [], isPrimary: true } } } as unknown as DataAccessContext;
}

const diagnosis = (overrides: Partial<CreateDiagnosisDto> = {}): CreateDiagnosisDto => ({
  codeSystem: 'ICD-10', code: 'B50.9', display: 'Malaria (test)', clinicalStatus: DiagnosisClinicalStatus.Active,
  verificationStatus: DiagnosisVerificationStatus.Provisional, ...overrides,
});

const body = (overrides: Partial<CreateConsultationDto> = {}): CreateConsultationDto => ({
  visit: { encounterType: EncounterType.Ambulatory, status: EncounterStatus.InProgress,
    startedAt: '2026-11-18T09:30:00.000Z', chiefComplaint: 'Fever for two days (test)' },
  note: { noteType: 'consultation', title: 'Consultation (test)', status: NoteStatus.Signed,
    content: 'Fictional consultation note.' },
  vitals: { recordedAt: '2026-11-18T09:35:00.000Z', temperatureC: 38.4, systolicMmhg: 120, diastolicMmhg: 80,
    source: VitalSource.Manual },
  diagnoses: [diagnosis(), diagnosis({ code: 'R50.9', display: 'Fever (test)' })],
  ...overrides,
});

type Row = Record<string, unknown>;
interface Tables {
  keys: Row[];
  encounters: Row[];
  notes: Row[];
  revisions: Row[];
  vitals: Row[];
  diagnoses: Row[];
}

/**
 * A small in-memory database for the real ClinicalRepository and the real
 * services: each transaction works on a copy that is kept only when the
 * transaction ends without an error (all or nothing), transactions run one
 * at a time, and statements are answered as PostgreSQL would for the rows
 * the services read. Inserting a diagnosis with code 'FAIL' breaks a CHECK.
 */
function fakeDatabase() {
  let tables: Tables = { keys: [], encounters: [], notes: [], revisions: [], vitals: [], diagnoses: [] };
  const counters: Record<string, number> = {};
  const nextId = (table: string) => {
    counters[table] = (counters[table] ?? 0) + 1;
    const prefix = { keys: '1', encounters: '2', notes: '3', revisions: '4', vitals: '5', diagnoses: '6' }[table] ?? '9';
    return `123e4567-e89b-42d3-a456-${prefix}${String(counters[table]).padStart(11, '0')}`;
  };
  const audits: Row[] = [];
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  function client(work: Tables, pendingAudits: Row[], correlationId: string) {
    return {
      query: jest.fn(async (text: string, values: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        const one = (rows: Row[]) => ({ rows, rowCount: rows.length });
        if (sql.startsWith('insert into audit.events')) {
          return one([]);
        }
        if (sql.startsWith("select set_config('app.change_reason'")) return one([]);
        if (sql.includes('pg_advisory_xact_lock')) {
          log.push('lock');
          return one([]);
        }
        if (sql.startsWith('insert into ehr.idempotency_keys')) {
          const [facility, , createdBy, , key, operation, sha] = values;
          const existing = work.keys.find((row) => row.facility === facility && row.createdBy === createdBy
            && row.operation === operation && row.key === key);
          if (existing) return { rows: [], rowCount: 0 };
          const id = nextId('keys');
          work.keys.push({ id, facility, createdBy, key, operation, sha, state: 'processing', correlationId });
          return one([{ id }]);
        }
        if (sql.startsWith('select request_sha256, state, result_resource_id, result_resource_type from ehr.idempotency_keys')) {
          const [facility, createdBy, operation, key] = values;
          const row = work.keys.find((candidate) => candidate.facility === facility
            && candidate.createdBy === createdBy && candidate.operation === operation && candidate.key === key);
          return one(row ? [{ request_sha256: row.sha, state: row.state, result_resource_id: row.resultId ?? null,
            result_resource_type: row.resultType ?? null }] : []);
        }
        if (sql.startsWith('update ehr.idempotency_keys')) {
          const row = work.keys.find((candidate) => candidate.id === values[2]);
          if (row) Object.assign(row, { state: 'completed', resultType: values[0], resultId: values[1] });
          return one([]);
        }
        if (sql.includes('from ehr.idempotency_keys key_row')) {
          const [encounterId, , , , operation, key] = values;
          const keyRow = work.keys.find((row) => row.operation === operation && row.key === key);
          const encounter = work.encounters.find((row) => row.id === encounterId);
          return one(keyRow && encounter ? [{ reused: encounter.correlationId !== keyRow.correlationId }] : []);
        }
        if (/^select .* from ehr\.encounters where patient_id = \$1 and facility_id = \$2 and status = any/.test(sql)) {
          log.push('lookup');
          const [patient, facility, day, statuses] = values as [string, string, string, string[]];
          const open = work.encounters.filter((row) => row.patientId === patient && row.facilityId === facility
            && statuses.includes(String(row.status)) && lagosCalendarDate(row.startedAt as Date) === day);
          return one(open.slice(-1).map(publicRow));
        }
        if (sql.startsWith('insert into ehr.encounters')) {
          const [patient, facility, createdBy, membership, encounterNumber, encounterType, status, startedAt,
            endedAt, chiefComplaint] = values;
          const row = { id: nextId('encounters'), patientId: patient, facilityId: facility, createdBy,
            createdByMembershipId: membership, encounterNumber, encounterType, status,
            startedAt: new Date(String(startedAt)), endedAt, chiefComplaint, rowVersion: '1', createdAt: NOW,
            updatedAt: NOW, importedPaperRecords: false, correlationId };
          work.encounters.push(row);
          return one([publicRow(row)]);
        }
        if (sql.startsWith('select status from ehr.encounters')) {
          const row = work.encounters.find((candidate) => candidate.id === values[0]);
          return one(row ? [{ status: row.status }] : []);
        }
        if (/^select 1 from ehr\.encounters where id = \$1/.test(sql)) {
          return one(work.encounters.filter((row) => row.id === values[0]).map(() => ({ '?column?': 1 })));
        }
        if (/^select .* from ehr\.encounters where id = \$1 and patient_id = \$2 and facility_id = \$3$/.test(sql)) {
          return one(work.encounters.filter((row) => row.id === values[0]).map(publicRow));
        }
        if (sql.startsWith('insert into ehr.clinical_notes')) {
          const [encounterId, patient, facility, createdBy, membership, noteType, title, status, signed] = values;
          const row = { id: nextId('notes'), encounterId, patientId: patient, facilityId: facility, createdBy,
            createdByMembershipId: membership, noteType, title, status, currentRevisionNo: 1,
            signedAt: signed ? NOW : null, signedBy: signed ? createdBy : null, rowVersion: '1', createdAt: NOW,
            updatedAt: NOW };
          work.notes.push(row);
          return one([row]);
        }
        if (sql.startsWith('insert into ehr.clinical_note_revisions')) {
          work.revisions.push({ noteId: values[0], content: values[3], reason: sql.match(/'([^']+)'/)?.[1] });
          return one([]);
        }
        if (/^select .* from ehr\.clinical_notes where id = \$1 and patient_id = \$2 and facility_id = \$3$/.test(sql)) {
          return one(work.notes.filter((row) => row.id === values[0]));
        }
        if (sql.startsWith('insert into ehr.vitals')) {
          const row = { id: nextId('vitals'), encounterId: values[0], patientId: values[1], facilityId: values[2],
            createdBy: values[3], createdByMembershipId: values[4], recordedAt: new Date(String(values[5])),
            heightCm: values[6], weightKg: values[7], temperatureC: values[8] === null ? null : String(values[8]),
            pulseBpm: values[9], respiratoryRate: values[10], systolicMmhg: values[11], diastolicMmhg: values[12],
            oxygenSaturationPercent: values[13], source: values[14], currentCorrectionNo: 0, rowVersion: '1',
            createdAt: NOW, updatedAt: NOW };
          work.vitals.push(row);
          return one([row]);
        }
        if (/^select .* from ehr\.vitals where id = \$1 and patient_id = \$2 and facility_id = \$3$/.test(sql)) {
          return one(work.vitals.filter((row) => row.id === values[0]));
        }
        if (sql.startsWith('insert into ehr.diagnoses')) {
          if (values[6] === 'FAIL') throw Object.assign(new Error('new row violates check constraint'), { code: '23514' });
          const row = { id: nextId('diagnoses'), encounterId: values[0], patientId: values[1], facilityId: values[2],
            createdBy: values[3], createdByMembershipId: values[4], codeSystem: values[5], code: values[6],
            display: values[7], clinicalStatus: values[8], verificationStatus: values[9], onsetAt: values[10],
            abatementAt: values[11], notes: values[12], rowVersion: '1', createdAt: NOW, updatedAt: NOW };
          work.diagnoses.push(row);
          return one([row]);
        }
        if (/^select .* from ehr\.diagnoses where id = \$1 and patient_id = \$2 and facility_id = \$3$/.test(sql)) {
          return one(work.diagnoses.filter((row) => row.id === values[0]));
        }
        throw new Error(`Unexpected statement in the fake database: ${sql.slice(0, 120)}`);
      }),
      pendingAudits,
    };
  }

  const database = {
    withTransaction: jest.fn(async (context: DataAccessContext, operation: (client: never) => Promise<unknown>) => {
      const run = queue.then(async () => {
        const work = structuredClone(tables);
        const pendingAudits: Row[] = [];
        const result = await operation(client(work, pendingAudits, context.correlationId) as never);
        tables = work;
        audits.push(...pendingAudits);
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    }),
  };
  const audit = {
    record: jest.fn(async (event: Row) => { audits.push(event); }),
    recordWithClient: jest.fn(async (transactionClient: { pendingAudits: Row[] }, event: Row) => {
      transactionClient.pendingAudits.push(event);
    }),
  };
  let allowed = true;
  const identity = { authorize: jest.fn(async () => ({ allowed })) };
  const repository = new ClinicalRepository(database as never, audit as never, identity as never);
  const encounters = new EncountersService(repository);
  encounters.now = () => NOW;
  const notes = new ClinicalNotesService(repository);
  const vitals = new VitalsService(repository);
  const diagnoses = new DiagnosesService(repository);
  const consultations = new ConsultationsService(repository, encounters, notes, vitals, diagnoses);
  return {
    consultations, encounters, notes, vitals, diagnoses, identity, database, audits, log,
    tables: () => tables,
    seedEncounter: (row: Row) => { tables.encounters.push(row); },
    refuseConsent: () => { allowed = false; },
  };
}

function publicRow(row: Row): Row {
  const copy = { ...row };
  delete copy.correlationId;
  return copy;
}

/** The parts of an audit row a reader sees: what, which record, outcome and details. */
const auditView = (row: Row) => ({ action: row.action, resourceType: row.resourceType, resourceId: row.resourceId,
  outcome: row.outcome, patientId: row.patientId, details: row.details });

describe('EHR-C5 POST ehr/patients/:patientId/consultations (route)', () => {
  it('is a POST under the patient (UUID), needing the visit write permission at the guard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationsController)).toBe('ehr/patients/:patientId/consultations');
    const handler = ConsultationsController.prototype.create;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.encounter.write']);
  });

  it('needs each part\'s own write permission, only for the parts sent', () => {
    expect(consultationPermissions(body())).toEqual(['ehr.encounter.write', 'ehr.note.write', 'ehr.vital.write',
      'ehr.diagnosis.write']);
    expect(consultationPermissions(body({ note: undefined, vitals: undefined, diagnoses: [] })))
      .toEqual(['ehr.encounter.write']);
  });

  const request = (permissions: string[]) => ({
    actor: { ...contextFor('correlation-route-0001').actor, permissions },
    facilityId, correlationId: 'correlation-route-0001', method: 'POST',
    header: (name: string) => ({ 'x-purpose-of-use': 'direct-care' } as Record<string, string>)[name.toLowerCase()],
  }) as never;

  it('refuses the whole call when one part\'s permission is missing: nothing is read or saved', async () => {
    const service = { create: jest.fn() };
    const controller = new ConsultationsController(service as never);
    const withoutDiagnosis = ['ehr.encounter.write', 'ehr.note.write', 'ehr.vital.write'];
    expect(() => controller.create(request(withoutDiagnosis), patientId, KEY, body()))
      .toThrow(expect.objectContaining({ status: 403, code: 'PERMISSION_DENIED' }));
    expect(service.create).not.toHaveBeenCalled();
  });

  it('lets the same caller save a consultation without the part it may not write', async () => {
    const service = { create: jest.fn().mockResolvedValue({}) };
    const controller = new ConsultationsController(service as never);
    await controller.create(request(['ehr.encounter.write', 'ehr.note.write', 'ehr.vital.write']), patientId, KEY,
      body({ diagnoses: undefined }));
    expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ facilityId, purposeOfUse: 'direct-care' }),
      patientId, expect.objectContaining({ diagnoses: undefined }), KEY);
  });

  it('requires an Idempotency-Key', () => {
    const service = { create: jest.fn() };
    const controller = new ConsultationsController(service as never);
    expect(() => controller.create(request(consultationPermissions(body())), patientId, undefined, body()))
      .toThrow(expect.objectContaining({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(service.create).not.toHaveBeenCalled();
  });

  it('validates each part as its own route does, and at most 20 diagnoses', async () => {
    const pipe = createValidationPipe();
    const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: CreateConsultationDto });
    await expect(validate(JSON.parse(JSON.stringify(body())))).resolves.toBeInstanceOf(CreateConsultationDto);
    await expect(validate({ ...body(), diagnoses: Array.from({ length: 21 }, () => diagnosis()) }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(validate({ ...body(), diagnoses: [{ ...diagnosis(), code: '' }] }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(validate({ ...body(), note: { ...body().note, content: '   ' } }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(validate({ ...body(), prescriptions: [] }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(validate({ ...body(), visit: null })).rejects.toMatchObject({ status: 400 });
  });
});

describe('EHR-C5 one-call consultation (service)', () => {
  it('saves the visit, a signed note, vitals and diagnoses in one transaction', async () => {
    const db = fakeDatabase();
    const saved = await db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);
    expect(db.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(db.identity.authorize).toHaveBeenCalledTimes(1);
    expect(db.identity.authorize).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', expect.anything());
    expect(saved.encounter).toMatchObject({ reusedOpenVisit: false, status: 'in_progress',
      chiefComplaint: 'Fever for two days (test)' });
    expect(saved.note).toMatchObject({ encounterId: saved.encounter.id, status: 'signed', signedBy: accountId });
    expect(saved.vitals).toMatchObject({ encounterId: saved.encounter.id, systolicMmhg: 120, diastolicMmhg: 80 });
    expect(saved.diagnoses.map((row) => [row.encounterId, row.code])).toEqual([
      [saved.encounter.id, 'B50.9'], [saved.encounter.id, 'R50.9']]);
    const tables = db.tables();
    expect([tables.encounters.length, tables.notes.length, tables.vitals.length, tables.diagnoses.length])
      .toEqual([1, 1, 1, 2]);
    // FR-1: a note signed at create needs no reason; its first revision is the usual one.
    expect(tables.revisions).toEqual([{ noteId: saved.note?.id, content: 'Fictional consultation note.',
      reason: 'initial clinical note' }]);
    expect(tables.keys.map((row) => row.operation)).toEqual(['consultation.create', 'consultation.encounter',
      'consultation.clinical-note', 'consultation.vital', 'consultation.diagnosis.1', 'consultation.diagnosis.2']);
    expect(tables.keys.every((row) => row.state === 'completed' && row.key === KEY)).toBe(true);
  });

  it('writes exactly the audit rows the separate routes write', async () => {
    const together = fakeDatabase();
    await together.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);

    const apart = fakeDatabase();
    const context = contextFor('correlation-0001');
    const input = body();
    const visit = await apart.encounters.create(context, patientId, { ...input.visit, reuseOpenVisit: true },
      'separate-key-visit-01');
    await apart.notes.create(context, patientId, visit.id, input.note!, 'separate-key-note-001');
    await apart.vitals.create(context, patientId, visit.id, input.vitals!, 'separate-key-vitals-1');
    for (const [index, item] of input.diagnoses!.entries()) {
      await apart.diagnoses.create(context, patientId, visit.id, item, `separate-key-diagnosis-${index}`);
    }
    expect(together.audits.map(auditView)).toEqual(apart.audits.map(auditView));
    expect(together.audits.map((row) => row.action)).toEqual(['ehr.encounter.create', 'ehr.note.create',
      'ehr.vital.create', 'ehr.diagnosis.create', 'ehr.diagnosis.create']);
    expect(together.audits[0]?.details).toEqual({ reusedOpenVisit: false, day: '2026-11-18', idempotentReplay: false });
    // No Health ID, NIN or clinical text in any audit row.
    expect(JSON.stringify(together.audits)).not.toMatch(/Fictional consultation note|Fever|Malaria/);
  });

  it('is all or nothing: a failing diagnosis saves no visit, note, vitals, key or audit row', async () => {
    const db = fakeDatabase();
    const failing = body({ diagnoses: [diagnosis(), diagnosis({ code: 'FAIL' })] });
    await expect(db.consultations.create(contextFor('correlation-0001'), patientId, failing, KEY))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CLINICAL_DATA' });
    expect(db.tables()).toEqual({ keys: [], encounters: [], notes: [], revisions: [], vitals: [], diagnoses: [] });
    expect(db.audits).toEqual([]);

    // The key was not used up: the corrected request goes through with it.
    const saved = await db.consultations.create(contextFor('correlation-0002'), patientId, body(), KEY);
    expect(saved.diagnoses).toHaveLength(2);
    expect(db.tables().encounters).toHaveLength(1);
  });

  it('answers a replay of the same key and body with the identical answer, saving nothing new', async () => {
    const db = fakeDatabase();
    const first = await db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);
    const before = structuredClone(db.tables());
    const replay = await db.consultations.create(contextFor('correlation-0002'), patientId, body(), KEY);
    expect(replay).toEqual(first);
    expect(replay.encounter.reusedOpenVisit).toBe(false);
    expect(db.tables()).toEqual(before);
    // Audited as each route audits its own replay.
    const replayRows = db.audits.slice(5);
    expect(replayRows.map((row) => [row.action, row.resourceId, (row.details as Row).idempotentReplay])).toEqual([
      ['ehr.encounter.create', first.encounter.id, true],
      ['ehr.note.create', first.note?.id, true],
      ['ehr.vital.create', first.vitals?.id, true],
      ['ehr.diagnosis.create', first.diagnoses[0]?.id, true],
      ['ehr.diagnosis.create', first.diagnoses[1]?.id, true],
    ]);
  });

  it('treats a body that differs only by reuseOpenVisit: true as the same request', async () => {
    const db = fakeDatabase();
    const first = await db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);
    const withFlag = body({ visit: { ...body().visit, reuseOpenVisit: true } });
    await expect(db.consultations.create(contextFor('correlation-0002'), patientId, withFlag, KEY))
      .resolves.toEqual(first);
  });

  it('answers 409 for the same key with another body, saving nothing', async () => {
    const db = fakeDatabase();
    await db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);
    const before = structuredClone(db.tables());
    const other = body({ diagnoses: [diagnosis({ code: 'A01.0', display: 'Typhoid fever (test)' })] });
    await expect(db.consultations.create(contextFor('correlation-0002'), patientId, other, KEY))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(db.tables()).toEqual(before);
  });

  it('saves onto the open visit today instead of starting another (EHR-C1 lock before lookup)', async () => {
    const db = fakeDatabase();
    const openVisitId = '123e4567-e89b-42d3-a456-426614174020';
    db.seedEncounter({ id: openVisitId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
      encounterNumber: null, encounterType: 'ambulatory', status: 'on_hold', startedAt: new Date('2026-11-18T08:00:00Z'),
      endedAt: null, chiefComplaint: 'Headache (test)', rowVersion: '3', createdAt: NOW, updatedAt: NOW,
      importedPaperRecords: false, correlationId: 'correlation-earlier' });
    const saved = await db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY);
    expect(saved.encounter).toMatchObject({ id: openVisitId, reusedOpenVisit: true, status: 'on_hold' });
    expect(saved.note?.encounterId).toBe(openVisitId);
    expect(saved.vitals?.encounterId).toBe(openVisitId);
    expect(saved.diagnoses.every((row) => row.encounterId === openVisitId)).toBe(true);
    expect(db.tables().encounters).toHaveLength(1);
    expect(db.log).toEqual(['lock', 'lookup']);
    expect(db.audits[0]).toMatchObject({ action: 'ehr.encounter.create', resourceId: openVisitId,
      details: { reusedOpenVisit: true, day: '2026-11-18', idempotentReplay: false } });

    // Its replay still says the visit was reused.
    const replay = await db.consultations.create(contextFor('correlation-0002'), patientId, body(), KEY);
    expect(replay).toEqual(saved);
  });

  it('refuses the whole call without consent, audits each part refused, and saves nothing', async () => {
    const db = fakeDatabase();
    db.refuseConsent();
    await expect(db.consultations.create(contextFor('correlation-0001'), patientId, body(), KEY))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(db.database.withTransaction).not.toHaveBeenCalled();
    expect(db.audits.map((row) => [row.action, row.outcome, (row.details as Row).reason])).toEqual([
      ['ehr.encounter.create', 'denied', 'identity_authorization'],
      ['ehr.note.create', 'denied', 'identity_authorization'],
      ['ehr.vital.create', 'denied', 'identity_authorization'],
      ['ehr.diagnosis.create', 'denied', 'identity_authorization'],
      ['ehr.diagnosis.create', 'denied', 'identity_authorization'],
    ]);
  });

  it('runs each part\'s own checks before the database is touched', async () => {
    const db = fakeDatabase();
    const context = contextFor('correlation-0001');
    expect(() => db.consultations.create(context, patientId,
      body({ visit: { ...body().visit, reuseOpenVisit: false } }), KEY))
      .toThrow(expect.objectContaining({ status: 400, code: 'CONSULTATION_USES_OPEN_VISIT' }));
    expect(() => db.consultations.create(context, patientId,
      body({ visit: { ...body().visit, status: EncounterStatus.Completed } }), KEY))
      .toThrow(expect.objectContaining({ status: 400, code: 'REUSE_OPEN_VISIT_NEEDS_OPEN_STATUS' }));
    expect(() => db.consultations.create(context, patientId,
      body({ visit: { ...body().visit, startedAt: '2026-11-17T09:30:00.000Z' } }), KEY))
      .toThrow(expect.objectContaining({ status: 400, code: 'REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY' }));
    expect(() => db.consultations.create(context, patientId,
      body({ vitals: { recordedAt: '2026-11-18T09:35:00.000Z', source: VitalSource.Manual } }), KEY))
      .toThrow(expect.objectContaining({ status: 400, code: 'VITAL_MEASUREMENT_REQUIRED' }));
    expect(() => db.consultations.create(context, patientId,
      body({ vitals: { recordedAt: '2026-11-18T09:35:00.000Z', systolicMmhg: 120, source: VitalSource.Manual } }), KEY))
      .toThrow(expect.objectContaining({ status: 400, code: 'BLOOD_PRESSURE_INCOMPLETE' }));
    expect(db.identity.authorize).not.toHaveBeenCalled();
    expect(db.audits).toEqual([]);
  });

  it('saves a visit with only a draft note, leaving out vitals and diagnoses', async () => {
    const db = fakeDatabase();
    const saved = await db.consultations.create(contextFor('correlation-0001'), patientId,
      body({ note: { ...body().note!, status: NoteStatus.Draft }, vitals: undefined, diagnoses: undefined }), KEY);
    expect(saved).toMatchObject({ note: { status: 'draft', signedAt: null }, vitals: null, diagnoses: [] });
    expect(db.audits.map((row) => row.action)).toEqual(['ehr.encounter.create', 'ehr.note.create']);
  });
});
