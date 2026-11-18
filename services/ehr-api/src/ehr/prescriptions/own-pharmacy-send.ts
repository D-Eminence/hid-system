import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** What `ehr.send_prescription_to_own_pharmacy` (0133 D7) answers. */
export type OwnPharmacyOutcome = 'not_found' | 'not_prescriber' | 'not_active' | 'changed' | 'routed'
  | 'already_in_pharmacy' | 'superseded' | 'no_pharmacy' | 'sent' | 'pending';

/**
 * The prescription's hand-off to this hospital's own pharmacy, as the EHR
 * answers it (`pharmacyHandoff`): `sent` (the pharmacy has it), `pending`
 * (the send failed and can be tried again with "Send to pharmacy") or
 * `not_sent`, with a reason and a plain-English message for the screen.
 */
export interface PharmacyHandoff {
  status: 'sent' | 'pending' | 'not_sent';
  reason?: 'no_pharmacy' | 'routed' | 'not_prescriber' | 'changed' | 'not_allowed' | 'unavailable';
  message: string;
}

const CHANGED: PharmacyHandoff = { status: 'not_sent', reason: 'changed',
  message: 'Not sent: this prescription changed. Reload it and try again.' };

/**
 * The contract's table (docs/INTERFACE_CONTRACT.md, ORD-2, "EHR API:
 * pharmacyHandoff"): every outcome of D7 answers one of its rows. A
 * prescription D7 does not find (not_found) or finds no longer active
 * (not_active) is the contract's `changed`: what the prescriber has on the
 * screen is not what the database holds now.
 */
