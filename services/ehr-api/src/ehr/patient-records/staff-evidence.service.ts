import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { LabApiService } from '../../integrations/lab-api.service';
import { AuditService } from '../../audit/audit.service';
import { STAFF_EVIDENCE_QUERY, evidenceQuery } from './patient-evidence.query';
import { patientEntriesEnabled } from '../patient-entries/patient-entries.flag';
import { PatientAttachmentTextService, attachmentTextQuery } from './patient-attachment-text.service';
import { evidence, evidenceKey, originLabel, type Evidence, type EvidenceBinding, type EvidenceSnapshot, type SourceKind } from './patient-evidence.types';
import type { AttachmentAccess } from './chat-access';
import { STAFF_SOURCE_PERMISSIONS, type StaffChatScope } from './staff-chat-scope.service';

// RLS retains facility/consent filtering; the source permission filter ($4) is
// applied inside SQL before any evidence content can leave the database
// operation. The staff chat gets no patient-chat policy: it keeps refuted
// diagnoses with their notes, request reasons, the correction reason, cancelled
// items (labelled by their status), restricted documents, file names, and the
// patient's name and date of birth. The records the patient added (0116) are
// read only while PATIENT_ENTRIES_ENABLED is on (staffEvidenceQuery(true)).
export { STAFF_EVIDENCE_QUERY };
export const staffEvidenceQuery = (includePatientEntries: boolean) => evidenceQuery('staff', includePatientEntries);
/** The staff document query: staff extraction tables, completed visits, every classification. */
export const STAFF_ATTACHMENT_TEXT_QUERY = attachmentTextQuery('staff');

/** One patient per chat: any row for a different patient refuses the whole read. */
function denyOtherPatient(): never {
  throw new DomainProblem(403, 'CHAT_ACCESS_DENIED', 'This chat can only read the patient whose record is open');
}
function assertOnePatient(rows: readonly { patient_id?: unknown }[], patientId: string) {
  for (const row of rows) if (row.patient_id !== patientId) denyOtherPatient();
}

/** A client whose every returned row that names a patient must name the chat's one patient. */
function onePatientClient(client: PoolClient, patientId: string): PoolClient {
  return new Proxy(client, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
    return async (...args: unknown[]) => {
      const result = await (value as (...a: unknown[]) => Promise<{ rows?: unknown }>).apply(target, args);
      if (Array.isArray(result?.rows)) assertOnePatient((result.rows as Record<string, unknown>[]).filter(r => r && typeof r === 'object' && 'patient_id' in r), patientId);
      return result;
    };
  } });
}

@Injectable()
export class StaffEvidenceService {
  constructor(private readonly attachments: PatientAttachmentTextService, private readonly lab: LabApiService,
    private readonly audit: AuditService,private readonly identity:IdentityApiService) {}

