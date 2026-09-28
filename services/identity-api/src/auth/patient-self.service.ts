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

  async setAccessPin(request: HidRequest, pin: string) {
    const actor = requirePatient(request.actor);
    await this.database.withSystemTransaction(request.correlationId, async (client) => {
      // `withSystemTransaction` starts as system:auth. Bind the verified
      // patient subject explicitly so `patient_self_session` can enforce the
      // session/subject pair inside the security-definer command.
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const result = await client.query<{ patient_id: string }>(
        'select identity.set_my_patient_access_pin($1, $2, $3) as patient_id',
        [actor.subject, actor.sessionId, pin],
      );
      if (!result.rows[0]?.patient_id) {
        throw new DomainProblem(503, 'PATIENT_PIN_COMMAND_UNAVAILABLE', 'Patient PIN configuration is unavailable');
      }
    });
    // The security-definer command records the durable audit event in the
    // same transaction as the hash/grant change. Never log or return the PIN.
    return { configured: true };
  }

  async revokeAccessPin(request: HidRequest) {
    const actor = requirePatient(request.actor);
    await this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const result = await client.query<{ patient_id: string }>(
        'select identity.revoke_my_patient_access_pin($1, $2) as patient_id',
        [actor.subject, actor.sessionId],
      );
      if (!result.rows[0]?.patient_id) {
        throw new DomainProblem(503, 'PATIENT_PIN_COMMAND_UNAVAILABLE', 'Patient PIN revocation is unavailable');
      }
    });
    return { revoked: true };
  }

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
