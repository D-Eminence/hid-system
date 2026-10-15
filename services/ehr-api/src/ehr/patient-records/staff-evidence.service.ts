import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { LabApiService } from '../../integrations/lab-api.service';
import { AuditService } from '../../audit/audit.service';
import { LOCAL_EVIDENCE_QUERY } from './patient-evidence.query';
import { PatientAttachmentTextService, ATTACHMENT_TEXT_QUERY } from './patient-attachment-text.service';
import { evidence, evidenceKey, type Evidence, type EvidenceBinding, type EvidenceSnapshot, type SourceKind } from './patient-evidence.types';
import type { AttachmentAccess } from './chat-access';
import { STAFF_SOURCE_PERMISSIONS, type StaffChatScope } from './staff-chat-scope.service';

// RLS retains facility/consent filtering; the source permission filter is applied
// inside SQL before any evidence content can leave the database operation.
export const STAFF_EVIDENCE_QUERY = LOCAL_EVIDENCE_QUERY
  .replace('where patient_id=$1 and (kind', 'where patient_id=$1 and kind=any($4::text[]) and (kind')
  .replace("from ehr.diagnoses d where d.verification_status<>'entered_in_error'", "from ehr.diagnoses d where d.verification_status<>'entered_in_error' and exists(select 1 from ehr.encounters e where e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id and e.status='completed')")
  .replace('from ehr.vitals v left join', "from ehr.vitals v join ehr.encounters e on e.id=v.encounter_id and e.patient_id=v.patient_id and e.facility_id=v.facility_id and e.status='completed' left join");

@Injectable()
export class StaffEvidenceService {
  constructor(private readonly attachments: PatientAttachmentTextService, private readonly lab: LabApiService,
    private readonly audit: AuditService,private readonly identity:IdentityApiService) {}

  private documents(scope: StaffChatScope): AttachmentAccess {
    return { ...scope, query: ATTACHMENT_TEXT_QUERY
      .replaceAll('ehr.patient_attachment_extractions', 'ehr.staff_attachment_extractions')
      .replaceAll('ehr.patient_document_extractions', 'ehr.staff_document_extractions')
      .replace("where d.patient_id=$1 and d.status='available'", "where d.patient_id=$1 and d.status='available' and exists(select 1 from ehr.encounters e where e.id=d.encounter_id and e.patient_id=d.patient_id and e.facility_id=d.facility_id and e.status='completed')"),
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
    return source;
  }
  private async snapshot(scope: StaffChatScope, request: HidRequest, signal?: AbortSignal, ids?: readonly string[]): Promise<EvidenceSnapshot> {
    const auth = await scope.authorize(request);
    const allowed = (Object.keys(STAFF_SOURCE_PERMISSIONS) as SourceKind[]).filter(kind => scope.allows(kind));
    const local = await scope.transaction(auth, request.correlationId, async client => {
      const records: Evidence[] = []; let kind = '', id = '', complete = false;
      for (let page = 0; page < 10; page++) {
        signal?.throwIfAborted();
        const rows = (await client.query(STAFF_EVIDENCE_QUERY, [scope.patientId, kind, id, allowed])).rows;
        for (const r of rows.slice(0, 200)) records.push(evidence({ kind: r.kind, id: r.id, version: r.version,
          title: r.title, recordedAt: r.recorded_at ? new Date(r.recorded_at).toISOString() : null,
          effectiveAt: r.effective_at ? new Date(r.effective_at).toISOString() : null,
          provenance: r.provenance, quality: r.quality, fields: r.fields }));
        if (rows.length <= 200) { complete = true; break; }
        kind = rows[199].kind; id = rows[199].id;
      }
      await this.audit.recordWithClient(client, { ...this.auditScope(scope), correlationId: request.correlationId,
        action: 'ehr.staff.chat.evidence.read', resourceType: 'patient-evidence', outcome: 'success',
        details: { recordCount: records.length, complete } });
      return { records, complete };
    });
    const unavailable: string[] = [];
    if (allowed.length < Object.keys(STAFF_SOURCE_PERMISSIONS).length) unavailable.push('Some record categories are outside your current read permissions.');
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
