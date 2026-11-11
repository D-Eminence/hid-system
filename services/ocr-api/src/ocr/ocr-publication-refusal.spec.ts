import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { EhrApiService } from '../integrations/ehr-api.service';
import type { IdentityApiService } from '../integrations/identity-api.service';
import type { LabApiService } from '../integrations/lab-api.service';
import type { PharmacyApiService } from '../integrations/pharmacy-api.service';
import type { CreateOcrPublicationDto } from './dto/create-ocr-publication.dto';
import type { OcrPublicationSwitch } from './ocr-publication-switch';
import type { OcrReadingSwitch } from './ocr-reading-switch';
import { OcrService } from './ocr.service';

// Publishing needs the publisher's own direct-care write_records grant, for
// every target. A caller who can read the job but has no such grant (a
// records-processing cover holder) gets 403 OCR_PUBLISH_NEEDS_DIRECT_CARE;
// one who cannot read it gets 404, as before; break-glass stays refused with
// 404. Fictional ids throughout.

const context = {
  correlationId: 'ocr-publish-refusal-correlation', facilityId: '10000000-0000-4000-8000-000000000001',
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care',
  actor: { id: 'actor', subject: 'staff:migrate', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['nurse'], permissions: ['ocr.publication.write'], facilityIds: [], facilities: [],
    authenticationMethod: 'local' },
  authorization: 'Bearer test',
} satisfies DataAccessContext;

const patientId = '50000000-0000-4000-8000-000000000001';
const documentId = '60000000-0000-4000-8000-000000000001';
const jobId = '70000000-0000-4000-8000-000000000001';
const validationId = '90000000-0000-4000-8000-000000000001';
const confirmationId = 'b0000000-0000-4000-8000-000000000001';
const publicationId = 'a0000000-0000-4000-8000-000000000001';
const noteId = 'd0000000-0000-4000-8000-000000000001';

const job = { id: jobId, facility_id: context.facilityId, document_id: documentId, patient_id: null,
  status: 'validated', provider: 'test', attempt_count: 1, max_attempts: 3,
  row_version: '5', created_at: new Date('2026-10-09T10:00:00Z'), confirmed_patient_id: patientId };
const grantId = 'e0000000-0000-4000-8000-000000000001';
const confirmer = '20000000-0000-4000-8000-000000000009';
const targets = {
  EHR: { operation: 'create_imported_clinical_note', candidate_type: 'clinical_note',
    accepted_fields: { encounterId: 'c0000000-0000-4000-8000-000000000001', noteType: 'progress',
      title: 'Imported note', content: 'Fictional clinical text' } },
  LAB: { operation: 'create_imported_lab_evidence', candidate_type: 'lab_document',
    accepted_fields: { observations: [{ testName: 'Haemoglobin', value: '12.5', unit: 'g/dL' }] } },
  PHARMACY: { operation: 'create_imported_medication_evidence', candidate_type: 'medication_list',
    accepted_fields: { medications: [
      { medicationText: 'Paracetamol', strengthText: '500 mg', frequencyText: 'tds', page: 1,
        historicalContext: 'Paracetamol 500mg tds x 3/7' },
      { medicationText: 'Amoxicillin', doseText: '1 cap', page: 1, historicalContext: 'Amoxil 1 cap bd' }] } },
  DOCUMENT_ONLY: { operation: 'retain_validated_document', candidate_type: 'document_only',
    accepted_fields: { note: 'Fictional text' } },
} as const;
type Domain = keyof typeof targets;
const confirmation = { id: confirmationId, job_id: jobId, patient_id: patientId, confirmation_version: 1,
  method: 'source_document', created_at: new Date('2026-10-09T10:05:30Z'), request_sha256: 'c'.repeat(64),
  confirmed_by: confirmer };
const source = { id: documentId, patientId, facilityId: context.facilityId, status: 'available',
  scanStatus: 'clean', objectVersionId: 'object-version-1', sha256Hex: 'a'.repeat(64) };

