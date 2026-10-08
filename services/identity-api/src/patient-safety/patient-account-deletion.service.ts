import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requireRecentPatientAuthentication, type PatientSessionActor } from '../auth/recent-authentication';
import { requirePatient } from '../auth/patient-self.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { databaseMessage, isDatabaseError } from './database-error';
import type { CancelAccountDeletionDto, ConfirmAccountDeletionDto } from './dto/account-deletion.dto';

export type AccountDeletionState =
  | 'awaiting_confirmation' | 'pending' | 'blocked' | 'cancelled' | 'completed' | 'expired' | 'superseded';

export interface AccountDeletionStatus {
  waitingPeriodSeconds: number;
  confirmationTtlSeconds: number;
  request: {
    requestId: string;
    state: AccountDeletionState;
    requestedAt: string;
    confirmationExpiresAt: string | null;
    scheduledFor: string | null;
    blockedReasonCode: 'LEGAL_HOLD' | 'RETENTION_POLICY_UNAVAILABLE' | 'WORKFORCE_ACCOUNT' | null;
    cancelledAt: string | null;
    cancellable: boolean;
  } | null;
}

export interface AccountDeletionRequested {
  requestId: string;
  confirmationToken: string;
  confirmationExpiresAt: Date;
  waitingPeriodSeconds: number;
}

export interface AccountDeletionConfirmed {
  requestId: string;
  state: 'pending' | 'blocked' | 'completed';
  scheduledFor: Date | null;
  blockedReasonCode: string | null;
}

interface ConfirmRow {
  outcome: 'pending' | 'blocked' | 'completed' | 'invalid' | 'expired' | 'not_due' | 'not_pending' | 'not_found';
  request_id: string;
  request_state: string | null;
  scheduled_for: Date | null;
  blocked_reason_code: string | null;
}

const RECENT_AUTH_DETAIL = 'Sign in again before deleting your account';

/**
 * Patient login/account deletion. Every state change is a security-definer
 * command bound to the authenticated patient session; this service supplies
 * the fresh-authentication requirement and the single-use confirmation token
 * and never touches identity, clinical, or audit tables directly.
 */
@Injectable()
export class PatientAccountDeletionService {
  constructor(private readonly database: DatabaseService) {}

  async status(request: HidRequest): Promise<AccountDeletionStatus> {
    const actor = requirePatient(request.actor);
    const status = await this.asPatient(request, actor, async (client) => {
      const result = await client.query<{ status: AccountDeletionStatus | null }>(
        'select identity.my_account_deletion_status($1, $2) as status', [actor.subject, actor.sessionId]);
      return result.rows[0]?.status ?? null;
    });
    if (!status) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    return status;
  }

  async request(request: HidRequest): Promise<AccountDeletionRequested> {
    const actor = requirePatient(request.actor);
    const confirmationToken = randomBytes(32).toString('base64url');
    try {
      const row = await this.asPatient(request, actor, async (client) => {
        await requireRecentPatientAuthentication(client, actor, RECENT_AUTH_DETAIL);
        const result = await client.query<{ request_id: string; confirmation_expires_at: Date; waiting_period_seconds: string }>(
          'select request_id, confirmation_expires_at, waiting_period_seconds from identity.request_my_account_deletion($1, $2, $3)',
          [actor.subject, actor.sessionId, sha256Hex(confirmationToken)],
        );
        return result.rows[0];
      });
      if (!row) throw unavailable();
      return {
        requestId: row.request_id,
        confirmationToken,
        confirmationExpiresAt: row.confirmation_expires_at,
        waitingPeriodSeconds: Number(row.waiting_period_seconds),
      };
    } catch (error) {
      throw translate(error);
    }
  }

