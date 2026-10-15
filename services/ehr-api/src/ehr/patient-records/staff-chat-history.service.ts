import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { AuditService } from '../../audit/audit.service';
import type { ChatReply, ContextBinding } from './patient-chat-history.service';
import { binding, evidenceKey, type Evidence, type EvidenceBinding } from './patient-evidence.types';
import type { StaffChatScope } from './staff-chat-scope.service';
import { StaffEvidenceService } from './staff-evidence.service';

interface SavedExchange { id: string; question: string; reply: ChatReply; createdAt: Date; sourceBindings: EvidenceBinding[] }
@Injectable()
export class StaffChatHistoryService {
  constructor(private readonly evidence: StaffEvidenceService, private readonly audit: AuditService) {}
  bind(scope: StaffChatScope) {
    return {
      start: async (request: HidRequest) => this.run(scope, request, 'start', async client => this.lock(client, scope.patientId)),
      context: async (request: HidRequest, generation: string) => {
        const records = await this.current(scope, request);
        return this.run(scope, request, 'context.read', async client => {
          this.generation(await this.lock(client, scope.patientId), generation);
          await this.prune(client, scope.patientId);
          const exchanges = (await this.readCurrent(client, scope.patientId, records)).filter(e => e.reply.status === 'ready').slice(-4);
          const bindings = new Map<string, EvidenceBinding>();
          for (const exchange of exchanges) for (const b of exchange.sourceBindings) bindings.set(evidenceKey(b), b);
          return { exchanges: exchanges.map(e => ({ question: e.question, answer: e.reply.answer })), bindings: [...bindings.values()] };
        });
      },
      save: async (request: HidRequest, generation: string, question: string, reply: ChatReply, inherited: readonly ContextBinding[] = []) => {
        if (!reply.answer.trim() || reply.answer.length > 4000) throw new DomainProblem(503, 'PATIENT_CHAT_UNAVAILABLE', 'Record chat is temporarily unavailable');
        const refs: EvidenceBinding[] = [];
        for (const b of inherited) {
          if (!('kind' in b)) this.changed();
          refs.push(b);
        }
        for (const source of reply.sources) {
          if (!('kind' in source) || !('hash' in source) || typeof source.hash !== 'string') this.changed();
          refs.push(source as EvidenceBinding);
        }
        const records = await this.current(scope, request, refs);
        const current = new Map(records.map(r => [evidenceKey(r), r]));
        const bindings = new Map<string, EvidenceBinding>();
        for (const b of refs) {
          const r = current.get(evidenceKey(b));
          if (!r || r.version !== b.version || r.hash !== b.hash) this.changed();
          bindings.set(evidenceKey(r), binding(r));
        }
        const safeReply = { ...reply, sources: reply.sources.map(source => {
          const { hash: _hash, ...safe } = source as unknown as Record<string, unknown>; return safe;
        }) };
        await this.run(scope, request, 'history.save', async client => {
          this.generation(await this.lock(client, scope.patientId), generation);
          await client.query(`insert into ehr.staff_chat_messages(patient_id,generation,question,reply,source_bindings)
            values($1,$2,$3,$4::jsonb,$5::jsonb)`, [scope.patientId, generation, question, JSON.stringify(safeReply), JSON.stringify([...bindings.values()])]);
          await this.prune(client, scope.patientId);
        });
      },
    };
  }
  async read(scope: StaffChatScope, request: HidRequest) {
    const records = await this.current(scope, request);
    return this.run(scope, request, 'history.read', async client => {
      await this.lock(client, scope.patientId); await this.prune(client, scope.patientId);
      const exchanges = await this.readCurrent(client, scope.patientId, records);
      return { exchanges: exchanges.map(({ sourceBindings: _bindings, ...e }) => e), retentionDays: 30, limit: 10 };
    });
  }
  clear(scope: StaffChatScope, request: HidRequest) {
    return this.run(scope, request, 'history.clear', async client => {
      await this.lock(client, scope.patientId);
      await client.query('delete from ehr.staff_chat_messages where patient_id=$1', [scope.patientId]);
      await client.query('update ehr.staff_chat_state set generation=$2 where patient_id=$1', [scope.patientId, randomUUID()]);
      return { cleared: true };
    });
  }
  private async current(scope: StaffChatScope, request: HidRequest, extra: readonly EvidenceBinding[] = []) {
    const stored = await this.run(scope, request, 'history.bindings.read', async client =>
      (await client.query(`select source_bindings as bindings from ehr.staff_chat_messages where patient_id=$1
        and created_at>statement_timestamp()-interval '30 days' order by created_at desc,id desc limit 10`, [scope.patientId])).rows);
    const ids = [...new Set([...stored.flatMap(r => r.bindings as EvidenceBinding[]), ...extra]
      .filter(b => ['document', 'attachment'].includes(b.kind)).map(b => b.id))];
    const snapshot = await this.evidence.bind(scope).snapshot(request, undefined, ids);
    if (snapshot.coverage.unavailable.some(s => s.startsWith('Laboratory service unavailable'))
      && stored.some(row => (row.bindings as EvidenceBinding[]).some(b => b.kind === 'lab_result'))) {
      throw new DomainProblem(503, 'CHAT_HISTORY_SOURCE_UNAVAILABLE', 'Saved conversation evidence is temporarily unavailable. Please try again.');
    }
    return snapshot.records;
  }
  private async lock(client: PoolClient, patientId: string): Promise<string> {
    await client.query('insert into ehr.staff_chat_state(patient_id) values($1) on conflict do nothing', [patientId]);
    const row = (await client.query('select generation from ehr.staff_chat_state where patient_id=$1 for update', [patientId])).rows[0];
    if (!row) throw new DomainProblem(403, 'CHAT_ACCESS_DENIED', 'Patient access changed');
    return row.generation;
  }
  private async prune(client: PoolClient, patientId: string) {
    await client.query(`delete from ehr.staff_chat_messages where patient_id=$1 and
      (created_at<=statement_timestamp()-interval '30 days' or id in
      (select id from ehr.staff_chat_messages where patient_id=$1 order by created_at desc,id desc offset 10))`, [patientId]);
  }
  private async readCurrent(client: PoolClient, patientId: string, records: Evidence[]): Promise<SavedExchange[]> {
    const rows = (await client.query(`select id,question,reply,created_at as "createdAt",source_bindings as "sourceBindings"
      from ehr.staff_chat_messages where patient_id=$1 and created_at>statement_timestamp()-interval '30 days'
      and permission_hash=current_setting('app.chat_permission_hash',true)
      order by created_at desc,id desc limit 10`, [patientId])).rows as SavedExchange[];
    const map = new Map(records.map(r => [evidenceKey(r), r]));
    return rows.filter(row => Array.isArray(row.sourceBindings) && row.sourceBindings.every(b => {
      const r = map.get(evidenceKey(b)); return r && r.version === b.version && r.hash === b.hash;
    })).reverse();
  }
  private async run<T>(scope: StaffChatScope, request: HidRequest, action: string, work: (client: PoolClient) => Promise<T>) {
    const auth = await scope.authorize(request);
    return scope.transaction(auth, request.correlationId, async client => {
      const value = await work(client);
      await this.audit.recordWithClient(client, { ...this.evidence.auditScope(scope), correlationId: request.correlationId,
        action: `ehr.staff.chat.${action}`, resourceType: 'staff-patient-chat', outcome: 'success' });
      return value;
    });
  }
  private generation(current: string, supplied: string) {
    if (current !== supplied) throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation was cleared. Please ask again.');
  }
  private changed(): never { throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'The source records changed. Please ask again.'); }
}