interface Access {
  /** EHR's answer to the source read: the source, or a refusal status. */
  source: 'visible' | 404 | 403;
  write: { allowed: boolean; breakGlass?: boolean };
  /** Identity's answer at the execution attempt, when it differs from the one at the request (a grant revoked). */
  attemptWrite?: { allowed: boolean; breakGlass?: boolean };
  /** identity.records_processing_write_grant's answer (0112): the dedicated grant, or none (the default). */
  grant?: string | null;
  /** Its answer at the execution attempt, when it differs. */
  attemptGrant?: string | null;
  /** EHR's answer to the source read under healthcare-operations (default: the same source). */
  draftSource?: 'visible' | 'another patient' | 404;
  /** The validated reading names no visit. */
  noVisit?: boolean;
  /** A document-only reading with no typed text. */
  noText?: boolean;
}

type Rows = { rows: unknown[]; rowCount: number };
const rows = (items: unknown[]): Rows => ({ rows: items, rowCount: items.length });

function harness(domain: Domain, access: Access) {
  const target = targets[domain];
  const validation = { id: validationId, job_id: jobId, facility_id: context.facilityId,
    extraction_id: '80000000-0000-4000-8000-000000000001', validation_version: 1, disposition: 'validated',
    target_domain: domain, candidate_type: target.candidate_type,
    accepted_fields: access.noVisit && domain === 'EHR'
      ? { noteType: 'progress', title: 'Imported note', content: 'Fictional clinical text' }
      : access.noText ? {} : target.accepted_fields,
    rejected_fields: [], corrections: [], reason: 'Reviewed', validated_by: context.actor.accountId,
    created_at: new Date('2026-10-09T10:05:00Z'), document_id: documentId, patient_id: null, job_status: 'validated' };
  const publication = { id: publicationId, job_id: jobId, validation_id: validationId, validation_version: 1,
    patient_confirmation_id: confirmationId, facility_id: context.facilityId, patient_id: patientId,
    target_domain: domain, target_operation: target.operation, status: 'pending',
    request_sha256: 'a'.repeat(64), attempt_count: 0, max_attempts: 3, target_resource_type: null,
    target_resource_id: null, failure_code: null, failure_summary: null, row_version: '1',
    requested_at: new Date('2026-10-09T10:06:00Z'), completed_at: null };
  let grantChecks = 0;
  const route = (sql: string, params: unknown[] = []): Rows => {
    if (sql.includes('identity.records_processing_write_grant')) {
      grantChecks += 1;
      const answer = grantChecks > 1 && access.attemptGrant !== undefined ? access.attemptGrant : access.grant ?? null;
      return rows([{ id: answer }]);
    }
    if (sql.includes('for key share')) return rows([{ id: jobId }]);
    if (/from ocr\.jobs\s+where id = \$1/.test(sql)) return rows([job]);
    if (sql.includes('on job.id=validation.job_id')) return rows([validation]);
    if (sql.includes('from ocr.patient_confirmations where id=$1')) return rows([confirmation]);
    if (sql.includes('insert into ocr.outbox_events')) return rows([]);
    if (sql.includes('from ocr.publications where facility_id=$1')) return rows([]);
    if (sql.includes('select id::text from ocr.publications where validation_id=$1')) return rows([]);
    if (sql.includes('insert into ocr.publications')) return rows([publication]);
    if (sql.includes("update ocr.publications set status='processing'")) {
      return rows([{ ...publication, status: 'processing', attempt_count: 1, row_version: '2' }]);
    }
    if (sql.includes("update ocr.publications set status='published'")) {
      return rows([{ ...publication, status: 'published', row_version: '3', target_resource_type: params[2],
        target_resource_id: params[3] }]);
    }
    if (sql.includes('update ocr.publications set') && sql.includes("'failed'")) {
      return rows([{ ...publication, status: 'failed', attempt_count: 1, row_version: '3',
        failure_code: params.find((value) => typeof value === 'string' && /^[A-Z_]+$/.test(value)) ?? null }]);
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };
  const clients: PoolClient[] = [];
  const database = { withTransaction: jest.fn(async <T>(_context: DataAccessContext,
    operation: (db: PoolClient) => Promise<T>) => {
    const client = { query: jest.fn(async (sql: string, params?: unknown[]) => route(sql, params)) } as unknown as PoolClient;
    clients.push(client);
    return operation(client);
  }) } as unknown as DatabaseService;
  const ehrApi = {
    getOcrDocumentSource: jest.fn(async (_document: string, call: DataAccessContext) => {
      const answer = call.purposeOfUse === 'healthcare-operations' ? access.draftSource ?? 'visible' : access.source;
      if (answer === 'visible') return source;
      if (answer === 'another patient') return { ...source, patientId: '50000000-0000-4000-8000-000000000002' };
      throw new DomainProblem(answer, 'DOCUMENT_REFUSED', 'Document was not available');
    }),
    createOcrClinicalNote: jest.fn(async (_patient: string, _input: unknown, _call: DataAccessContext, _key: string) =>
      ({ id: noteId, status: 'draft' })),
  };
  let writeChecks = 0;
  const identity = { authorize: jest.fn(async () => {
    writeChecks += 1;
    const answer = writeChecks > 1 && access.attemptWrite ? access.attemptWrite : access.write;
    return { allowed: answer.allowed, breakGlass: answer.breakGlass ?? false };
  }) };
  const labApi = { createOcrImport: jest.fn(async () => ({ id: 'f0000000-0000-4000-8000-000000000001' })) };
  const pharmacyApi = { createOcrImport: jest.fn(async () => ({ id: 'f0000000-0000-4000-8000-000000000002' })),
    createOcrImportBatch: jest.fn(async () => ({ id: 'f0000000-0000-4000-8000-000000000003',
      items: [{ id: 'f0000000-0000-4000-8000-000000000004' }, { id: 'f0000000-0000-4000-8000-000000000005' }], count: 2 })) };
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const service = new OcrService(database, identity as unknown as IdentityApiService,
    audit as unknown as AuditService, ehrApi as unknown as EhrApiService,
    labApi as unknown as LabApiService, pharmacyApi as unknown as PharmacyApiService,
    { enabled: true } as OcrPublicationSwitch, { aiReadingOn: false } as OcrReadingSwitch);
  const publish = () => service.createPublication(validationId,
    { validationVersion: 1, patientConfirmationId: confirmationId,
      targetOperation: target.operation as CreateOcrPublicationDto['targetOperation'], purpose: 'direct-care' },
    'ocr-publish-refusal-key-0001', context);
  const sql = () => clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls
    .map(([text]) => text as string));
  const nothingWritten = () => {
    expect(sql().some((text) => text.includes('insert into ocr.publications'))).toBe(false);
    expect(ehrApi.createOcrClinicalNote).not.toHaveBeenCalled();
    expect(labApi.createOcrImport).not.toHaveBeenCalled();
    expect(pharmacyApi.createOcrImport).not.toHaveBeenCalled();
    expect(pharmacyApi.createOcrImportBatch).not.toHaveBeenCalled();
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  };
  const grantQueries = () => clients.flatMap((client) => (client.query as unknown as jest.Mock).mock.calls)
    .filter(([text]) => String(text).includes('records_processing_write_grant'));
  const auditDetails = (action: string) => audit.recordWithClient.mock.calls
    .map((call) => (call as unknown[])[1] as { action: string; details?: Record<string, unknown>; purposeOfUse?: string })
    .find((event) => event.action === action);
  return { publish, ehrApi, labApi, pharmacyApi, identity, audit, sql, nothingWritten, grantQueries, auditDetails };
}

