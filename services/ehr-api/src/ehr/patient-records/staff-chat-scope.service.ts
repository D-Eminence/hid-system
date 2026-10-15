import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DomainProblem } from '../../common/problem';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { clinicalContext } from '../shared/clinical-context';
import type { ChatAuthorization, EvidenceAccess } from './chat-access';
import type { SourceKind } from './patient-evidence.types';

export const STAFF_SOURCE_PERMISSIONS: Record<SourceKind, readonly string[]> = {
  note: ['ehr.note.read'], encounter: ['ehr.encounter.read'], diagnosis: ['ehr.diagnosis.read'],
  prescription: ['ehr.prescription.read'], investigation: ['ehr.lab-request.read'], vital: ['ehr.vital.read'],
  import: ['ehr.note.read'], import_version: ['ehr.note.read'], health_profile: ['ehr.note.read'],
  attachment: ['ehr.note.read', 'ehr.document.read'], document: ['ehr.document.read'],
  lab_result: ['lab.result.released.read'], profile: ['identity.patient.read'],
};
export interface StaffChatScope extends EvidenceAccess {
  patientId: string;
  context: DataAccessContext;
  permissions: readonly string[];
  admissionKey: string;
  allows(kind: SourceKind): boolean;
}
const permissionKey = (permissions: readonly string[]) => [...permissions].sort().join('|');

@Injectable()
export class StaffChatScopeService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService) {}

  async open(request: HidRequest, patientId: string): Promise<StaffChatScope> {
    const context = clinicalContext(request);
    if (context.actor.kind === 'patient' || !context.membershipId || !context.actor.sessionId) this.denied();
    let permissions: readonly string[] | undefined;
    const authorize = async (): Promise<ChatAuthorization> => {
      const fresh = await this.identity.authenticateRequest(request);
      const assignment = fresh.facilities.find(item => item.id === context.facilityId);
      if (fresh.kind === 'patient' || fresh.subject !== context.actor.subject || fresh.accountId !== context.actor.accountId
        || fresh.sessionId !== context.actor.sessionId || !assignment || assignment.membershipId !== context.membershipId
        || !assignment.permissions.includes('ehr.note.read')) this.denied();
      if (permissions && permissionKey(permissions) !== permissionKey(assignment.permissions)) {
        throw new DomainProblem(409, 'CHAT_ACCESS_CHANGED', 'Patient access changed. Reopen this patient record.');
      }
      const decision = await this.identity.staffRecordRead(patientId, context);
      if (!decision.allowed || decision.breakGlass || decision.patientId !== patientId
        || decision.facilityId !== context.facilityId || decision.membershipId !== context.membershipId
        || decision.scope !== 'read_records' || decision.purpose !== 'direct-care') this.denied();
      permissions = [...assignment.permissions];
      return { patientId, subject: fresh.subject, accountId: fresh.accountId, sessionId: fresh.sessionId };
    };
    await authorize();
    const scope: StaffChatScope = {
      patientId, context, permissions: permissions!,
      admissionKey: `staff:${context.actor.accountId}:${context.facilityId}`,
      allows: kind => STAFF_SOURCE_PERMISSIONS[kind].every(permission => permissions!.includes(permission)),
      authorize,
      transaction: async <T>(_auth: ChatAuthorization, _correlationId: string, operation: (client: PoolClient) => Promise<T>) => {
        await authorize();
        return this.database.withTransaction(context, async client => {
          await client.query(`select set_config('app.chat_patient_id',$1,true),set_config('app.chat_account_id',$2,true),
            set_config('app.chat_authorized_until',$3,true),set_config('app.chat_permission_hash',$4,true)`,
          [patientId, context.actor.accountId, new Date(Date.now() + 30_000).toISOString(), createHash('sha256').update(permissionKey(permissions!)).digest('hex')]);
          return operation(client);
        });
      },
    };
    return scope;
  }
  private denied(): never {
    throw new DomainProblem(403, 'CHAT_ACCESS_DENIED', 'Active staff membership and patient consent are required');
  }
}
