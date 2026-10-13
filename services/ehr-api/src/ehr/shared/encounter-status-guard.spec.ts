import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { DocumentService } from '../../documents/document.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import type { StorageProvider } from '../../storage/storage.types';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { DiagnosesService } from '../diagnoses/diagnoses.service';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { VitalsService } from '../vitals/vitals.service';
import { ClinicalRepository } from './clinical.repository';
import {
  DiagnosisClinicalStatus,
  DiagnosisVerificationStatus,
  NoteStatus,
  OrderStatus,
  VitalSource,
} from './clinical.dto';

// Clinical records follow their encounter's status (CLIN-EIE, 0084): every
// child create, and every order activation, reads the encounter under a share
// lock first and refuses a closed one with 409 ENCOUNTER_NOT_OPEN before
// anything is written or sent to Lab. These run the real ClinicalRepository
// over a fake transaction.

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174005';
const orderId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId,
  purposeOfUse: 'direct-care', authorization: 'Bearer user', actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['lab.work-item.accept'], facilityIds: [facilityId], facilities: [] } } as DataAccessContext;

type Status = 'planned' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled' | 'entered_in_error';
const STATUSES: readonly Status[] = ['planned', 'in_progress', 'on_hold', 'completed', 'cancelled', 'entered_in_error'];

/**
 * One fake transaction: the encounter is in `encounter` status, an existing
 * order (prescription or lab request) in `order` status. `statements` keeps
 * every statement in order, whitespace collapsed.
 */