const HANDOFFS: Readonly<Record<OwnPharmacyOutcome, PharmacyHandoff>> = {
  sent: { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' },
  already_in_pharmacy: { status: 'sent', message: 'This hospital\'s pharmacy already has this prescription.' },
  pending: { status: 'pending',
    message: 'Not sent to the pharmacy yet. Use Send to pharmacy to try again.' },
  no_pharmacy: { status: 'not_sent', reason: 'no_pharmacy',
    message: 'Not sent: nobody at this facility works on pharmacy orders on Health ID.' },
  routed: { status: 'not_sent', reason: 'routed',
    message: 'Not sent: this prescription has been sent to another pharmacy.' },
  not_prescriber: { status: 'not_sent', reason: 'not_prescriber',
    message: 'Not sent: only the person who wrote this prescription can send it to the pharmacy.' },
  changed: CHANGED,
  not_active: CHANGED,
  not_found: CHANGED,
  superseded: { status: 'not_sent', reason: 'changed',
    message: 'Not sent: this hospital\'s pharmacy has an earlier version of this prescription, which it can no longer dispense.' },
};

/**
 * D7 refused the session (42501 OWN_PHARMACY_SEND_DENIED). Every prescription
 * route is direct care (clinicalContext), so it is the membership: the
 * database no longer finds prescription write for it at this facility (a role
 * or membership changed since sign-in). Trying again cannot help.
 */
const NOT_ALLOWED: PharmacyHandoff = { status: 'not_sent', reason: 'not_allowed',
  message: 'Not sent: your role at this facility does not allow sending prescriptions to the pharmacy.' };

const UNAVAILABLE: PharmacyHandoff = { status: 'not_sent', reason: 'unavailable',
  message: 'Not sent: the pharmacy could not be reached. Use Send to pharmacy to try again.' };

/** The hand-off for an outcome; anything unexpected is "could not be reached". */
export function pharmacyHandoff(outcome: string | undefined): PharmacyHandoff {
  return outcome !== undefined && Object.hasOwn(HANDOFFS, outcome) ? HANDOFFS[outcome as OwnPharmacyOutcome] : UNAVAILABLE;
}

/**
 * Sends activated prescriptions to this hospital's own pharmacy (0133;
 * owner, 18 November 2026: "activated prescriptions go automatically to the
 * hospital's own pharmacy: YES"), in the activation's own transaction.
 *
 * `send` asks `ehr.send_prescription_to_own_pharmacy(prescription, version)`:
 * the database checks the session is the prescriber with prescription write
 * here, that the prescription is active at that version with no route to
 * another facility, and that somebody here works on pharmacy items, and then
 * creates the pharmacy work item accepted by the prescriber with the fixed
 * reason "Sent automatically when the prescription was activated". A failed
 * attempt stays pending in the database and is tried again by the next send.
 * A pharmacy item of an earlier version (the prescription was edited or
 * resumed after it was sent) answers `superseded`, never "already there".
 * `withdraw` asks `ehr.withdraw_own_pharmacy_send(prescription)` to mark a
 * sent prescription withdrawn once it is held, cancelled or entered in
 * error, or is still active at another version than the one sent.
 *
 * Each runs in a savepoint, so nothing it does can undo the prescription's own
 * change: a schema without 0133 (42883) answers no hand-off (undefined); the
 * session refusal (42501 OWN_PHARMACY_SEND_DENIED: no prescription write here
 * for the membership) answers `not_allowed`, since trying again cannot help;
 * any other refusal answers "could not be reached".
 * Each refusal is logged with its SQLSTATE only. A serialization failure or
 * deadlock is passed on, so the whole transaction is run again. The module
 * provides it on; the tests' default is off (no statement, no hand-off).
 */
export class OwnPharmacySend {
  private readonly logger = new Logger(OwnPharmacySend.name);

  constructor(readonly enabled: boolean) {}

  async send(client: PoolClient, prescriptionId: string, version: number, correlationId: string):
  Promise<PharmacyHandoff | undefined> {
    if (!this.enabled) return undefined;
    const outcome = await this.inSavepoint(client, 'ehr_own_pharmacy_send', correlationId, async () => {
      const result = await client.query<{ outcome: string }>(
        'select outcome from ehr.send_prescription_to_own_pharmacy($1::uuid, $2::bigint)', [prescriptionId, version]);
      return result.rows[0]?.outcome;
    });
    if (outcome === MISSING) return undefined;
    if (outcome === DENIED) return NOT_ALLOWED;
    return outcome === FAILED ? UNAVAILABLE : pharmacyHandoff(outcome);
  }

  /** True when a sent prescription was marked withdrawn now; undefined on a schema without 0133. */
  async withdraw(client: PoolClient, prescriptionId: string, correlationId: string): Promise<boolean | undefined> {
    if (!this.enabled) return undefined;
    const marked = await this.inSavepoint(client, 'ehr_own_pharmacy_withdraw', correlationId, async () => {
      const result = await client.query<{ withdrawn: boolean }>(
        'select ehr.withdraw_own_pharmacy_send($1::uuid) as withdrawn', [prescriptionId]);
      return result.rows[0]?.withdrawn === true ? 'true' : 'false';
    });
    if (marked === MISSING) return undefined;
    return marked === 'true';
  }

  private async inSavepoint(client: PoolClient, name: string, correlationId: string,
    work: () => Promise<string | undefined>): Promise<string | undefined> {
    await client.query(`savepoint ${name}`);
    try {
      const answer = await work();
      await client.query(`release savepoint ${name}`);
      return answer;
    } catch (error) {
      const code = sqlState(error);
      if (code === '40001' || code === '40P01') throw error;
      await client.query(`rollback to savepoint ${name}`);
      if (code === '42883') return MISSING;
      this.logger.warn({ message: 'Sending to this hospital\'s pharmacy failed', sqlState: code, correlationId });
      return code === '42501' && errorMessage(error) === 'OWN_PHARMACY_SEND_DENIED' ? DENIED : FAILED;
    }
  }
}

const MISSING = '\u0000missing';
const DENIED = '\u0000denied';
const FAILED = '\u0000failed';

/** Off: no statement and no hand-off (the tests' and every direct caller's default). */
export const OWN_PHARMACY_SEND_OFF = new OwnPharmacySend(false);

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

function errorMessage(error: unknown): string | undefined {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : undefined;
}
