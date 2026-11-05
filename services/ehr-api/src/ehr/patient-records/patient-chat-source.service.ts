import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { PatientChatHistoryService } from './patient-chat-history.service';
import { sourceView,type PatientSourceView } from './patient-chat-safety';
import { PatientRecordsService } from './patient-records.service';
import { SOURCE_KINDS,evidenceKey,type SourceKind } from './patient-evidence.types';

const unavailable = () => new DomainProblem(404, 'CHAT_SOURCE_UNAVAILABLE', 'This source is unavailable');

/**
 * The patient's chat source viewer. A patient can open only a source that a
 * current saved answer cites, and only while it is unchanged in their cleaned
 * evidence. The view is built for reading: no hash, content, raw fields or
 * encounter ids.
 */
@Injectable()
export class PatientChatSourceService {
  constructor(private readonly records: PatientRecordsService, private readonly history: PatientChatHistoryService,
    private readonly database: DatabaseService,
    private readonly audit: AuditService) {}

  async view(request: HidRequest, kind: string, id: string): Promise<PatientSourceView> {
    if (!(SOURCE_KINDS as readonly string[]).includes(kind)) throw unavailable();
    const key = evidenceKey({ kind: kind as SourceKind, id });
    const first = await this.records.authorizeSelf(request);
    // One snapshot serves both the cited check and the lookup.
    const history = await this.history.citedBindings(request, kind === 'document' || kind === 'attachment' || kind === 'patient_entry_document' ? [id] : []);
    const cited = history.cited.get(key);
    if (!cited) {
      // A source whose saved answer cannot be checked while a service (Lab) is down.
      if (history.unavailable.length) throw new DomainProblem(503, 'CHAT_HISTORY_SOURCE_UNAVAILABLE',
        'Saved conversation evidence is temporarily unavailable. Please try again.');
      throw unavailable();
    }
    const source = history.records.find(r => evidenceKey(r) === key);
    if (!source || source.version !== cited.version || source.hash !== cited.hash) throw unavailable();
    const auth = await this.records.authorizeSelf(request);
    if (auth.patientId !== first.patientId) throw unavailable();
    await this.database.withPatientTransaction(auth, request.correlationId, client => this.audit.recordWithClient(client, {
      correlationId: request.correlationId, actorType: 'patient', actorSubject: auth.subject, actorAccountId: auth.accountId,
      patientId: auth.patientId, action: 'ehr.patient.chat.source.read', resourceType: 'patient-evidence', outcome: 'success',
      purposeOfUse: 'patient-self', details: { kind, sourceId: id } }));
    return sourceView(source);
  }
}