function clinicalDatabase(encounter: Status, order: OrderStatus = OrderStatus.Draft) {
  const statements: string[] = [];
  const orderRow = (status: OrderStatus) => ({ id: orderId, encounterId, patientId, facilityId, createdBy: accountId,
    createdByMembershipId: membershipId, status, rowVersion: '2', createdAtExact: '2026-10-01T09:00:00.123456Z',
    testCodeSystem: 'http://loinc.org', testCode: '718-7', testDisplay: 'Haemoglobin', priority: 'routine',
    clinicalInformation: null, medicationDisplay: 'Amoxicillin 500 mg' });
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const statement = sql.replace(/\s+/g, ' ').trim();
    statements.push(statement);
    if (/from ehr\.encounters\b.*\bfor share$/i.test(statement)) return { rows: [{ status: encounter }], rowCount: 1 };
    if (/^select 1 from ehr\./i.test(statement)) return { rows: [{}], rowCount: 1 };
    if (/^insert into ehr\.idempotency_keys\b/i.test(statement)) return { rows: [{ id: 'idempotency-row' }], rowCount: 1 };
    const inserted = /^insert into ehr\.(\w+)\b/i.exec(statement)?.[1];
    if (inserted) {
      return { rows: [{ id: `${inserted}-id`, status: inserted === 'documents' ? 'initiated' : 'draft',
        rowVersion: '1', row_version: '1', size_bytes: '1024', storage_key: 'clinical/objects/synthetic',
        declared_media_type: 'application/pdf', currentRevisionNo: 1 }], rowCount: 1 };
    }
    if (/from ehr\.(prescriptions|lab_requests)\b.*\bfor update$/i.test(statement)) return { rows: [orderRow(order)], rowCount: 1 };
    if (/^update ehr\.(prescriptions|lab_requests)\b/i.test(statement)) {
      return { rows: [{ ...orderRow((params[1] ?? params[0] ?? order) as OrderStatus), rowVersion: '3' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query } as unknown as PoolClient;
  const database = {
    withTransaction: jest.fn(async (_context: unknown, work: (c: PoolClient) => Promise<unknown>) => work(client)),
    query: jest.fn(async () => ({ rows: [{}] })),
  };
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  const identity = { authorize: jest.fn(async () => ({ allowed: true, breakGlass: false })) };
  const repository = new ClinicalRepository(database as unknown as DatabaseService, audit as unknown as AuditService,
    identity as unknown as IdentityApiService);
  const labApi = { acceptEhrOrder: jest.fn(async () => ({ id: 'work-item' })) };
  const pharmacyApi = { acceptEhrPrescription: jest.fn() };
  const storage = { bucket: () => 'synthetic-bucket', createUpload: jest.fn(async () => ({ url: 'https://upload.invalid' })) };
  return {
    statements, labApi,
    notes: new ClinicalNotesService(repository),
    vitals: new VitalsService(repository),
    diagnoses: new DiagnosesService(repository),
    prescriptions: new PrescriptionsService(repository, pharmacyApi as never),
    labRequests: new LabRequestsService(repository, labApi as never),
    documents: new DocumentService(database as unknown as DatabaseService, identity as unknown as IdentityApiService,
      audit as unknown as AuditService, storage as unknown as StorageProvider),
  };
}

const CREATES: ReadonlyArray<readonly [string, string, boolean, (db: ReturnType<typeof clinicalDatabase>) => Promise<unknown>]> = [
  ['clinical note', 'clinical_notes', false, (db) => db.notes.create(context, patientId, encounterId,
    { noteType: 'progress', title: 'Synthetic note', status: NoteStatus.Signed, content: 'Synthetic content' } as never,
    'note-key-123456')],
  ['OCR clinical note import', 'clinical_notes', false, (db) => db.notes.createImportedFromOcr(context, patientId, {
    encounterId, noteType: 'historical-record', title: 'Imported record', content: 'Human-reviewed content',
    publicationId: '80000000-0000-4000-8000-000000000001', documentId: '90000000-0000-4000-8000-000000000001',
    ocrJobId: 'a0000000-0000-4000-8000-000000000001', extractionId: 'b0000000-0000-4000-8000-000000000001',
    validationId: 'c0000000-0000-4000-8000-000000000001', validationVersion: 1,
    reviewedBy: '20000000-0000-4000-8000-000000000002' })],
  ['vital', 'vitals', false, (db) => db.vitals.create(context, patientId, encounterId,
    { recordedAt: '2026-10-01T08:10:00.000Z', pulseBpm: 72, source: VitalSource.Manual } as never, 'vital-key-123456')],
  ['diagnosis', 'diagnoses', false, (db) => db.diagnoses.create(context, patientId, encounterId, {
    codeSystem: 'http://hl7.org/fhir/sid/icd-10', code: 'R50.9', display: 'Fever, unspecified',
    clinicalStatus: DiagnosisClinicalStatus.Active, verificationStatus: DiagnosisVerificationStatus.Provisional,
  } as never, 'diagnosis-key-123456')],
  ['document linked to the encounter', 'documents', false, (db) => db.documents.createUploadIntent({
    patientId, encounterId, fileName: 'referral.pdf', mediaType: 'application/pdf', sizeBytes: 1024,
    sha256Hex: 'a'.repeat(64), classification: 'phi', retentionClass: 'clinical-10y' } as never,
  'document-key-123456', context)],
  ['draft prescription', 'prescriptions', true, (db) => db.prescriptions.create(context, patientId, encounterId, {
    medicationDisplay: 'Paracetamol 500 mg', frequency: 'Every 6 hours', instructions: 'Take with water',
    status: OrderStatus.Draft } as never, 'prescription-key-123456')],
  ['active lab request', 'lab_requests', true, (db) => db.labRequests.create(context, patientId, encounterId, {
    testCodeSystem: 'http://loinc.org', testCode: '2345-7', testDisplay: 'Glucose', priority: 'routine',
    status: OrderStatus.Active } as never, 'lab-request-key-123456')],
];

/** The expected outcome of a create on an encounter in `status`. */
const allowed = (status: Status, order: boolean) =>
  ['planned', 'in_progress', 'on_hold'].includes(status) || (status === 'completed' && !order);

describe('Child creates follow the encounter status', () => {
  const cases = CREATES.flatMap(([label, table, order, create]) =>
    STATUSES.map((status) => [label, status, table, order, create] as const));

  it.each(cases)('%s on a %s encounter', async (_label, status, table, order, create) => {
    const db = clinicalDatabase(status);
    const insert = new RegExp(`^insert into ehr\\.${table}\\b`, 'i');
    if (allowed(status, order)) {
      await expect(create(db)).resolves.toBeDefined();
      expect(db.statements.some((sql) => insert.test(sql))).toBe(true);
    } else {
      await expect(create(db)).rejects.toMatchObject({ status: 409, code: 'ENCOUNTER_NOT_OPEN' });
      expect(db.statements.some((sql) => insert.test(sql))).toBe(false);
      expect(db.labApi.acceptEhrOrder).not.toHaveBeenCalled();
    }
    // Whenever the record is written, the encounter was read under a share lock first.
    const lockAt = db.statements.findIndex((sql) =>
      /^select status from ehr\.encounters where id = \$1 and patient_id = \$2 and facility_id = \$3 for share$/i.test(sql));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    const insertAt = db.statements.findIndex((sql) => insert.test(sql));
    if (insertAt >= 0) expect(insertAt).toBeGreaterThan(lockAt);
  });
});

describe('Order activation follows the encounter status', () => {
  const ACTIVATIONS: ReadonlyArray<readonly [string, string, (db: ReturnType<typeof clinicalDatabase>) => Promise<unknown>]> = [
    ['prescription', 'prescriptions', (db) => db.prescriptions.update(context, patientId, encounterId, orderId,
      { status: OrderStatus.Active, expectedRowVersion: 2, changeReason: 'Synthetic activation' } as never)],
    ['lab request', 'lab_requests', (db) => db.labRequests.update(context, patientId, encounterId, orderId,
      { status: OrderStatus.Active, expectedRowVersion: 2, changeReason: 'Synthetic activation' } as never)],
  ];
  const cases: Array<readonly [string, OrderStatus, Status, boolean, string, (db: ReturnType<typeof clinicalDatabase>) => Promise<unknown>]> = [];
  for (const [label, table, activate] of ACTIVATIONS) {
    for (const status of STATUSES) {
      cases.push([label, OrderStatus.Draft, status, ['planned', 'in_progress', 'on_hold'].includes(status), table, activate]);
      cases.push([label, OrderStatus.OnHold, status, !['cancelled', 'entered_in_error'].includes(status), table, activate]);
    }
  }

  it.each(cases)('%s from %s on a %s encounter', async (_label, from, status, ok, table, activate) => {
    const db = clinicalDatabase(status, from);
    const write = new RegExp(`^update ehr\\.${table}\\b`, 'i');
    if (ok) {
      await expect(activate(db)).resolves.toMatchObject({ status: OrderStatus.Active });
    } else {
      await expect(activate(db)).rejects.toMatchObject({ status: 409, code: 'ENCOUNTER_NOT_OPEN' });
      expect(db.statements.some((sql) => write.test(sql))).toBe(false);
      expect(db.labApi.acceptEhrOrder).not.toHaveBeenCalled();
    }
    // The encounter is share-locked before the order row: the order the encounter retraction takes its locks in.
    const encounterLock = db.statements.findIndex((sql) => /from ehr\.encounters\b.*\bfor share$/i.test(sql));
    const orderLock = db.statements.findIndex((sql) => new RegExp(`from ehr\\.${table}\\b.*\\bfor update$`, 'i').test(sql));
    expect(encounterLock).toBeGreaterThanOrEqual(0);
    expect(orderLock).toBeGreaterThan(encounterLock);
  });
});

describe('Clinical note create statement', () => {
  // $4 (the creator) is also the signer of a note created signed. Without a
  // cast PostgreSQL deduces text for it inside the CASE and uuid for
  // created_by, and refuses the statement (42P08), so every note create
  // answered 500 whatever its status.
  it.each([NoteStatus.Draft, NoteStatus.Signed])('types the signer as a uuid for a %s note', async (status) => {
    const db = clinicalDatabase('in_progress');
    await db.notes.create(context, patientId, encounterId,
      { noteType: 'progress', title: 'Synthetic note', status, content: 'Synthetic content' } as never, 'note-key-654321');
    const insert = db.statements.find((sql) => /^insert into ehr\.clinical_notes\b/i.test(sql));
    expect(insert).toContain('case when $9 then $4::uuid else null end');
  });
});