async function refusal(run: () => Promise<unknown>): Promise<DomainProblem> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('The publication was not refused');
}

describe('OCR publication refusals', () => {
  it('publishes an EHR note under the publisher\'s own direct-care write grant, under direct-care', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true } });
    await expect(run.publish()).resolves.toMatchObject({ status: 'published', targetResourceId: noteId });
    expect(run.identity.authorize.mock.calls.map((call) => (call as unknown[]).slice(1, 3)))
      .toEqual([['write_records', 'direct-care'], ['write_records', 'direct-care']]);
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]?.[2]).toMatchObject({ purposeOfUse: 'direct-care' });
  });

  it.each(['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY'] as const)(
    'answers 403 OCR_PUBLISH_NEEDS_DIRECT_CARE for %s to a caller who can read the job but has no direct-care write',
    async (domain) => {
      const run = harness(domain, { source: 'visible', write: { allowed: false } });
      const problem = await refusal(run.publish);
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([403, 'OCR_PUBLISH_NEEDS_DIRECT_CARE',
        'Ask a clinician with access to this patient to publish it.']);
      expect(run.identity.authorize).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', context);
      run.nothingWritten();
    });

  it.each([404, 403] as const)('keeps 404 OCR_JOB_NOT_FOUND when EHR answers the source with %s', async (status) => {
    const run = harness('EHR', { source: status, write: { allowed: true } });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    expect(run.identity.authorize).not.toHaveBeenCalled();
    run.nothingWritten();
  });

  it.each(['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY'] as const)(
    'still refuses a break-glass write for %s as before, with 404 OCR_JOB_NOT_FOUND', async (domain) => {
    const run = harness(domain, { source: 'visible', write: { allowed: true, breakGlass: true } });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    run.nothingWritten();
  });

  it('refuses at the execution attempt when the grant is gone after the request: failed with the code, audited, nothing written', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true }, attemptWrite: { allowed: false } });
    const outcome = await run.publish().then((value) => ({ value }), (error: unknown) => ({ error }));
    expect(run.identity.authorize).toHaveBeenCalledTimes(2);
    expect(run.ehrApi.createOcrClinicalNote).not.toHaveBeenCalled();
    expect(run.sql().some((text) => text.includes('update ocr.publications set') && text.includes("'failed'"))).toBe(true);
    const failedAudit = run.audit.recordWithClient.mock.calls.map((call) => JSON.stringify(call))
      .find((text) => text.includes('ocr.publication.fail'));
    expect(failedAudit).toContain('OCR_PUBLISH_NEEDS_DIRECT_CARE');
    if ('error' in outcome) {
      expect((outcome.error as DomainProblem).code).toBe('OCR_PUBLISH_NEEDS_DIRECT_CARE');
    } else {
      expect(outcome.value).toMatchObject({ status: 'failed' });
    }
  });

  it('asks the dedicated-grant check, for the session\'s own subject, membership and facility, before a 403', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: false } });
    await refusal(run.publish);
    expect(run.grantQueries().map(([, params]) => params)).toEqual([[patientId, context.actor.subject,
      context.membershipId, context.facilityId]]);
  });
});

