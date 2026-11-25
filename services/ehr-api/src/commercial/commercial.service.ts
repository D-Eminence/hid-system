import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { billingProblem, classifyBillingError } from './commercial-errors';

/** The server's switches for patient billing (BILL-1), from the environment. */
export interface CommercialSwitches {
  /** COMMERCIAL_BILLING_ENABLED: false until go-live; the sealed QA and demo facilities are on regardless. */
  billingEnabled: boolean;
  /** COMMERCIAL_PAY_BEFORE_ENABLED: off until the clinical lead signs BILL-3. */
  payBeforeAvailable: boolean;
  /** COMMERCIAL_ONLINE_PAYMENT_ENABLED: off until legal, DPO and owner approval (BILL-14). */
  onlineAvailable: boolean;
}
export const COMMERCIAL_SWITCHES = Symbol('COMMERCIAL_SWITCHES');

/** One call of a billing database function, and what its refusal's audit row names. */
export interface BillingCall {
  /** The audit action of a refusal (commercial.*). */
  action: string;
  /** The code the member must hold here (checked again by the function). */
  code: string;
  resourceType: string;
  resourceId?: string | null;
  /** One statement answering one row with one jsonb column named answer. */
  sql: string;
  values: readonly unknown[];
}

export const SWITCHED_ON_SQL = 'select commercial.billing_switched_on($1) as switched_on';
export const AUDIT_REFUSAL_SQL = 'select commercial.audit_refusal($1, $2, $3, $4, $5)';

/**
 * BILL-1 (0162-0167): every billing route is one SECURITY DEFINER function
 * of the commercial schema, called in one transaction with the request's
 * context (the function checks the member's code at the session facility,
 * locks, writes and audits). Before it, the facility must have billing
 * switched on (the server's COMMERCIAL_BILLING_ENABLED, or a sealed QA or
 * demo facility), else 404 BILLING_NOT_AVAILABLE. A refusal rolls the command
 * back and is then audited in its own transaction (code and resource id
 * only). Any other database failure is 503 BILLING_UNAVAILABLE, logged with
 * its SQLSTATE only: never a value, a name or the search text.
 */
@Injectable()
export class CommercialService {
  private readonly logger = new Logger(CommercialService.name);

  constructor(
    private readonly database: DatabaseService,
    @Inject(COMMERCIAL_SWITCHES) readonly switches: CommercialSwitches,
  ) {}

  async run<Answer = Record<string, unknown>>(context: DataAccessContext, call: BillingCall): Promise<Answer> {
    try {
      if (!context.actor.permissions.includes(call.code)) throw billingProblem('BILLING_NOT_ALLOWED');
      return await this.database.withTransaction(context, async (client: PoolClient) => {
        await this.requireSwitchedOn(client);
        const row = (await client.query<{ answer: Answer }>(call.sql, [...call.values])).rows[0];
        if (!row) throw billingProblem('BILLING_UNAVAILABLE');
        return row.answer;
      });
    } catch (error) {
      const failure = classifyBillingError(error);
      if (failure.refusal === null) {
        this.logger.warn(`Billing call failed (${failure.sqlstate ?? 'no database code'})`);
      } else if (failure.refusal !== 'BILLING_NOT_AVAILABLE') {
        await this.auditRefusal(context, call, failure.refusal);
      }
      throw failure.problem;
    }
  }

  private async requireSwitchedOn(client: PoolClient): Promise<void> {
    const on = (await client.query<{ switched_on: boolean }>(SWITCHED_ON_SQL, [this.switches.billingEnabled]))
      .rows[0]?.switched_on;
    if (on !== true) throw billingProblem('BILLING_NOT_AVAILABLE');
  }

  private async auditRefusal(context: DataAccessContext, call: BillingCall, code: string): Promise<void> {
    const resourceId = call.resourceId && /^[0-9a-f-]{36}$/i.test(call.resourceId) ? call.resourceId : null;
    try {
      await this.database.withTransaction(context, (client) =>
        client.query(AUDIT_REFUSAL_SQL, [call.action, code, call.resourceType, resourceId, 'ehr-api']));
    } catch (error) {
      const sqlstate = (error as { code?: unknown })?.code;
      this.logger.warn(`Billing refusal audit failed (${typeof sqlstate === 'string' ? sqlstate : 'no database code'})`);
    }
  }
}
