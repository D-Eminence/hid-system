import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { ConsultationDraftsController, MyConsultationDraftsController } from './consultation-drafts.controller';
import { CreateConsultationDraftDto, SaveConsultationDraftDto } from './consultation-drafts.dto';
import { checkDraftContent, ConsultationDraftSweeper, ConsultationDraftsService, DRAFT_SAVES_PER_MINUTE } from './consultation-drafts.service';

// EHR-C6 (0141, owner decision Q126 A). Author-only access, the times, the
// size and version rules and the sweeper's deletes are the database's
// (services/ehr-api/test/database/consultation-drafts.integration.sql); this
// is the route around them. Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const draftId = '123e4567-e89b-42d3-a456-426614174071';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { accountId: membershipId, subject: 'staff:test', facility: { organizationId: facilityId } } } as unknown as DataAccessContext;
const stored = { draftId, encounterId, formVersion: 1, rowVersion: '1', sizeBytes: 34,
  createdAt: new Date('2026-11-20T10:00:00Z'), savedAt: new Date('2026-11-20T10:00:00Z'), expiresAt: new Date('2026-11-27T10:00:00Z') };

function harness(answers: { [pattern: string]: unknown[] | Error } = {}) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
    for (const [pattern, rows] of Object.entries(answers)) {
      if (new RegExp(pattern).test(sql)) {
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length };
      }
    }
    return { rows: [], rowCount: 0 };
  }) };
  const events: Record<string, unknown>[] = [];
  const repository = {
    run: jest.fn(async (_context: unknown, _patient: string, access: string, event: Record<string, unknown>,
      operation: (client: PoolClient) => Promise<{ value: unknown; details?: unknown }>, lookup?: (c: PoolClient) => Promise<boolean>) => {
      if (lookup && !(await lookup(client as unknown as PoolClient))) {
        throw new DomainProblem(404, 'CLINICAL_RESOURCE_NOT_FOUND', 'Clinical resource was not found');
      }
      const result = await operation(client as unknown as PoolClient);
      events.push({ access, ...event, details: { ...(event.details as object), ...(result.details as object) } });
      return result.value;
    }),
    executeCreate: jest.fn(async (_client: unknown, _context: unknown, _patient: unknown, _key: unknown, _operation: unknown,
      _digest: unknown, _type: unknown, create: () => Promise<{ value: unknown }>) => create()),
    encounterExists: jest.fn(async () => true),
  };
  const database = {
    withTransaction: jest.fn(async (_context: unknown, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(client as unknown as PoolClient)),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: PoolClient) => Promise<unknown>) =>
      operation(client as unknown as PoolClient)),
  };
  const service = new ConsultationDraftsService(repository as unknown as ClinicalRepository,
    database as unknown as DatabaseService);
  return { service, statements, repository, database, events };
}

