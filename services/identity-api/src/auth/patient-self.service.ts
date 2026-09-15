import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

export function requirePatient(actor: ActorContext | undefined): ActorContext & { patientId: string; sessionId: string } {
  if (actor?.kind !== 'patient' || !actor.patientId || !actor.sessionId) {
    throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  }
  return actor as ActorContext & { patientId: string; sessionId: string };
}

@Injectable()
export class PatientSelfService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  profile(request: HidRequest) { return this.read(request, 'profile'); }
  history(request: HidRequest) { return this.read(request, 'access-history'); }
  authorize(request: HidRequest) { return this.read(request, 'authorize'); }

  private async read(request: HidRequest, operation: 'profile' | 'access-history' | 'authorize') {
    const actor = requirePatient(request.actor);
    const functions = {
      profile: 'patient_self_profile', 'access-history': 'patient_self_access_history', authorize: 'authorize_patient_self',
    } as const;
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const result = await client.query<{ value: unknown }>(
        `select identity.${functions[operation]}($1,$2) as value`, [actor.subject, actor.sessionId],
      );
      const value = result.rows[0]?.value;
      const allowed = value !== null && value !== undefined
        && (operation !== 'authorize' || value === actor.patientId);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: actor.patientId,
        action: `identity.patient.self.${operation}`, resourceType: 'patient-self',
        outcome: allowed ? 'success' : 'denied', purposeOfUse: 'patient-self',
        sourceIp: request.ip, userAgent: request.header('user-agent'),
      });
      // Return denial through the transaction so the denial audit commits.
      return allowed ? operation === 'authorize'
        ? { allowed: true, patientId: actor.patientId, accountId: actor.accountId, subject: actor.subject,
          sessionId: actor.sessionId, expiresAt: new Date(Date.now() + 30_000).toISOString() }
        : value : null;
    }).then((value) => {
      if (value === null) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
      return value;
    });
  }
}