  private documents(scope: StaffChatScope): AttachmentAccess {
    return { ...scope, query: STAFF_ATTACHMENT_TEXT_QUERY,
      // Every document row read for this chat must be for the chat's one patient.
      transaction: (auth, correlationId, operation) => scope.transaction(auth, correlationId, client =>
        operation(onePatientClient(client, scope.patientId))),
      table: kind => {
        if (kind === 'attachment') return 'ehr.staff_attachment_extractions';
        if (kind === 'document') return 'ehr.staff_document_extractions';
        throw new Error('Unknown extraction kind');
      } };
  }
  bind(scope: StaffChatScope) {
    return {
      prepareDocuments: async (request: HidRequest, signal: AbortSignal): Promise<string[]> => {
        if (!scope.allows('document') || !scope.allows('attachment')) return [];
        try { await this.attachments.prepare(request, signal, this.documents(scope)); return []; }
        catch (error) {
          if (signal.aborted || (error instanceof DomainProblem && error.getStatus() < 500)) throw error;
          return ['Document extraction unavailable; some attachment contents are not included'];
        }
      },
      snapshot: (request: HidRequest, signal?: AbortSignal, ids?: readonly string[]) => this.snapshot(scope, request, signal, ids),
      assertCurrent: async (request: HidRequest, bindings: readonly EvidenceBinding[]) => {
        const current = await this.snapshot(scope, request, undefined,
          bindings.filter(b => ['document', 'attachment'].includes(b.kind)).map(b => b.id));
        const map = new Map(current.records.map(r => [evidenceKey(r), r]));
        for (const b of bindings) {
          const r = map.get(evidenceKey(b));
          if (!r || r.version !== b.version || r.hash !== b.hash) {
            throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'The source records changed or became unavailable. Please ask again.');
          }
        }
        await scope.authorize(request);
      },
    };
  }
  async source(scope: StaffChatScope, request: HidRequest, kind: string, id: string) {
    if (!(kind in STAFF_SOURCE_PERMISSIONS) || !Object.hasOwn(STAFF_SOURCE_PERMISSIONS, kind)
      || !scope.allows(kind as SourceKind)) throw new DomainProblem(404, 'CHAT_SOURCE_UNAVAILABLE', 'This source is unavailable');
    const snapshot = await this.snapshot(scope, request, undefined, ['attachment', 'document'].includes(kind) ? [id] : []);
    const source = snapshot.records.find(r => r.kind === kind && r.id === id);
    if (!source) throw new DomainProblem(404, 'CHAT_SOURCE_UNAVAILABLE', 'This source is unavailable');
    await scope.authorize(request);
    return { ...source, originLabel: originLabel(source.origin, 'staff') };
  }
  private async snapshot(scope: StaffChatScope, request: HidRequest, signal?: AbortSignal, ids?: readonly string[]): Promise<EvidenceSnapshot> {
    const auth = await scope.authorize(request);
    if (auth.patientId !== scope.patientId) denyOtherPatient();
    // While the setting is off the records the patient added are not a kind
    // at all, so they never make the coverage incomplete.
    const withEntries = patientEntriesEnabled();
    const kinds = (Object.keys(STAFF_SOURCE_PERMISSIONS) as SourceKind[]).filter(kind => withEntries || kind !== 'patient_entry');
    const allowed = kinds.filter(kind => scope.allows(kind));
    const query = staffEvidenceQuery(withEntries);
    const local = await scope.transaction(auth, request.correlationId, async client => {
      const records: Evidence[] = []; let kind = '', id = '', complete = false;
      for (let page = 0; page < 10; page++) {
        signal?.throwIfAborted();
        const rows = (await client.query(query, [scope.patientId, kind, id, allowed])).rows;
        // Defence behind RLS and the $1 filter: a row for any other patient refuses the read.
        assertOnePatient(rows, scope.patientId);
        for (const r of rows.slice(0, 200)) records.push(evidence({ kind: r.kind, id: r.id, version: r.version,
          title: r.title, recordedAt: r.recorded_at ? new Date(r.recorded_at).toISOString() : null,
          effectiveAt: r.effective_at ? new Date(r.effective_at).toISOString() : null,
          provenance: r.provenance, quality: r.quality, fields: r.fields, originHint: r.origin_hint }));
        if (rows.length <= 200) { complete = true; break; }
        kind = rows[199].kind; id = rows[199].id;
      }
      await this.audit.recordWithClient(client, { ...this.auditScope(scope), correlationId: request.correlationId,
        action: 'ehr.staff.chat.evidence.read', resourceType: 'patient-evidence', outcome: 'success',
        details: { recordCount: records.length, complete } });
      return { records, complete };
    });
    const unavailable: string[] = [];
    if (allowed.length < kinds.length) unavailable.push('Some record categories are outside your current read permissions.');
    if(scope.allows('profile')) {
      const profile=await this.identity.staffPatientProfile(scope.patientId,scope.context);
      if(profile.patientId!==scope.patientId)throw new DomainProblem(403,'CHAT_ACCESS_DENIED','Patient profile authorization changed');
      local.records.push(evidence({kind:'profile',id:scope.patientId,version:String(profile.version),title:'Patient profile',
        recordedAt:null,effectiveAt:null,provenance:'Health ID patient profile',quality:'recorded',fields:{
          firstName:profile.firstName??null,lastName:profile.lastName??null,fullName:profile.fullName??null,
          dateOfBirth:profile.dateOfBirth??null,gender:profile.gender??null}}));
    }
    let labComplete = false;
    if (scope.allows('lab_result')) {
      try {
        let cursor: string | undefined; const cursors = new Set<string>();
        for (let page = 0; page < 10; page++) {
          signal?.throwIfAborted();
          const result = await this.lab.staffReleasedResults(scope.context, scope.patientId, cursor, signal);
          local.records.push(...result.records.map(r => evidence({ kind: 'lab_result', ...r,
            provenance: 'Released laboratory result', quality: 'verified and released' })));
          if (!result.nextCursor) { labComplete = true; break; }
          if (cursors.has(result.nextCursor)) throw new Error('Repeated Lab cursor');
          cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
      } catch (error) {
        if (signal?.aborted || (error instanceof DomainProblem && [401, 403].includes(error.getStatus()))) throw error;
        local.records = local.records.filter(r => r.kind !== 'lab_result');
        unavailable.push('Laboratory service unavailable; result coverage is unknown.');
      }
    }
    const documents = scope.allows('attachment') && scope.allows('document')
      ? await this.attachments.read(request, signal, ids, this.documents(scope))
      : { records: [], pending: 0, complete: false };
    local.records.push(...documents.records);
    await scope.authorize(request);
    return { records: local.records, coverage: { complete: local.complete && labComplete && documents.complete
      && documents.pending === 0 && unavailable.length === 0, unavailable, pendingDocuments: documents.pending,
      recordCount: local.records.length, selectedCount: 0 } };
  }
  auditScope(scope: StaffChatScope) {
    return { actorType: 'staff' as const, actorSubject: scope.context.actor.subject,
      actorAccountId: scope.context.actor.accountId, actorMembershipId: scope.context.membershipId,
      facilityId: scope.context.facilityId, organizationId: scope.context.actor.facility?.organizationId,
      patientId: scope.patientId, purposeOfUse: 'direct-care' };
  }
}