  async confirm(request: HidRequest, input: ConfirmAccountDeletionDto): Promise<AccountDeletionConfirmed> {
    const actor = requirePatient(request.actor);
    let row: ConfirmRow | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        await requireRecentPatientAuthentication(client, actor, RECENT_AUTH_DETAIL);
        const result = await client.query<ConfirmRow>(
          'select outcome, request_id, request_state, scheduled_for, blocked_reason_code '
          + 'from identity.confirm_my_account_deletion($1, $2, $3, $4, $5)',
          [actor.subject, actor.sessionId, input.requestId, sha256Hex(input.confirmationToken), input.confirmation],
        );
        return result.rows[0];
      });
    } catch (error) {
      throw translate(error);
    }
    // Denials commit their audit and attempt counter before being reported.
    if (!row) throw unavailable();
    if (row.outcome === 'invalid') {
      throw new DomainProblem(403, 'ACCOUNT_DELETION_CONFIRMATION_INVALID',
        'The deletion confirmation is invalid or has already been used');
    }
    if (row.outcome === 'expired') {
      throw new DomainProblem(403, 'ACCOUNT_DELETION_CONFIRMATION_EXPIRED',
        'The deletion confirmation has expired. Start again.');
    }
    if (row.outcome !== 'pending' && row.outcome !== 'blocked' && row.outcome !== 'completed') throw unavailable();
    return {
      requestId: row.request_id,
      state: row.outcome,
      scheduledFor: row.scheduled_for,
      blockedReasonCode: row.blocked_reason_code,
    };
  }

  async cancel(request: HidRequest, input: CancelAccountDeletionDto) {
    const actor = requirePatient(request.actor);
    try {
      const row = await this.asPatient(request, actor, async (client) => {
        const result = await client.query<{ request_id: string; request_state: 'cancelled'; replayed: boolean }>(
          'select request_id, request_state, replayed from identity.cancel_my_account_deletion($1, $2, $3)',
          [actor.subject, actor.sessionId, input.requestId],
        );
        return result.rows[0];
      });
      if (!row) throw unavailable();
      return { requestId: row.request_id, state: row.request_state, replayed: row.replayed };
    } catch (error) {
      throw translate(error);
    }
  }

  /** Finalizes due deletions in the Identity system context. */
  async finalizeDue(correlationId: string, limit = 10): Promise<ReadonlyArray<{ requestId: string; outcome: string }>> {
    return this.database.withSystemTransaction(correlationId, async (client) => {
      const result = await client.query<{ request_id: string; outcome: string }>(
        'select request_id, outcome from identity.finalize_due_patient_account_deletions($1)', [limit]);
      return result.rows.map((row) => ({ requestId: row.request_id, outcome: row.outcome }));
    });
  }

  private asPatient<Result>(
    request: HidRequest,
    actor: PatientSessionActor,
    operation: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      // `withSystemTransaction` starts as system:auth. Bind the verified
      // patient subject so `patient_self_session` enforces the subject/session pair.
      await client.query("select set_config('app.actor_subject', $1, true)", [actor.subject]);
      return operation(client);
    });
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'ACCOUNT_DELETION_UNAVAILABLE', 'Account deletion is temporarily unavailable');
}

function translate(error: unknown): unknown {
  if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
  const message = databaseMessage(error);
  switch (error.code) {
    case '42501':
      return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
    case 'P0001':
      return new DomainProblem(429, 'ACCOUNT_DELETION_RATE_LIMITED', 'Too many deletion requests. Try again tomorrow.');
    case 'P0002':
      return new DomainProblem(404, 'ACCOUNT_DELETION_NOT_FOUND', 'The deletion request is unavailable');
    case '22023':
    case '22P02':
      return new DomainProblem(400, 'INVALID_ACCOUNT_DELETION_COMMAND', 'The deletion command is invalid');
    case '55000':
      if (message === 'ACCOUNT_DELETION_ALREADY_PENDING') {
        return new DomainProblem(409, 'ACCOUNT_DELETION_ALREADY_PENDING', 'An account deletion is already scheduled');
      }
      if (message === 'ACCOUNT_DELETION_NOT_CANCELLABLE') {
        return new DomainProblem(409, 'ACCOUNT_DELETION_NOT_CANCELLABLE', 'This deletion request can no longer be cancelled');
      }
      return unavailable();
    default:
      return error;
  }
}
