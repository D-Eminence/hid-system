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

  async importedNotifications(request: HidRequest, limit = 50, itemId?: string, offset = 0) {
    const actor = request.actor;
    if (!actor?.sessionId || (actor.kind !== undefined && actor.kind !== 'patient' && actor.kind !== 'staff')) {
      throw new DomainProblem(403, 'SESSION_REQUIRED', 'An active account session is required');
    }
    return this.database.withSystemTransaction(request.correlationId, async client => {
      const kind = actor.kind ?? 'staff';
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const session = await client.query(`select exists(select 1 from auth.sessions s join auth.accounts a on a.id=s.account_id
        where s.id=$1 and s.account_id=$2 and a.subject=$3 and a.status='active' and s.revoked_at is null
            and s.expires_at>clock_timestamp() and s.absolute_expires_at>clock_timestamp()
            and s.account_token_version=a.token_version and (a.disabled_until is null or a.disabled_until<=clock_timestamp())
            and s.session_kind=$4 and ($4<>'patient' or s.patient_id=$5::uuid)) as active`, [actor.sessionId,actor.accountId,actor.subject,kind,actor.patientId??null]);
      if (!session.rows[0]?.active) throw new DomainProblem(403, 'SESSION_REQUIRED', 'An active account session is required');
      const result = itemId
        ? await client.query('select id,read_at as "readAt" from identity.mark_my_imported_notification_read($1)', [itemId])
        : await client.query(`select id,title,message,notification_type as type,read_at as "readAt",created_at as "createdAt"
              from identity.list_my_imported_notifications($1,$2)`, [limit,offset]);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: kind,
        actorSubject: actor.subject, actorAccountId: actor.accountId, patientId: actor.patientId,
        action: itemId ? 'identity.imported.notification.mark-read' : 'identity.imported.notification.list',
        resourceType: 'imported-notification', resourceId: itemId, outcome: 'success', purposeOfUse: 'account-self' });
      return itemId ? result.rows[0] : result.rows;
    });
  }

  async notificationInbox(request: HidRequest, limit?: number) {
    const actor = requirePatient(request.actor);
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const result = await client.query(
        'select id, notification_code as "notificationCode", resource_type as "resourceType", '
        + 'resource_id as "resourceId", metadata, read_at as "readAt", created_at as "createdAt" '
        + 'from identity.list_my_notification_inbox($1)',
        [limit ?? 50],
      );
      return result.rows;
    });
  }

  async markNotificationRead(request: HidRequest, notificationId: string) {
    const actor = requirePatient(request.actor);
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      const result = await client.query(
        'select id, read_at as "readAt" from identity.mark_my_notification_read($1)',
        [notificationId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found');
      return row;
    });
  }

  async setAccessPin(request: HidRequest, pin: string) {
    const actor = requirePatient(request.actor);
    await this.database.withSystemTransaction(request.correlationId, async (client) => {
      await this.requireRecentAuthentication(client, actor);
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
      await this.requireRecentAuthentication(client, actor);
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

  private async requireRecentAuthentication(client: import('pg').PoolClient,
    actor: ActorContext & { patientId: string; sessionId: string }) {
    // Refresh rotates a session within the same family. Checking the first
    // issuance in that family prevents silent refresh from counting as a fresh
    // patient authentication for a sensitive PIN change.
    const result = await client.query<{ recent: boolean }>(
      `select coalesce(min(family.issued_at) >= clock_timestamp() - interval '10 minutes', false) as recent
         from auth.sessions current_session
         join auth.sessions family on family.family_id = current_session.family_id
        where current_session.id = $1 and current_session.account_id = $2
          and current_session.patient_id = $3 and current_session.session_kind = 'patient'
          and current_session.revoked_at is null`,
      [actor.sessionId, actor.accountId, actor.patientId],
    );
    if (!result.rows[0]?.recent) {
      throw new DomainProblem(403, 'PATIENT_RECENT_AUTH_REQUIRED',
        'Sign in again before changing your Access PIN');
    }
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
