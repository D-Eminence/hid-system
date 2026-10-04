import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import type { HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { BedrockAiService } from './bedrock-ai.service';
import { PatientChatService } from './patient-chat.service';
import type { PatientRecordsService } from './patient-records.service';

jest.mock('../../config/environment', () => ({
  getEnvironment: () => ({
    AI_ENABLED: true,
    AI_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
    AI_GENERATION_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6',
  }),
}));

const patientId = '11111111-1111-4111-8111-111111111111';
const auth = { patientId, subject: 'patient-subject', accountId: 'account-id', sessionId: 'session-id', expiresAt: new Date(Date.now() + 30_000).toISOString() };
const request = { actor: { kind: 'patient', patientId }, correlationId: 'chat-test' } as HidRequest;
const note = {
  noteId: '22222222-2222-4222-8222-222222222222', revisionNo: 1, title: 'Visit note',
  content: 'Blood pressure was recorded.', contentLength: 28, contentSha256: 'a'.repeat(64),
  signedAt: new Date(), facilityId: '33333333-3333-4333-8333-333333333333', indexed: false,
};

function setup(initialNotes: typeof note[] = [note]) {
  const query = jest.fn(async (sql: string, _params?: readonly unknown[]) => {
    if (sql.includes('limit 51')) return { rows: initialNotes };
    if (sql.includes('order by embedding.embedding')) return { rows: initialNotes.map(({ indexed, facilityId, contentLength, ...source }) => source) };
    if (sql.includes('select count(*)')) return { rows: [{ count: String(initialNotes.length) }] };
    return { rows: [] };
  });
  const transaction = jest.fn(async (_authorization: unknown, _correlationId: string,
    work: (client: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient));
  const authorizeSelf = jest.fn().mockResolvedValue(auth);
  const embed = jest.fn().mockResolvedValue(Array(1024).fill(0));
  const answer = jest.fn().mockResolvedValue('Your note records blood pressure [1].');
  const audit = jest.fn().mockResolvedValue(undefined);
  const service = new PatientChatService(
    { withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as PatientRecordsService,
    { embed, answer } as unknown as BedrockAiService,
    { recordWithClient: audit } as unknown as AuditService,
  );
  return { service, query, transaction, authorizeSelf, embed, answer, audit };
}

describe('Patient chat authorization and grounding', () => {
  it('queries and indexes only the freshly authorized patient, then returns source references', async () => {
    const { service, query, authorizeSelf, answer } = setup();
    const result = await service.answer(request, 'What does my note say?');
    expect(result).toMatchObject({ status: 'ready', answer: 'Your note records blood pressure [1].',
      sources: [{ number: 1, noteId: note.noteId }] });
    expect(authorizeSelf).toHaveBeenCalledTimes(4);
    for (const [sql, params] of query.mock.calls) {
      if (sql.includes('ehr.patient_record_embeddings') && params) {
        expect(params).toContain(patientId);
      }
    }
    expect(answer).toHaveBeenCalledWith('What does my note say?', expect.arrayContaining([expect.objectContaining({ content: note.content })]), expect.any(AbortSignal));
  });

  it('never calls Bedrock when patient authorization fails', async () => {
    const { service, authorizeSelf, transaction, embed } = setup();
    authorizeSelf.mockRejectedValue(new Error('Patient authorization changed'));
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('Patient authorization changed');
    expect(transaction).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('does not invent an answer when no released records exist', async () => {
    const { service, embed, answer } = setup([]);
    const result = await service.answer(request, 'What medicine am I taking?');
    expect(result).toMatchObject({ status: 'ready', sources: [] });
    expect(embed).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
  });

  it('rejects model citations outside the retrieved source set', async () => {
    const { service, answer } = setup();
    answer.mockResolvedValue('An unsupported claim [2].');
    const result = await service.answer(request, 'What does my note say?');
    expect(result).toMatchObject({ status: 'ready', sources: [] });
    expect(result.answer).not.toContain('unsupported claim');
  });

  it('withholds a generated answer if the source revision changes', async () => {
    const { service, query } = setup();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, params) => sql.includes('select count(*)')
      ? { rows: [{ count: '0' }] } : original(sql, params));
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('source records changed');
  });

  it('withholds the answer if self authorization is revoked after generation', async () => {
    const { service, authorizeSelf, answer } = setup();
    authorizeSelf.mockResolvedValueOnce(auth).mockResolvedValueOnce(auth).mockResolvedValueOnce(auth)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('temporarily unavailable');
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('bounds indexing to four notes before returning preparation status', async () => {
    const notes = Array.from({ length: 5 }, (_, index) => ({ ...note, noteId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` }));
    const { service, embed, answer } = setup(notes);
    await expect(service.answer(request, 'What does my note say?')).resolves.toMatchObject({ status: 'preparing', sources: [] });
    expect(embed).toHaveBeenCalledTimes(4); expect(answer).not.toHaveBeenCalled();
  });

  it('bounds repeated requests for a patient before any provider call', async () => {
    const { service, embed } = setup([]);
    for (let i = 0; i < 10; i += 1) await service.answer(request, 'What does my note say?');
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('wait before asking');
    expect(embed).not.toHaveBeenCalled();
  });

  it('does not expose provider error details', async () => {
    const { service, embed } = setup();
    embed.mockRejectedValue(new Error('private provider payload'));
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('temporarily unavailable');
  });

  it('bounds provider concurrency across distinct patients', async () => {
    const { service, authorizeSelf, transaction, embed } = setup();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    transaction.mockImplementation(async () => { await waiting; return []; });
    for (let i = 0; i < 5; i += 1) authorizeSelf.mockResolvedValueOnce({ ...auth, patientId: `patient-${i}` });
    const pending = Array.from({ length: 4 }, () => service.answer(request, 'What does my note say?'));
    await expect(service.answer(request, 'What does my note say?')).rejects.toThrow('wait before asking');
    finish(); await Promise.all(pending);
    expect(embed).not.toHaveBeenCalled();
  });
});