// 0112 (owner decision of 2026-11-11, Option B): the patient's dedicated
// records-processing grant publishes a clinical-note reading as a draft into
// the "Imported paper records" encounter; never through shares or PINs (the
// SQL check answers none for them, as the cases above with grant: null).
describe('OCR publication under the dedicated records-processing grant', () => {
  it('publishes an EHR reading as a draft under healthcare-operations, with no visit, naming the grant and both actors', async () => {
    const run = harness('EHR', { source: 404, write: { allowed: false }, grant: grantId });
    await expect(run.publish()).resolves.toMatchObject({ status: 'published', targetResourceId: noteId });
    // Hidden under direct care: Identity is not asked for a direct-care write.
    expect(run.identity.authorize).not.toHaveBeenCalled();
    const [patient, input, call, key] = run.ehrApi.createOcrClinicalNote.mock.calls[0]!;
    expect([patient, key]).toEqual([patientId, `ocr-publication:${publicationId}`]);
    expect(call).toMatchObject({ purposeOfUse: 'healthcare-operations', membershipId: context.membershipId });
    expect(input).not.toHaveProperty('encounterId');
    expect(input).toMatchObject({ confirmedBy: confirmer, noteType: 'progress', title: 'Imported note' });
    const actors = { basis: 'records_processing_grant', grantId, confirmedBy: confirmer, publishedBy: context.actor.accountId };
    expect(run.auditDetails('ocr.publication.request')).toMatchObject({ purposeOfUse: 'healthcare-operations',
      details: expect.objectContaining(actors) });
    expect(run.auditDetails('ocr.publication.succeed')?.details).toMatchObject(actors);
  });

  it('the same person who confirmed the patient may publish', async () => {
    const run = harness('EHR', { source: 404, write: { allowed: false }, grant: grantId });
    await run.publish();
    expect(run.auditDetails('ocr.publication.succeed')?.details).toMatchObject({ confirmedBy: confirmer });
  });

  it('a cover holder who also has the dedicated grant: the draft path, not a direct-care note in the chosen visit', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: false }, grant: grantId });
    await expect(run.publish()).resolves.toMatchObject({ status: 'published' });
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![1]).not.toHaveProperty('encounterId');
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![2]).toMatchObject({ purposeOfUse: 'healthcare-operations' });
  });

  it.each([
    ['LAB', 'Lab results', '- Haemoglobin: 12.5 g/dL'],
    ['PHARMACY', 'Medicines',
      '- Paracetamol 500 mg tds\n  As written: Paracetamol 500mg tds x 3/7\n- Amoxicillin 1 cap\n  As written: Amoxil 1 cap bd'],
    ['DOCUMENT_ONLY', 'Document', 'note: Fictional text'],
  ] as const)('publishes a %s reading under the dedicated grant as a labelled draft note, never a structured record',
    async (domain, title, content) => {
      const run = harness(domain, { source: 404, write: { allowed: false }, grant: grantId });
      await expect(run.publish()).resolves.toMatchObject({ status: 'published', targetResourceId: noteId,
        targetResourceType: 'clinical-note' });
      const [patient, input, call] = run.ehrApi.createOcrClinicalNote.mock.calls[0]!;
      expect(patient).toBe(patientId);
      expect(call).toMatchObject({ purposeOfUse: 'healthcare-operations' });
      expect(input).not.toHaveProperty('encounterId');
      expect(input).toMatchObject({ noteType: 'imported_paper_record', title, content, publicationId,
        documentId, validationId, confirmedBy: confirmer });
      expect(run.labApi.createOcrImport).not.toHaveBeenCalled();
      expect(run.pharmacyApi.createOcrImport).not.toHaveBeenCalled();
      expect(run.pharmacyApi.createOcrImportBatch).not.toHaveBeenCalled();
      expect(run.auditDetails('ocr.publication.succeed')?.details).toMatchObject({ basis: 'records_processing_grant',
        grantId, targetResourceType: 'clinical-note' });
    });

  it.each(['LAB', 'PHARMACY'] as const)('a %s reading under direct care is still the structured record, not a note',
    async (domain) => {
      const run = harness(domain, { source: 'visible', write: { allowed: true } });
      await expect(run.publish()).resolves.toMatchObject({ status: 'published' });
      expect(run.ehrApi.createOcrClinicalNote).not.toHaveBeenCalled();
      const structured = domain === 'LAB' ? run.labApi.createOcrImport : run.pharmacyApi.createOcrImportBatch;
      expect(structured).toHaveBeenCalledTimes(1);
    });

  it('a document-only reading with no typed text says so, and no text is made up', async () => {
    const run = harness('DOCUMENT_ONLY', { source: 404, write: { allowed: false }, grant: grantId, noText: true });
    await run.publish();
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![1]).toMatchObject({
      content: 'A paper record kept as a document; the reviewer typed no text from it.' });
  });

  it('refuses when the source read under records processing names another patient', async () => {
    const run = harness('EHR', { source: 404, write: { allowed: false }, grant: grantId, draftSource: 'another patient' });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    run.nothingWritten();
  });

  it('keeps 404 for a caller with neither direct care nor the dedicated grant', async () => {
    const run = harness('EHR', { source: 404, write: { allowed: false }, grant: null });
    const problem = await refusal(run.publish);
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OCR_JOB_NOT_FOUND']);
    run.nothingWritten();
  });

  it('refuses at the execution attempt when the dedicated grant is gone: failed with the code, nothing written in EHR', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: false }, grant: grantId, attemptGrant: null });
    const outcome = await run.publish().then(() => undefined, (error: unknown) => error as DomainProblem);
    expect(outcome?.code).toBe('OCR_PUBLISH_NEEDS_DIRECT_CARE');
    expect(run.ehrApi.createOcrClinicalNote).not.toHaveBeenCalled();
    expect(JSON.stringify(run.auditDetails('ocr.publication.fail'))).toContain('OCR_PUBLISH_NEEDS_DIRECT_CARE');
  });

  it('a direct-care publisher of a reading with no visit: the imported encounter under direct care, basis direct_care', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true }, noVisit: true });
    await expect(run.publish()).resolves.toMatchObject({ status: 'published' });
    expect(run.grantQueries()).toEqual([]);
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![1]).not.toHaveProperty('encounterId');
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![2]).toMatchObject({ purposeOfUse: 'direct-care' });
    expect(run.auditDetails('ocr.publication.succeed')?.details).toMatchObject({ basis: 'direct_care' });
  });

  it('a direct-care publisher with a visit: unchanged, that visit', async () => {
    const run = harness('EHR', { source: 'visible', write: { allowed: true } });
    await run.publish();
    expect(run.ehrApi.createOcrClinicalNote.mock.calls[0]![1])
      .toMatchObject({ encounterId: 'c0000000-0000-4000-8000-000000000001' });
  });
});