describe('EHR-C6: consultation drafts', () => {
  it('every route needs ehr.note.write; GET, POST and PATCH only', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationDraftsController)).toBe('ehr/patients/:patientId/consultation-drafts');
    expect(Reflect.getMetadata(PATH_METADATA, MyConsultationDraftsController)).toBe('ehr/my-consultation-drafts');
    for (const controller of [ConsultationDraftsController, MyConsultationDraftsController]) {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, controller)).toEqual(['ehr.note.write']);
    }
    const methods = ['create', 'list', 'read', 'save', 'discard'].map((name) =>
      Reflect.getMetadata(METHOD_METADATA, (ConsultationDraftsController.prototype as unknown as Record<string, object>)[name]!));
    expect(methods).toEqual([RequestMethod.POST, RequestMethod.GET, RequestMethod.GET, RequestMethod.PATCH, RequestMethod.POST]);
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationDraftsController.prototype.discard)).toBe(':draftId/discard');
  });

  it.each([
    ['a null field', { formVersion: null, content: {} }],
    ['a form version over 1000', { formVersion: 1001, content: {} }],
    ['content that is not an object', { formVersion: 1, content: 'text' }],
    ['a visit that is not a UUID', { formVersion: 1, content: {}, encounterId: 'visit-1' }],
  ])('the body refuses %s (400 VALIDATION_FAILED)', (_label, body) => {
    expect(validateSync(plainToInstance(CreateConsultationDraftDto, body)).length).toBeGreaterThan(0);
  });

  it('a save needs its version', () => {
    expect(validateSync(plainToInstance(SaveConsultationDraftDto, { formVersion: 1, content: {} })).length).toBeGreaterThan(0);
  });

  it.each([
    ['a NUL in a value', { text: 'Synthetic\u0000note' }],
    ['a NUL in a key', { 'key\u0000': 'Synthetic' }],
    ['a lone high surrogate', { text: 'Synthetic \uD83D' }],
    ['a lone low surrogate, deep in an array', { items: [{ text: '\uDE00 Synthetic' }] }],
  ])('content the database cannot store is 400 VALIDATION_FAILED on content: %s', (_label, content) => {
    expect(() => checkDraftContent(content)).toThrow(expect.objectContaining({ status: 400, code: 'VALIDATION_FAILED',
      errors: [{ field: 'content', messages: ['content must not contain a NUL character or an unpaired surrogate'] }] }) as unknown as Error);
  });

  it('content with a paired surrogate (an emoji) is fine', () => {
    expect(() => checkDraftContent({ text: 'Synthetic \uD83D\uDE00' })).not.toThrow();
  });

  it.each(['22P05', '22P02'])('a %s from a draft query is 400 VALIDATION_FAILED on content', async (code) => {
    const failure = Object.assign(new Error('unsupported Unicode escape sequence'), { code });
    const created = harness({ 'insert into ehr.consultation_drafts': failure });
    await expect(created.service.create(context, patientId, { formVersion: 1, content: {} }, 'key-123456789-abcdef'))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED', errors: [{ field: 'content' }] });
    const saved = harness({ '^select 1 from': [{ found: 1 }], 'for update': failure });
    await expect(saved.service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: {} }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('content: at most 256 KB as UTF-8 JSON and 20 levels deep', () => {
    expect(checkDraftContent({ text: 'é'.repeat(100) })).toBe(Buffer.byteLength(JSON.stringify({ text: 'é'.repeat(100) })));
    expect(() => checkDraftContent({ text: 'x'.repeat(262_200) })).toThrow(expect.objectContaining({ status: 400,
      code: 'CONSULTATION_DRAFT_TOO_LARGE' }) as unknown as Error);
    let deep: Record<string, unknown> = {};
    for (let level = 0; level < 20; level += 1) deep = { next: deep };
    expect(() => checkDraftContent(deep)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }) as unknown as Error);
    let fine: Record<string, unknown> = {};
    for (let level = 0; level < 18; level += 1) fine = { next: fine };
    expect(() => checkDraftContent(fine)).not.toThrow();
  });

  it('create: write_records, the visit checked, stored as the author, audited with the size and never the content', async () => {
    const { service, statements, events } = harness({ 'insert into ehr.consultation_drafts': [stored] });
    const answer = await service.create(context, patientId, { encounterId, formVersion: 1,
      content: { chiefComplaint: 'Synthetic cough' } }, 'key-123456789-abcdef');
    expect(answer).toEqual({ draftId, encounterId, formVersion: 1, rowVersion: 1, sizeBytes: 34,
      createdAt: '2026-11-20T10:00:00.000Z', savedAt: '2026-11-20T10:00:00.000Z', expiresAt: '2026-11-27T10:00:00.000Z' });
    expect(events).toEqual([expect.objectContaining({ access: 'write_records', action: 'ehr.consultation-draft.create',
      details: { sizeBytes: 34 } })]);
    expect(statements[0]!.sql).toMatch(/^select status from ehr\.encounters/);
    const insert = statements.find(({ sql }) => sql.startsWith('insert into ehr.consultation_drafts'))!;
    expect(insert.values).toEqual([patientId, facilityId, membershipId, membershipId, encounterId, 1,
      JSON.stringify({ chiefComplaint: 'Synthetic cough' })]);
    expect(JSON.stringify(events)).not.toContain('Synthetic cough');
  });

  it('create on a visit entered in error is 409 VISIT_ENTERED_IN_ERROR', async () => {
    const { service } = harness({ 'select status from ehr.encounters': [{ status: 'entered_in_error' }] });
    await expect(service.create(context, patientId, { encounterId, formVersion: 1, content: {} }, 'key-123456789-abcdef'))
      .rejects.toMatchObject({ status: 409, code: 'VISIT_ENTERED_IN_ERROR' });
  });

  it('a second draft for the visit is 409 CONSULTATION_DRAFT_EXISTS, naming the draft', async () => {
    const { service, statements } = harness({
      'insert into ehr.consultation_drafts': Object.assign(new Error('duplicate key'), { code: '23505' }),
      'select id::text from ehr.consultation_drafts': [{ id: draftId }],
    });
    const failure = await service.create(context, patientId, { encounterId, formVersion: 1, content: {} },
      'key-123456789-abcdef').then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, code: 'CONSULTATION_DRAFT_EXISTS', extensions: { draftId } });
    expect(statements.map(({ sql }) => sql)).toContain('rollback to savepoint consultation_draft_create');
    expect(statements.some(({ sql }) => sql.includes('expire_my_consultation_draft'))).toBe(false);
  });

  it('the author\'s own expired draft for the visit, not yet swept: cleared through 0141, then the insert again', async () => {
    let inserts = 0;
    const statements: string[] = [];
    const { service, repository } = harness();
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('insert into ehr.consultation_drafts')) {
        inserts += 1;
        if (inserts === 1) throw Object.assign(new Error('duplicate key'), { code: '23505' });
        return { rows: [stored], rowCount: 1 };
      }
      if (sql.includes('expire_my_consultation_draft')) return { rows: [{ expired: true }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }) };
    repository.run.mockImplementationOnce(async (_c: unknown, _p: string, _a: string, _e: unknown,
      operation: (c: PoolClient) => Promise<{ value: unknown }>) => (await operation(client as unknown as PoolClient)).value);
    await expect(service.create(context, patientId, { encounterId, formVersion: 1, content: {} }, 'key-123456789-abcdef'))
      .resolves.toMatchObject({ draftId });
    expect(inserts).toBe(2);
    expect(client.query).toHaveBeenCalledWith('select ehr.expire_my_consultation_draft($1::uuid, $2::uuid) as expired',
      [patientId, encounterId]);
  });

  it('a conflict nobody can clear is 409 CONSULTATION_DRAFT_EXISTS with no draftId, after one try', async () => {
    const { service, statements } = harness({
      'insert into ehr.consultation_drafts': Object.assign(new Error('duplicate key'), { code: '23505' }),
      'expire_my_consultation_draft': [{ expired: false }],
    });
    const failure = await service.create(context, patientId, { formVersion: 1, content: {} }, 'key-123456789-abcdef')
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, code: 'CONSULTATION_DRAFT_EXISTS' });
    expect((failure as { extensions?: unknown }).extensions).toBeUndefined();
    expect(statements.filter(({ sql }) => sql.startsWith('insert into ehr.consultation_drafts'))).toHaveLength(1);
  });

  const visible = { '^select 1 from ehr.consultation_drafts': [{ found: 1 }] };

  it('save: write_records; a new version', async () => {
    const { service, statements, events } = harness({ ...visible,
      'for update': [{ ...stored, same: false }],
      'update ehr.consultation_drafts': [{ ...stored, rowVersion: '2' }],
    });
    await expect(service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: { a: 1 } }))
      .resolves.toMatchObject({ rowVersion: 2 });
    expect(events[0]).toMatchObject({ access: 'write_records', action: 'ehr.consultation-draft.update', resourceId: draftId });
    expect(statements[2]!.values).toEqual([draftId, patientId, facilityId, JSON.stringify({ a: 1 }), 1, 1]);
  });

  it('save: a retry of a save that went through answers the stored draft', async () => {
    const { service, statements } = harness({ ...visible, 'for update': [{ ...stored, rowVersion: '2', same: true }] });
    await expect(service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: { a: 1 } }))
      .resolves.toMatchObject({ rowVersion: 2 });
    expect(statements).toHaveLength(2);
  });

  it.each([
    ['another version', { ...visible, 'for update': [{ ...stored, rowVersion: '3', same: false }] }, 409, 'CONSULTATION_DRAFT_CHANGED'],
    ['no such draft (or another member\'s, or expired, or its grant ended)', {}, 404, 'CONSULTATION_DRAFT_NOT_FOUND'],
  ] as const)('save: %s', async (_label, answers, status, code) => {
    const { service } = harness(answers as never);
    await expect(service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: {} }))
      .rejects.toMatchObject({ status, code });
  });

  it('read and save of a draft the author cannot see go through run()\'s scoped lookup (a not_found audit row), as 404 CONSULTATION_DRAFT_NOT_FOUND', async () => {
    const { service, repository, statements } = harness();
    await expect(service.read(context, patientId, draftId)).rejects.toMatchObject({ status: 404, code: 'CONSULTATION_DRAFT_NOT_FOUND' });
    await expect(service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: {} }))
      .rejects.toMatchObject({ status: 404, code: 'CONSULTATION_DRAFT_NOT_FOUND' });
    expect(repository.run.mock.calls.map((call) => typeof call[5])).toEqual(['function', 'function']);
    expect(statements.map(({ sql }) => sql)).toEqual([
      'select 1 from ehr.consultation_drafts where id = $1 and patient_id = $2 and facility_id = $3',
      'select 1 from ehr.consultation_drafts where id = $1 and patient_id = $2 and facility_id = $3']);
    expect(statements[0]!.values).toEqual([draftId, patientId, facilityId]);
  });

  it('a missing visit on create stays 404 CLINICAL_RESOURCE_NOT_FOUND', async () => {
    const { service, repository } = harness();
    repository.encounterExists.mockResolvedValueOnce(false);
    await expect(service.create(context, patientId, { encounterId, formVersion: 1, content: {} }, 'key-123456789-abcdef'))
      .rejects.toMatchObject({ status: 404, code: 'CLINICAL_RESOURCE_NOT_FOUND' });
  });

  it(`save: at most ${DRAFT_SAVES_PER_MINUTE} a minute per member (429)`, async () => {
    const { service } = harness({ ...visible, 'for update': [{ ...stored, same: true, rowVersion: '2' }] });
    for (let save = 0; save < DRAFT_SAVES_PER_MINUTE; save += 1) {
      await service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: {} });
    }
    await expect(service.save(context, patientId, draftId, { expectedRowVersion: 1, formVersion: 1, content: {} }))
      .rejects.toMatchObject({ status: 429, code: 'CONSULTATION_DRAFT_SAVE_LIMITED' });
  });

  it('read and list: read_records; list newest save first, at most 20, without content', async () => {
    const { service, statements, events } = harness({ ...visible, ', content from': [{ ...stored, content: { a: 1 } }],
      'order by saved_at desc': [stored] });
    await expect(service.read(context, patientId, draftId)).resolves.toMatchObject({ draftId, content: { a: 1 } });
    await expect(service.list(context, patientId)).resolves.toEqual({ items: [expect.not.objectContaining({ content: expect.anything() })] });
    expect(events.map((event) => [event.access, event.action])).toEqual([['read_records', 'ehr.consultation-draft.read'],
      ['read_records', 'ehr.consultation-draft.list']]);
    expect(statements[2]!.sql).toContain('order by saved_at desc, id desc limit 20');
  });

  it('discard: no consent check; 0141\'s function deletes and audits; safe to repeat', async () => {
    const { service, repository, statements } = harness({ 'discard_consultation_draft': [{ discarded: true }] });
    await expect(service.discard(context, patientId, draftId)).resolves.toBeUndefined();
    expect(repository.run).not.toHaveBeenCalled();
    expect(statements).toEqual([{ sql: 'select ehr.discard_consultation_draft($1::uuid, $2::uuid) as discarded',
      values: [draftId, patientId] }]);
    const again = harness({ 'discard_consultation_draft': [{ discarded: false }] });
    await expect(again.service.discard(context, patientId, draftId)).resolves.toBeUndefined();
  });

  it('my drafts: cards, hiddenCount (also on an empty list), never a full Health ID', async () => {
    const { service } = harness({ 'list_my_consultation_drafts': [{ draft_id: draftId, encounter_id: null,
      saved_at: stored.savedAt, expires_at: stored.expiresAt, patient_id: patientId, full_name: 'Ada Drafts', sex: 'female',
      date_of_birth: '1984-04-04', health_id_last4: 'A2B3', hidden_count: '1' }] });
    await expect(service.mine(context)).resolves.toEqual({ hiddenCount: 1, items: [{ draftId, encounterId: null,
      savedAt: '2026-11-20T10:00:00.000Z', expiresAt: '2026-11-27T10:00:00.000Z',
      patient: { patientId, fullName: 'Ada Drafts', sex: 'female', dateOfBirth: '1984-04-04', healthIdLast4: 'A2B3' } }] });
    const empty = harness({ 'list_my_consultation_drafts': [{ draft_id: null, hidden_count: '2' }] });
    await expect(empty.service.mine(context)).resolves.toEqual({ items: [], hiddenCount: 2 });
  });

  it.each([
    ['a database without 0141', Object.assign(new Error('relation does not exist'), { code: '42P01' })],
    ['any other failure', new Error('Connection terminated unexpectedly')],
  ])('%s answers 503 CONSULTATION_DRAFTS_UNAVAILABLE', async (_label, error) => {
    const { service } = harness({ 'list_my_consultation_drafts': error, 'discard_consultation_draft': error });
    await expect(service.mine(context)).rejects.toMatchObject({ status: 503, code: 'CONSULTATION_DRAFTS_UNAVAILABLE' });
    await expect(service.discard(context, patientId, draftId)).rejects.toMatchObject({ status: 503 });
  });

  it('the sweeper deletes through 0141\'s function in a system transaction; a failure is logged with no identifier', async () => {
    const ok = harness({ 'sweep_consultation_drafts': [{ swept: 3 }] });
    const sweeper = new ConsultationDraftSweeper(ok.database as unknown as DatabaseService);
    await expect(sweeper.sweep()).resolves.toBe(3);
    expect(ok.statements[0]!.sql).toBe('select ehr.sweep_consultation_drafts(500) as swept');
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing = harness({ 'sweep_consultation_drafts': new Error('down') });
    await expect(new ConsultationDraftSweeper(failing.database as unknown as DatabaseService).sweep()).resolves.toBe(0);
    expect(warn.mock.calls).toEqual([[{ event: 'ehr.consultation_draft.sweep_unavailable' }]]);
    warn.mockRestore();
  });

  it('a problem\'s extensions reach the answer, never over a standard field', () => {
    const json = jest.fn();
    const response: { status: jest.Mock; type: jest.Mock; json: jest.Mock } = { status: jest.fn(), type: jest.fn(), json };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const host = { switchToHttp: () => ({ getRequest: () => ({ correlationId: 'correlation-123456' }), getResponse: () => response }) };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new ProblemDetailsFilter().catch(new DomainProblem(409, 'CONSULTATION_DRAFT_EXISTS', 'You already have a saved draft.',
      undefined, { draftId, code: 'SPOOFED' }), host as never);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONSULTATION_DRAFT_EXISTS', draftId, status: 409 }));
  });
});
