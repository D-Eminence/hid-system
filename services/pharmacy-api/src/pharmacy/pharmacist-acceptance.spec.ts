import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { INTERNAL_CALLER, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { AcceptWorkItemDto } from './dto/accept-work-item.dto';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_OFF, OWN_WORK_STATES_QUERY, OWN_WORK_STEPS_QUERY, PharmacyOwnWork } from './own-work-access';
import { OWN_WORK_PATIENT_CARDS_OFF } from './own-work-patient-cards';
import { PharmacyController } from './pharmacy.controller';
import { ACCEPTANCE_BY_KEY_QUERY, INSERT_ACCEPTANCE, INSERT_PHARMACIST_ACCEPTED_EVENT, PHARMACIST_ACCEPTED_REASON,
  PharmacyService, WORK_LIST_QUERY, WORK_LIST_QUERY_0133 } from './pharmacy.service';
import { PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';

/*
 * ORD-4: a pharmacist accepts this hospital's own prescription, sent to its
 * pharmacy automatically (0133), before dispensing it; a dispensing of a
 * received item accepts it first; the work list and a single read say where
 * each item is (`pharmacyStep`) and who accepted it, and how
 * (`pharmacistAcceptance`). The database part (pharmacy.work_item_acceptances,
 * its trigger, the pharmacist_accepted event and pharmacy.own_work_item_steps)
 * is faked here with the rules SPEC decisions 2-6 give it; every statement
 * runs through the real DatabaseService (its SERIALIZABLE retry) and the real
 * AuditService (the audit row is a statement of the same transaction).
 * Fictional ids and names only.
 */

const facilityId = '10000000-0000-4000-8000-0000000000f1';
const otherFacilityId = '10000000-0000-4000-8000-0000000000f2';
const pharmacistAccount = '20000000-0000-4000-8000-0000000000a1';
const pharmacistMembership = '40000000-0000-4000-8000-0000000000a1';
const otherPharmacistAccount = '20000000-0000-4000-8000-0000000000a2';
const otherPharmacistMembership = '40000000-0000-4000-8000-0000000000a2';
const doctorAccount = '20000000-0000-4000-8000-0000000000d1';
const doctorMembership = '40000000-0000-4000-8000-0000000000d1';
const routeMemberAccount = '20000000-0000-4000-8000-0000000000r1';
const routeMemberMembership = '40000000-0000-4000-8000-0000000000r1';
const ada = '50000000-0000-4000-8000-0000000000e1';
const routeId = '80000000-0000-4000-8000-0000000000c1';
const id = (n: number) => `64000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));
const acceptKey = 'ord4-accept-key-0001';
const dispenseKey = 'ord4-dispense-key-0001';

const pharmacist: DataAccessContext = { correlationId: 'ord4-correlation-0001', facilityId,
  membershipId: pharmacistMembership, purposeOfUse: 'direct-care', authorization: 'Bearer pharmacist', actor: {
    id: pharmacistAccount, subject: 'staff:pharmacist-one', accountId: pharmacistAccount, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.work-item.read', 'pharmacy.work-item.accept',
      'pharmacy.dispensing.create', 'pharmacy.order-route.receive'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId: pharmacistMembership, organizationId: facilityId, name: 'Fictional General',
      roles: ['pharmacist'], permissions: [], isPrimary: true } } };
const secondPharmacist: DataAccessContext = { ...pharmacist, correlationId: 'ord4-correlation-0002',
  membershipId: otherPharmacistMembership, actor: { ...pharmacist.actor, id: otherPharmacistAccount,
    subject: 'staff:pharmacist-two', accountId: otherPharmacistAccount } };

/** How each fictional work item came to this pharmacy, and where it is. */
interface Item {
  n: number;
  /** Another facility's prescription, accepted with its route (0086). */
  routed?: boolean;
  /** An own item a pharmacist handed in by hand (not sent automatically). */
  handOff?: boolean;
  dispensed?: boolean;
  reversed?: boolean;
  /** 0133 D8 / D14: withdrawn before it was dispensed. */
  withdrawn?: 'changed' | 'sent_elsewhere';
  /** A stored ORD-4 acceptance. */
  acceptance?: { with: 'accept' | 'dispensing'; account: string; membership: string; minute: number; key: string;
    digest: string };
}

const ITEMS: Item[] = [
  { n: 1 },
  { n: 2, acceptance: { with: 'accept', account: otherPharmacistAccount, membership: otherPharmacistMembership,
    minute: 32, key: 'ord4-other-accept-0002', digest: 'b'.repeat(64) } },
  { n: 3, dispensed: true, acceptance: { with: 'dispensing', account: pharmacistAccount, membership: pharmacistMembership,
    minute: 33, key: 'ord4-other-dispense-0003', digest: 'c'.repeat(64) } },
  { n: 4, handOff: true },
  { n: 5, routed: true },
  { n: 6, dispensed: true },
  { n: 7, withdrawn: 'changed' },
  { n: 8, withdrawn: 'sent_elsewhere' },
  { n: 9, withdrawn: 'changed', acceptance: { with: 'accept', account: otherPharmacistAccount,
    membership: otherPharmacistMembership, minute: 39, key: 'ord4-other-accept-0009', digest: 'd'.repeat(64) } },
  { n: 10, dispensed: true, reversed: true, acceptance: { with: 'accept', account: pharmacistAccount,
    membership: pharmacistMembership, minute: 40, key: 'ord4-other-accept-0010', digest: 'e'.repeat(64) } },
  // Accepted from the moment each was made, and then dispensed, as most are: no acceptance row, no un-accept.
  { n: 11, handOff: true, dispensed: true },
  { n: 12, routed: true, dispensed: true },
];

const workRow = (item: Item) => ({ id: id(item.n), patient_id: ada, facility_id: facilityId,
  ordering_facility_id: item.routed ? otherFacilityId : facilityId,
  source_ehr_prescription_id: `30000000-0000-4000-8000-${String(item.n).padStart(12, '0')}`,
  source_ehr_prescription_version: '2', source_encounter_id: '70000000-0000-4000-8000-0000000000b1',
  source_status: 'active', status: 'accepted', medication_code_system: null, medication_code: null,
  medication_display: 'Amoxicillin 500 mg capsule', dose_quantity: '1', dose_unit: 'capsule', route_code: 'oral',
  frequency: 'Every 8 hours', instructions: 'After food', starts_on: null, ends_on: null, prescribed_by: doctorAccount,
  prescribed_at: at(item.n),
  // 0133 D7: an automatic send records the prescriber; a hand-off the pharmacist; a route the member who accepted it.
  accepted_by: item.routed ? routeMemberAccount : item.handOff ? pharmacistAccount : doctorAccount,
  accepted_by_membership_id: item.routed ? routeMemberMembership : item.handOff ? pharmacistMembership : doctorMembership,
  accepted_at: at(item.n), row_version: '1', created_at: at(item.n),
  dispensing_id: item.dispensed ? `65000000-0000-4000-8000-${String(item.n).padStart(12, '0')}` : null,
  dispensing_status: item.dispensed ? 'dispensed' : null,
  reversal_id: item.reversed ? `66000000-0000-4000-8000-${String(item.n).padStart(12, '0')}` : null,
  order_route_id: item.routed ? routeId : null });

const sqlError = (code: string, message = `synthetic ${code}`, detail?: string) =>
  Object.assign(new Error(message), { code, ...(detail === undefined ? {} : { detail }) });

/**
 * 0144's two unique keys on pharmacy.work_item_acceptances, by the names PostgreSQL gives them, and their 23505 as
 * node-postgres passes it on: the constraint named. The names are pinned on the database side: 0144's post-check
 * refuses any other index names, and its suite expects the 23505 messages that name them. This spec does not read
 * those files, because a pharmacy-api test that reads a file outside pharmacy-api must also be listed in
 * scripts/production-backend-build.mjs (outsideTestInputs), or a change to that file would not run these tests.
 */
const ITEM_KEY = 'work_item_acceptances_work_item_id_key';
const MEMBER_KEY = 'work_item_acceptances_facility_id_accepted_by_idempotency_k_key';
const uniqueViolation = (constraint: string) => Object.assign(
  new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

interface AcceptanceRecord { work_item_id: string; facility_id: string; accepted_by: string;
  accepted_by_membership_id: string; accepted_at: Date; accepted_with: string; idempotency_key: string;
  request_sha256: string; correlation_id: string; patient_id: string; id: string }
interface State { acceptances: AcceptanceRecord[]; events: unknown[][]; dispensings: Record<string, unknown>[];
  audits: unknown[][]; outbox: unknown[][] }

interface Options {
  items?: Item[];
  /** 'release-a': no ORD-4 table (42P01) and no steps reader (42883). */
  schema?: 'ord4' | 'release-a';
  /** C17's answer for an id this session cannot see. */
  hiddenOutcome?: 'none' | 'closed' | 'paused';
  /** C17's answer for a visible route-backed item. */
  routeOutcome?: 'allowed' | 'closed' | 'paused';
  /** 0133's own-work basis for an own item (null: none, Identity's consent decides). */
  ownBasis?: 'own-work' | 'consent' | null;
  identity?: { allowed: boolean; breakGlass: boolean };
  ownWork?: boolean;
  keyLookupError?: Error;
  stepsError?: Error;
  /** Ids ORD-4's reader leaves out (not readable by this session). */
  stepsHide?: string[];
  /**
   * Acceptances stored for items not in ITEMS that row-level security now hides from this session (their patient's
   * consent grant ended, or the patient set a deny directive): the key lookup reads none of them, while 0144's
   * unique keys see every row.
   */
  hiddenAcceptances?: { n: number; account: string; key: string }[];
  /** Raised by the next acceptance insert(s), in order; `then` runs first (e.g. a racing pharmacist commits). */
  insertErrors?: { error: Error; then?: (committed: State) => void }[];
  eventError?: Error;
  dispensingErrors?: Error[];
}

/**
 * The fake database. Statements run against a working copy of the committed
 * state; COMMIT keeps it, ROLLBACK drops it, and a savepoint rollback goes
 * back to the copy taken at the savepoint, as PostgreSQL does.
 */
function harness(options: Options = {}) {
  const items = options.items ?? ITEMS;
  const rows = new Map(items.map((item) => [id(item.n), workRow(item)]));
  const itemOf = new Map(items.map((item) => [id(item.n), item]));
  const committed: State = { acceptances: items.filter((item) => item.acceptance).map((item) => ({
    id: `67000000-0000-4000-8000-${String(item.n).padStart(12, '0')}`, work_item_id: id(item.n), facility_id: facilityId,
    patient_id: ada, accepted_by: item.acceptance!.account, accepted_by_membership_id: item.acceptance!.membership,
    accepted_at: at(item.acceptance!.minute), accepted_with: item.acceptance!.with,
    idempotency_key: item.acceptance!.key, request_sha256: item.acceptance!.digest, correlation_id: 'earlier-correlation' }))
    .concat((options.hiddenAcceptances ?? []).map((hidden) => ({
      id: `67000000-0000-4000-8000-${String(hidden.n).padStart(12, '0')}`, work_item_id: id(hidden.n),
      facility_id: facilityId, patient_id: '50000000-0000-4000-8000-0000000000e2', accepted_by: hidden.account,
      accepted_by_membership_id: hidden.account === pharmacistAccount ? pharmacistMembership
        : otherPharmacistMembership,
      accepted_at: at(30), accepted_with: 'accept', idempotency_key: hidden.key, request_sha256: 'a'.repeat(64),
      correlation_id: 'earlier-correlation' }))),
  events: [], dispensings: [], audits: [], outbox: [] };
  const hidden = new Set((options.hiddenAcceptances ?? []).map((row) => id(row.n)));
  const copy = (state: State): State => ({ acceptances: [...state.acceptances], events: [...state.events],
    dispensings: [...state.dispensings], audits: [...state.audits], outbox: [...state.outbox] });
  const transactions: { statements: { sql: string; values: unknown[] }[]; committed: boolean }[] = [];
  const insertErrors = [...(options.insertErrors ?? [])];
  const dispensingErrors = [...(options.dispensingErrors ?? [])];
  const schema = options.schema ?? 'ord4';

  const answer = (sql: string, values: unknown[], working: State, context: { account?: string; membership?: string }) => {
    if (/from pharmacy\.work_items w[\s\S]*where w\.id=\$1$/.test(sql)) {
      const row = rows.get(values[0] as string);
      const dispensing = working.dispensings.find((entry) => entry.work_item_id === values[0]);
      if (row && dispensing) return [{ ...row, dispensing_id: dispensing.id as string, dispensing_status: 'dispensed' }];
      return row ? [row] : [];
    }
    if (sql === WORK_LIST_QUERY || sql === WORK_LIST_QUERY_0133) {
      // 0133's list leaves out an own item sent elsewhere.
      return [...rows.values()].filter((row) => sql === WORK_LIST_QUERY || itemOf.get(row.id)?.withdrawn !== 'sent_elsewhere');
    }
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      const workItemId = (sql.includes("('work_item', $1, $2)") ? values[0] : values[1]) as string;
      const row = rows.get(workItemId);
      if (!row) return [{ outcome: options.hiddenOutcome ?? 'none', route_id: routeId, work_item_id: workItemId }];
      if (!row.order_route_id) return [{ outcome: 'none', route_id: null, work_item_id: workItemId }];
      return [{ outcome: options.routeOutcome ?? 'allowed', route_id: routeId, work_item_id: workItemId }];
    }
    if (/from pharmacy\.own_work_access_for/.test(sql)) {
      const basis = options.ownBasis === undefined ? 'own-work' : options.ownBasis;
      return basis ? [{ work_item_id: values[1], basis }] : [];
    }
    if (sql === ACCEPTANCE_BY_KEY_QUERY) {
      if (schema === 'release-a') throw sqlError('42P01', 'relation "pharmacy.work_item_acceptances" does not exist');
      if (options.keyLookupError) throw options.keyLookupError;
      return working.acceptances.filter((row) => !hidden.has(row.work_item_id) && row.facility_id === values[0]
        && row.accepted_by === values[1] && row.idempotency_key === values[2]).map((row) => ({
        work_item_id: row.work_item_id, request_sha256: row.request_sha256 }));
    }
    if (sql === OWN_WORK_STEPS_QUERY || sql === OWN_WORK_STATES_QUERY) {
      const steps = sql === OWN_WORK_STEPS_QUERY;
      if (steps && schema === 'release-a') throw sqlError('42883', 'function pharmacy.own_work_item_steps(uuid[]) does not exist');
      if (steps && options.stepsError) throw options.stepsError;
      return (values[0] as string[]).filter((workItemId) => rows.get(workItemId) && !rows.get(workItemId)!.order_route_id
        && !(options.stepsHide ?? []).includes(workItemId)).map((workItemId) => {
        const item = itemOf.get(workItemId)!;
        const withdrawn = item.withdrawn && !item.dispensed ? item.withdrawn : null;
        const state = { work_item_id: workItemId, basis: options.ownBasis === 'consent' ? 'consent' : 'own-work',
          withdrawn: withdrawn !== null, withdrawn_reason: withdrawn };
        if (!steps) return state;
        const acceptance = working.acceptances.find((row) => row.work_item_id === workItemId);
        return { ...state, sent_automatically: !item.handOff, accepted_at: acceptance?.accepted_at ?? null,
          accepted_by_membership_id: acceptance?.accepted_by_membership_id ?? null,
          accepted_with: acceptance?.accepted_with ?? null };
      });
    }
    if (sql === INSERT_ACCEPTANCE) {
      if (schema === 'release-a') throw sqlError('42P01', 'relation "pharmacy.work_item_acceptances" does not exist');
      const injected = insertErrors.shift();
      if (injected) { injected.then?.(committed); throw injected.error; }
      const [rowId, workItemId, patientId, facility, account, membership, acceptedWith, key, digest, correlation] =
        values as string[];
      const item = itemOf.get(workItemId!)!;
      // The trigger (SPEC decision 4): the session, an own item sent automatically, live, undispensed, not withdrawn.
      if (account !== context.account || membership !== context.membership || facility !== facilityId) {
        throw sqlError('23514', 'Pharmacist acceptance does not match its work item and actor context');
      }
      if (item.routed) throw sqlError('23514', 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY', 'order_route');
      if (item.handOff) throw sqlError('23514', 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY', 'hand_off');
      if (item.withdrawn) throw sqlError('23514', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', item.withdrawn);
      if (working.dispensings.some((row) => row.work_item_id === workItemId) || item.dispensed) {
        throw sqlError('23514', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'not_claimed');
      }
      // The unique keys see every row, whatever row-level security hides; the item's own key is checked first
      // (its index is the older of the two).
      if (working.acceptances.some((row) => row.work_item_id === workItemId)) throw uniqueViolation(ITEM_KEY);
      if (working.acceptances.some((row) => row.facility_id === facility && row.accepted_by === account
        && row.idempotency_key === key)) throw uniqueViolation(MEMBER_KEY);
      const stored: AcceptanceRecord = { id: rowId!, work_item_id: workItemId!, patient_id: patientId!, facility_id: facility!,
        accepted_by: account!, accepted_by_membership_id: membership!, accepted_at: at(50), accepted_with: acceptedWith!,
        idempotency_key: key!, request_sha256: digest!, correlation_id: correlation! };
      working.acceptances.push(stored);
      return [{ accepted_at: stored.accepted_at, accepted_by_membership_id: stored.accepted_by_membership_id,
        accepted_with: stored.accepted_with }];
    }
    if (sql === INSERT_PHARMACIST_ACCEPTED_EVENT) {
      if (options.eventError) throw options.eventError;
      // The event validator (0144 A4): the session, the item's acceptance row by the same member, the fixed reason.
      const acceptance = working.acceptances.find((row) => row.work_item_id === values[0]);
      if (!acceptance || acceptance.accepted_by !== values[3] || acceptance.accepted_by_membership_id !== values[4]
        || values[3] !== context.account || values[4] !== context.membership
        || values[5] !== 'Accepted by the pharmacist') {
        throw sqlError('23514', 'Pharmacy work-item event does not match its pharmacist acceptance');
      }
      working.events.push(values);
      return [];
    }
    if (/from pharmacy\.dispensings d left join[\s\S]*d\.idempotency_key=\$3/.test(sql)) {
      return working.dispensings.filter((row) => (row.facility_id === values[0] && row.dispensed_by === values[1]
        && row.idempotency_key === values[2]) || row.work_item_id === values[3]);
    }
    if (/^insert into pharmacy\.dispensings/.test(sql)) {
      const injected = dispensingErrors.shift();
      if (injected) throw injected;
      const item = itemOf.get(values[1] as string)!;
      // 0101 (the prescription changed) and 0133 D14 (sent elsewhere) refuse a withdrawn item.
      if (item.withdrawn) {
        throw sqlError('23514', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', item.withdrawn === 'sent_elsewhere' ? 'sent_elsewhere'
          : undefined);
      }
      const row = { id: '65000000-0000-4000-8000-0000000000ff', work_item_id: values[1], work_item_version: '1',
        patient_id: values[3], facility_id: values[4], medication_code_system: null, medication_code: null,
        medication_display: 'Amoxicillin 500 mg capsule', quantity_dispensed: '21', quantity_unit: 'capsule',
        status: 'dispensed', dispensed_by: values[10], dispensed_at: at(55), row_version: '1', created_at: at(55),
        idempotency_key: values[13], request_sha256: values[14], reversal_id: null, reversed_at: null };
      working.dispensings.push(row);
      return [row];
    }
    if (/^insert into pharmacy\.outbox_events/.test(sql)) { working.outbox.push(values); return []; }
    if (/^insert into audit\.events/.test(sql)) { working.audits.push(values); return []; }
    return [];
  };

  const pool = {
    connect: async () => {
      const transaction = { statements: [] as { sql: string; values: unknown[] }[], committed: false };
      transactions.push(transaction);
      let working = copy(committed);
      const savepoints = new Map<string, State>();
      const session: { account?: string; membership?: string } = {};
      return {
        query: async (sql: string, values: unknown[] = []) => {
          const text = sql.trim();
          transaction.statements.push({ sql: text, values });
          if (text === 'BEGIN' || text.startsWith('SET TRANSACTION')) return { rows: [] };
          if (text.startsWith('select set_config(')) {
            session.membership = values[3] as string;
            // The session's account is the actor's (platform.current_account_id()).
            session.account = values[0] === secondPharmacist.actor.subject ? otherPharmacistAccount : pharmacistAccount;
            return { rows: [] };
          }
          if (text === 'COMMIT') {
            Object.assign(committed, working);
            transaction.committed = true;
            return { rows: [] };
          }
          if (text === 'ROLLBACK') { working = copy(committed); return { rows: [] }; }
          const savepoint = /^savepoint (\w+)$/.exec(text);
          if (savepoint) { savepoints.set(savepoint[1]!, copy(working)); return { rows: [] }; }
          const back = /^rollback to savepoint (\w+)$/.exec(text);
          if (back) { working = copy(savepoints.get(back[1]!)!); return { rows: [] }; }
          if (/^release savepoint \w+$/.test(text)) return { rows: [] };
          return { rows: answer(text, values, working, session) };
        },
        release: () => undefined,
      };
    },
    query: async () => ({ rows: [{ orders: false, work: false }] }),
  };
  const database = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(database, { pool, pauseBeforeRetry: async () => undefined });
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: options.identity?.allowed ?? true,
    breakGlass: options.identity?.breakGlass ?? false }) };
  const ownWork = options.ownWork === false ? OWN_WORK_OFF : new PharmacyOwnWork(true);
  const service = new PharmacyService(database, identity as unknown as IdentityService, new AuditService(),
    new PharmacyOrderRouteAccess(identity as unknown as IdentityService, ownWork), new PharmacyOrderRouteCards(database),
    OWN_WORK_PATIENT_CARDS_OFF, PRESCRIPTION_DETAILS_OFF, ownWork);
  /** Audit rows committed: action, patient, resource type and id, outcome and details. */
  const audited = () => committed.audits.map((values) => ({ action: values[7], patientId: values[6],
    resourceType: values[8], resourceId: values[9], outcome: values[12], details: JSON.parse(values[11] as string) }));
  const last = () => transactions[transactions.length - 1]!.statements.map((statement) => statement.sql);
  return { service, committed, transactions, identity, audited, last };
}

/** Each statement by what it does, for the order tests. */
const kind = (sql: string) => (sql.startsWith('select set_config(') ? 'session'
  : /from pharmacy\.work_items w/.test(sql) ? 'work item'
    : /order_route_access_for/.test(sql) ? 'C17'
      : /own_work_access_for/.test(sql) ? 'own-work basis'
        : sql === ACCEPTANCE_BY_KEY_QUERY.trim() ? 'acceptance by key'
          : sql === OWN_WORK_STEPS_QUERY.trim() ? 'steps'
            : sql === OWN_WORK_STATES_QUERY.trim() ? 'states'
              : sql === INSERT_ACCEPTANCE.trim() ? 'insert acceptance'
                : sql === INSERT_PHARMACIST_ACCEPTED_EVENT.trim() ? 'insert event'
                  : /^insert into audit\.events/.test(sql) ? 'audit'
                    : /^insert into pharmacy\.dispensings/.test(sql) ? 'insert dispensing'
                      : /^insert into pharmacy\.outbox_events/.test(sql) ? 'outbox'
                        : /from pharmacy\.dispensings d/.test(sql) ? 'dispensing replay' : sql);

const accept = (n: number, context: DataAccessContext = pharmacist, key = acceptKey, version = 1) =>
  ({ context, workItemId: id(n), input: { expectedWorkItemVersion: version }, key });
const run = (h: ReturnType<typeof harness>, call: ReturnType<typeof accept>) =>
  h.service.acceptWorkItem(call.context, call.workItemId, call.input, call.key);
const refusal = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error) as
  Promise<DomainProblem & { extensions?: Record<string, unknown> }>;
const dispenseInput = { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'capsule',
  reason: 'Handed to the patient with counselling' };

beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('POST pharmacy/work-items/:workItemId/accept (ORD-4): the route', () => {
  it('is a browser write needing pharmacy.work-item.accept, never an internal-caller route', () => {
    const handler = PharmacyController.prototype.acceptWorkItem;
    expect(Reflect.getMetadata('path', handler)).toBe('work-items/:workItemId/accept');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['pharmacy.work-item.accept']);
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBeUndefined();
  });

  it('answers 201 when it recorded the acceptance and 200 when the item was already accepted', async () => {
    const acceptWorkItem = jest.fn();
    const controller = new PharmacyController({ acceptWorkItem } as unknown as PharmacyService);
    const headers: Record<string, string> = { authorization: 'Bearer pharmacist', 'x-purpose-of-use': 'direct-care' };
    const request = { correlationId: pharmacist.correlationId, actor: pharmacist.actor, facilityId, method: 'POST',
      headers, header: (name: string) => headers[name.toLowerCase()] };
    for (const [alreadyAccepted, status] of [[false, 201], [true, 200]] as const) {
      acceptWorkItem.mockResolvedValueOnce({ workItemId: id(1), alreadyAccepted });
      const response = { status: jest.fn() };
      await expect(controller.acceptWorkItem(id(1), { expectedWorkItemVersion: 1 }, acceptKey, request as never,
        response as never)).resolves.toEqual({ workItemId: id(1), alreadyAccepted });
      expect(response.status).toHaveBeenCalledWith(status);
    }
    expect(acceptWorkItem).toHaveBeenCalledWith(expect.objectContaining({ facilityId }), id(1),
      { expectedWorkItemVersion: 1 }, acceptKey);
  });

  it('requires an Idempotency-Key before asking anything', async () => {
    const acceptWorkItem = jest.fn();
    const controller = new PharmacyController({ acceptWorkItem } as unknown as PharmacyService);
    const headers: Record<string, string> = { authorization: 'Bearer pharmacist', 'x-purpose-of-use': 'direct-care' };
    const request = { correlationId: 'c', actor: pharmacist.actor, facilityId, method: 'POST', headers,
      header: (name: string) => headers[name.toLowerCase()] };
    await expect(controller.acceptWorkItem(id(1), { expectedWorkItemVersion: 1 }, undefined, request as never,
      { status: jest.fn() } as never)).rejects.toMatchObject({ status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
    expect(acceptWorkItem).not.toHaveBeenCalled();
  });

  it('takes exactly { expectedWorkItemVersion }, a whole number of 1 or more', async () => {
    const errors = async (body: unknown) => (await validate(plainToInstance(AcceptWorkItemDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map((error) => error.property);
    expect(await errors({ expectedWorkItemVersion: 1 })).toEqual([]);
    expect(await errors({ expectedWorkItemVersion: 7 })).toEqual([]);
    for (const version of [0, -1, 1.5, '1', null, undefined]) {
      expect(await errors({ expectedWorkItemVersion: version })).toEqual(['expectedWorkItemVersion']);
    }
    for (const extra of ['reason', 'acceptedWith', 'membershipId', 'patientId']) {
      expect(await errors({ expectedWorkItemVersion: 1, [extra]: 'x' })).toEqual([extra]);
    }
  });
});

describe('POST pharmacy/work-items/:workItemId/accept (ORD-4): accepting', () => {
  it('records a received item\'s acceptance and its event (201), then answers it to anyone who asks again (200)',
    async () => {
      const h = harness();
      const first = await run(h, accept(1));
      expect(first).toEqual({ workItemId: id(1), pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: at(50),
        acceptedByMembershipId: pharmacistMembership, acceptedWith: 'accept' }, alreadyAccepted: false });
      expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toEqual([expect.objectContaining({
        accepted_by: pharmacistAccount, accepted_by_membership_id: pharmacistMembership, accepted_with: 'accept',
        idempotency_key: acceptKey, correlation_id: pharmacist.correlationId,
        request_sha256: requestDigest('pharmacy.work-item.pharmacist-accept', { workItemId: id(1),
          expectedWorkItemVersion: 1 }) })]);
      expect(h.committed.events).toEqual([[id(1), ada, facilityId, pharmacistAccount, pharmacistMembership,
        PHARMACIST_ACCEPTED_REASON, pharmacist.correlationId]]);
      // The same request again, a new key, and another pharmacist: the stored acceptance, nothing new written.
      const again = { workItemId: id(1), pharmacyStep: 'accepted', pharmacistAcceptance: first.pharmacistAcceptance,
        alreadyAccepted: true };
      await expect(run(h, accept(1))).resolves.toEqual(again);
      await expect(run(h, accept(1, pharmacist, 'ord4-accept-key-0099'))).resolves.toEqual(again);
      await expect(run(h, accept(1, secondPharmacist, 'ord4-accept-key-0100'))).resolves.toEqual(again);
      expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toHaveLength(1);
      expect(h.committed.events).toHaveLength(1);
      expect(h.audited().map((row) => [row.action, row.patientId, row.resourceType, row.resourceId, row.outcome,
        row.details])).toEqual([
        ['pharmacy.work-item.pharmacist-accept', ada, 'pharmacy-work-item', id(1), 'success',
          { outcome: 'accepted', acceptedWith: 'accept', basis: 'own-work' }],
        ...Array(3).fill(['pharmacy.work-item.pharmacist-accept', ada, 'pharmacy-work-item', id(1), 'success',
          { outcome: 'already_accepted', acceptedWith: 'accept', basis: 'own-work' }])]);
    });

  it('sends exactly these statements, in one SERIALIZABLE transaction, the audit row before COMMIT', async () => {
    const h = harness();
    await run(h, accept(1));
    const statements = h.transactions[0]!.statements;
    expect(statements.map((statement) => kind(statement.sql))).toEqual(['BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'session', 'work item', 'C17', 'savepoint pharmacy_own_work_access',
      'own-work basis', 'release savepoint pharmacy_own_work_access', 'acceptance by key',
      'savepoint pharmacy_own_work_steps', 'steps', 'release savepoint pharmacy_own_work_steps', 'insert acceptance',
      'insert event', 'audit', 'COMMIT']);
    const sent = (sql: string) => statements.find((statement) => statement.sql === sql.trim())!;
    expect(sent(ACCEPTANCE_BY_KEY_QUERY).values).toEqual([facilityId, pharmacistAccount, acceptKey]);
    expect(sent(OWN_WORK_STEPS_QUERY).values).toEqual([[id(1)]]);
    const inserted = sent(INSERT_ACCEPTANCE).values;
    expect(inserted).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), id(1), ada, facilityId, pharmacistAccount,
      pharmacistMembership, 'accept', acceptKey, requestDigest('pharmacy.work-item.pharmacist-accept',
        { workItemId: id(1), expectedWorkItemVersion: 1 }), pharmacist.correlationId]);
    expect(sent(INSERT_PHARMACIST_ACCEPTED_EVENT).values).toEqual([id(1), ada, facilityId, pharmacistAccount,
      pharmacistMembership, PHARMACIST_ACCEPTED_REASON, pharmacist.correlationId]);
    // 0144's event validator refuses any other reason.
    expect(PHARMACIST_ACCEPTED_REASON).toBe('Accepted by the pharmacist');
    expect(INSERT_PHARMACIST_ACCEPTED_EVENT).toMatch(/values \(\$1,\$2,\$3,2,'pharmacist_accepted',\$4,\$5,\$6,\$7\)/);
  });

  it.each([
    [2, 'accept', 'accepted', otherPharmacistMembership, 32],
    [3, 'dispensing', 'dispensed', pharmacistMembership, 33],
    [10, 'accept', 'dispensing_reversed', pharmacistMembership, 40],
  ] as const)('answers item %i\'s stored acceptance (%s) with 200, its step %s, and writes only the audit row',
    async (n, acceptedWith, pharmacyStep, membership, minute) => {
      const h = harness();
      await expect(run(h, accept(n))).resolves.toEqual({ workItemId: id(n), pharmacyStep, pharmacistAcceptance: {
        acceptedAt: at(minute), acceptedByMembershipId: membership, acceptedWith }, alreadyAccepted: true });
      expect(h.last()).not.toContain(INSERT_ACCEPTANCE.trim());
      expect(h.committed.events).toEqual([]);
      expect(h.audited().map((row) => row.details)).toEqual([{ outcome: 'already_accepted', acceptedWith,
        basis: 'own-work' }]);
    });

  it('answers a stored acceptance before a withdrawal: accepted, then held, still answers 200', async () => {
    const h = harness();
    await expect(run(h, accept(9))).resolves.toMatchObject({ pharmacyStep: 'accepted', alreadyAccepted: true,
      pharmacistAcceptance: { acceptedWith: 'accept', acceptedByMembershipId: otherPharmacistMembership } });
  });

  it('answers a route-backed item with its route\'s acceptance (order_route), from its row, asking no reader', async () => {
    const h = harness();
    await expect(run(h, accept(5))).resolves.toEqual({ workItemId: id(5), pharmacyStep: 'accepted',
      pharmacistAcceptance: { acceptedAt: at(5), acceptedByMembershipId: routeMemberMembership,
        acceptedWith: 'order_route' }, alreadyAccepted: true });
    expect(h.last().some((sql) => sql === OWN_WORK_STEPS_QUERY.trim() || /own_work_access_for/.test(sql))).toBe(false);
    expect(h.identity.authorize).not.toHaveBeenCalled();
    expect(h.audited().map((row) => row.details)).toEqual([{ outcome: 'already_accepted', acceptedWith: 'order_route',
      basis: 'order-route', orderRouteId: routeId }]);
    expect(h.committed.acceptances.some((row) => row.work_item_id === id(5))).toBe(false);
  });

  it.each([
    [11, 'hand_off', pharmacistMembership, 'own-work', {}],
    [12, 'order_route', routeMemberMembership, 'order-route', { orderRouteId: routeId }],
  ] as const)('answers dispensed item %i with the acceptance it was made with (%s), 200, not 409 already dispensed',
    async (n, acceptedWith, membership, basis, route) => {
      // Contract steps 6 and 7 come before step 8: an item accepted when it was made stays accepted once dispensed.
      const h = harness();
      await expect(run(h, accept(n))).resolves.toEqual({ workItemId: id(n), pharmacyStep: 'dispensed',
        pharmacistAcceptance: { acceptedAt: at(n), acceptedByMembershipId: membership, acceptedWith },
        alreadyAccepted: true });
      expect(h.last()).not.toContain(INSERT_ACCEPTANCE.trim());
      expect(h.committed.acceptances.some((row) => row.work_item_id === id(n))).toBe(false);
      expect(h.committed.events).toEqual([]);
      expect(h.audited().map((row) => row.details)).toEqual([{ outcome: 'already_accepted', acceptedWith, basis,
        ...route }]);
    });

  it('answers an item handed in by hand with its own acceptance (hand_off), from its row', async () => {
    const h = harness();
    await expect(run(h, accept(4))).resolves.toEqual({ workItemId: id(4), pharmacyStep: 'accepted',
      pharmacistAcceptance: { acceptedAt: at(4), acceptedByMembershipId: pharmacistMembership, acceptedWith: 'hand_off' },
      alreadyAccepted: true });
    expect(h.last()).not.toContain(INSERT_ACCEPTANCE.trim());
    expect(h.audited().map((row) => row.details)).toEqual([{ outcome: 'already_accepted', acceptedWith: 'hand_off',
      basis: 'own-work' }]);
  });

  it('records the basis consent by name for a member holding its own consent (Identity or 0133)', async () => {
    const own = harness({ ownBasis: 'consent' });
    await run(own, accept(1));
    expect(own.audited()[0]!.details).toEqual({ outcome: 'accepted', acceptedWith: 'accept', basis: 'consent' });
    const identity = harness({ ownBasis: null });
    await run(identity, accept(1));
    expect(identity.identity.authorize).toHaveBeenCalledWith(ada, 'write_records', pharmacist);
    expect(identity.audited()[0]!.details).toEqual({ outcome: 'accepted', acceptedWith: 'accept', basis: 'consent' });
  });
});

describe('POST pharmacy/work-items/:workItemId/accept (ORD-4): refusals', () => {
  const nothingWritten = (h: ReturnType<typeof harness>, before = 4) => {
    expect(h.committed.acceptances).toHaveLength(before);
    expect(h.committed.events).toEqual([]);
    expect(h.committed.audits).toEqual([]);
  };

  it('answers 409 IDEMPOTENCY_CONFLICT when this member\'s key recorded another acceptance', async () => {
    const h = harness();
    await run(h, accept(1));
    const conflict = await refusal(run(h, accept(4)));
    expect(conflict).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT',
      message: 'Prescription acceptance conflicts with existing Pharmacy work' });
    // Step 5 comes before step 6: the key is looked up for a route-backed item too, so reusing it there is the same
    // 409, not its route's 200, and no audit row is written for that item.
    await expect(run(h, accept(5))).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT',
      message: 'Prescription acceptance conflicts with existing Pharmacy work' });
    expect(h.audited().filter((row) => row.resourceId === id(5))).toEqual([]);
    // A key a dispensing used for its acceptance is this member's key as well.
    const dispensed = harness();
    await dispensed.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    await expect(run(dispensed, accept(1, pharmacist, dispenseKey))).rejects.toMatchObject({ status: 409,
      code: 'IDEMPOTENCY_CONFLICT' });
    // Another member's key is not this member's: no conflict.
    await expect(run(dispensed, accept(1, secondPharmacist, dispenseKey))).resolves.toMatchObject({
      pharmacyStep: 'dispensed', pharmacistAcceptance: { acceptedWith: 'dispensing' }, alreadyAccepted: true });
  });

  it('answers 409 IDEMPOTENCY_CONFLICT, not a 500, when row-level security hides the key\'s earlier acceptance',
    async () => {
      // This pharmacist accepted another patient's item (20) with acceptKey; since then that patient's consent grant
      // ended, so the key lookup cannot read its row, while the unique key on the member's key still sees it.
      const h = harness({ hiddenAcceptances: [{ n: 20, account: pharmacistAccount, key: acceptKey }] });
      const problem = await refusal(run(h, accept(1)));
      expect(problem).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT',
        message: 'Prescription acceptance conflicts with existing Pharmacy work' });
      // The first 23505 went to DatabaseService's retry (a request with this key may have committed meanwhile); the
      // retry still could not read the row, so the second is the conflict.
      expect(h.transactions.map((transaction) => [transaction.committed, transaction.statements
        .filter((statement) => statement.sql === INSERT_ACCEPTANCE.trim()).length])).toEqual([[false, 1], [false, 1]]);
      nothingWritten(h, 5);
      // Another member's key of the same text is not this member's: no conflict.
      await expect(run(h, accept(1, secondPharmacist))).resolves.toMatchObject({ alreadyAccepted: false });
    });

  it.each([
    ['another request', 7, 'a'.repeat(64)],
    ['this same request', 1, requestDigest('pharmacy.work-item.pharmacist-accept', { workItemId: id(1),
      expectedWorkItemVersion: 1 })],
  ])('answers a key that %s committed while this one ran (23505 on the member\'s key) from the retry, which reads it',
    async (_name, n, digest) => {
      const twin = { id: '67000000-0000-4000-8000-0000000000ab', work_item_id: id(n), facility_id: facilityId,
        patient_id: ada, accepted_by: pharmacistAccount, accepted_by_membership_id: pharmacistMembership,
        accepted_at: at(48), accepted_with: 'accept', idempotency_key: acceptKey, request_sha256: digest,
        correlation_id: 'twin-correlation' };
      const h = harness({ insertErrors: [{ error: uniqueViolation(MEMBER_KEY),
        then: (committed) => { committed.acceptances.push(twin); } }] });
      const answer = run(h, accept(1));
      if (n === 1) {
        await expect(answer).resolves.toEqual({ workItemId: id(1), pharmacyStep: 'accepted', pharmacistAcceptance: {
          acceptedAt: at(48), acceptedByMembershipId: pharmacistMembership, acceptedWith: 'accept' },
        alreadyAccepted: true });
      } else {
        await expect(answer).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      }
      expect(h.transactions.map((transaction) => transaction.committed)).toEqual([false, n === 1]);
      expect(h.transactions[1]!.statements.map((statement) => statement.sql)).not.toContain(INSERT_ACCEPTANCE.trim());
    });

  it('answers 412 when the version differs, before reading or writing any acceptance', async () => {
    const h = harness();
    await expect(run(h, accept(1, pharmacist, acceptKey, 2))).rejects.toMatchObject({ status: 412,
      code: 'PHARMACY_WORK_ITEM_VERSION_CONFLICT', message: 'Dispensing must bind to the exact accepted work-item version' });
    expect(h.last()).not.toContain(ACCEPTANCE_BY_KEY_QUERY.trim());
    nothingWritten(h);
  });

  it('answers 403 PHARMACY_ACCESS_DENIED with no basis to write, and to an emergency (break-glass) session', async () => {
    const none = harness({ ownBasis: null, identity: { allowed: false, breakGlass: false } });
    await expect(run(none, accept(1))).rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED',
      message: 'Pharmacy access is not authorized' });
    nothingWritten(none);
    const breakGlass = harness({ ownBasis: null, identity: { allowed: true, breakGlass: true } });
    await expect(run(breakGlass, accept(1, { ...pharmacist, purposeOfUse: 'emergency' }))).rejects.toMatchObject({
      status: 403, code: 'PHARMACY_ACCESS_DENIED', message: 'Break-glass authorization cannot mutate Pharmacy records' });
    expect(breakGlass.identity.authorize).toHaveBeenCalledWith(ada, 'write_records', expect.objectContaining({
      purposeOfUse: 'emergency' }));
    expect(breakGlass.last()).not.toContain(ACCEPTANCE_BY_KEY_QUERY.trim());
    nothingWritten(breakGlass);
  });

  it('answers 403 to an emergency session that Identity allowed without break-glass (direct care only)', async () => {
    const h = harness({ ownBasis: null, identity: { allowed: true, breakGlass: false } });
    await expect(run(h, accept(1, { ...pharmacist, purposeOfUse: 'emergency' }))).rejects.toMatchObject({ status: 403,
      code: 'PHARMACY_ACCESS_DENIED', message: 'Break-glass authorization cannot mutate Pharmacy records' });
    await expect(run(h, accept(5, { ...pharmacist, purposeOfUse: 'emergency' }))).rejects.toMatchObject({ status: 403,
      code: 'PHARMACY_ACCESS_DENIED' });
    expect(h.transactions.flatMap((transaction) => transaction.statements.map((statement) => statement.sql)))
      .not.toContain(ACCEPTANCE_BY_KEY_QUERY.trim());
    nothingWritten(h);
  });

  describe('in the contract\'s order when a request is refused for more than one reason', () => {
    const lookedUpKey = (h: ReturnType<typeof harness>) => h.transactions.some((transaction) => transaction.statements
      .some((statement) => statement.sql === ACCEPTANCE_BY_KEY_QUERY.trim()));

    it('step 2 before step 3: an emergency session with no basis to write is refused as having no basis', async () => {
      const h = harness({ ownBasis: null, identity: { allowed: false, breakGlass: false } });
      await expect(run(h, accept(1, { ...pharmacist, purposeOfUse: 'emergency' }))).rejects.toMatchObject({
        status: 403, code: 'PHARMACY_ACCESS_DENIED', message: 'Pharmacy access is not authorized' });
      expect(lookedUpKey(h)).toBe(false);
      nothingWritten(h);
    });

    it('step 2 before step 4: no basis to write and a stale version is 403, telling nothing of the version',
      async () => {
        const h = harness({ ownBasis: null, identity: { allowed: false, breakGlass: false } });
        await expect(run(h, accept(1, pharmacist, acceptKey, 2))).rejects.toMatchObject({ status: 403,
          code: 'PHARMACY_ACCESS_DENIED', message: 'Pharmacy access is not authorized' });
        expect(lookedUpKey(h)).toBe(false);
        nothingWritten(h);
      });

    it('step 3 before step 4: an emergency session with a stale version is 403 with the break-glass message',
      async () => {
        const h = harness({ ownBasis: null, identity: { allowed: true, breakGlass: false } });
        await expect(run(h, accept(1, { ...pharmacist, purposeOfUse: 'emergency' }, acceptKey, 2))).rejects
          .toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED',
            message: 'Break-glass authorization cannot mutate Pharmacy records' });
        expect(lookedUpKey(h)).toBe(false);
        nothingWritten(h);
      });

    it('step 4 before step 5: a stale version with a key that recorded another request is 412', async () => {
      const h = harness();
      await run(h, accept(1));
      await expect(run(h, accept(4, pharmacist, acceptKey, 2))).rejects.toMatchObject({ status: 412,
        code: 'PHARMACY_WORK_ITEM_VERSION_CONFLICT' });
      expect(h.last()).not.toContain(ACCEPTANCE_BY_KEY_QUERY.trim());
    });
  });

  it('answers 403 when the steps reader does not answer the item for this session', async () => {
    const h = harness({ stepsHide: [id(1)] });
    await expect(run(h, accept(1))).rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    nothingWritten(h);
  });

  it.each([
    ['none', 404, 'PHARMACY_WORK_ITEM_NOT_FOUND', 'Pharmacy work item was not found'],
    ['closed', 409, 'ORDER_ROUTE_CLOSED', 'This prescription from another facility is closed: stop work on it'],
    ['paused', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE', 'Work on orders from other facilities is paused by Health ID'],
  ] as const)('answers an item this session cannot see (C17 says %s) as a dispensing does: %i %s',
    async (hiddenOutcome, status, code, message) => {
      const h = harness({ hiddenOutcome });
      await expect(run(h, accept(99))).rejects.toMatchObject({ status, code, message });
      const asked = h.transactions[0]!.statements.find((statement) => /order_route_access_for/.test(statement.sql))!;
      expect(asked.values).toEqual([id(99), 'write_records']);
      nothingWritten(h);
    });

  it.each([['closed', 409, 'ORDER_ROUTE_CLOSED'], ['paused', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE']] as const)(
    'answers a visible route-backed item whose route is %s with %i', async (routeOutcome, status, code) => {
      const h = harness({ routeOutcome });
      await expect(run(h, accept(5))).rejects.toMatchObject({ status, code });
      nothingWritten(h);
    });

  it('answers 409 PHARMACY_WORK_ITEM_ALREADY_DISPENSED for an item dispensed before ORD-4, with no acceptance', async () => {
    const h = harness();
    await expect(run(h, accept(6))).rejects.toMatchObject({ status: 409, code: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
      message: 'A full dispensing is already recorded for this work item; partial dispensing is not supported' });
    nothingWritten(h);
  });

  it('answers 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE with the reason for a withdrawn item, before the insert',
    async () => {
      const h = harness();
      const changed = await refusal(run(h, accept(7)));
      expect(changed).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
        message: 'This prescription can no longer be dispensed here', extensions: { withdrawnReason: 'changed' } });
      const elsewhere = await refusal(run(h, accept(8)));
      expect(elsewhere).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
        message: 'This prescription was sent to another pharmacy, so it can no longer be dispensed here',
        extensions: { withdrawnReason: 'sent_elsewhere' } });
      expect(h.transactions.flatMap((transaction) => transaction.statements.map((statement) => statement.sql)))
        .not.toContain(INSERT_ACCEPTANCE.trim());
      nothingWritten(h);
    });

  it.each([
    ['0101\'s source check (not active, or another version)', undefined, undefined],
    ['a withdrawn send (DETAIL changed)', 'changed', 'changed'],
    ['a send elsewhere (DETAIL sent_elsewhere)', 'sent_elsewhere', 'sent_elsewhere'],
    ['a dispensing meanwhile (DETAIL not_claimed)', 'not_claimed', undefined],
  ])('answers the trigger\'s 23514 for %s as 409 not dispensable', async (_name, detail, reason) => {
    const h = harness({ insertErrors: [{ error: sqlError('23514', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', detail) }] });
    const problem = await refusal(run(h, accept(1)));
    expect(problem).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' });
    expect(problem.extensions).toEqual(reason ? { withdrawnReason: reason } : undefined);
    expect(problem.message).toBe(reason === 'sent_elsewhere'
      ? 'This prescription was sent to another pharmacy, so it can no longer be dispensed here'
      : 'This prescription can no longer be dispensed here');
    nothingWritten(h);
  });

  it('passes the trigger\'s other refusals and other errors on unchanged', async () => {
    for (const error of [sqlError('23514', 'Pharmacist acceptance does not match its work item and actor context'),
      sqlError('23514', 'PHARMACY_WORK_ITEM_NOT_SENT_AUTOMATICALLY', 'hand_off'),
      sqlError('42501', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE'), sqlError('57014')]) {
      const h = harness({ insertErrors: [{ error }] });
      await expect(run(h, accept(1))).rejects.toBe(error);
      nothingWritten(h);
    }
  });

  it.each([
    ['without the table (the key lookup, 42P01)', { schema: 'release-a' as const }],
    ['without the reader (42883)', { stepsError: sqlError('42883') }],
    ['when the insert finds no table (42P01)', { insertErrors: [{ error: sqlError('42P01') }] }],
    ['when the insert finds no function (42883)', { insertErrors: [{ error: sqlError('42883') }] }],
  ])('answers 503 PHARMACY_ACCEPTANCE_UNAVAILABLE %s', async (_name, options) => {
    const h = harness(options);
    const problem = await refusal(run(h, accept(1)));
    expect(problem).toMatchObject({ status: 503, code: 'PHARMACY_ACCEPTANCE_UNAVAILABLE',
      message: 'Accepting is not available right now. Please try again.', exposeDetail: true });
    nothingWritten(h);
  });

  it('answers 503 for a route-backed item too on a schema without ORD-4 (its key is still looked up)', async () => {
    await expect(run(harness({ schema: 'release-a' }), accept(5))).rejects.toMatchObject({ status: 503,
      code: 'PHARMACY_ACCEPTANCE_UNAVAILABLE' });
  });

  it('sends the 503 with its words for the person, while every other 5xx stays generic', () => {
    const sent = (problem: DomainProblem) => {
      const json = jest.fn();
      const response = { status: jest.fn(), type: jest.fn(), json };
      response.status.mockReturnValue(response);
      response.type.mockReturnValue(response);
      const host = { switchToHttp: () => ({ getRequest: () => ({ correlationId: 'ord4-filter' }),
        getResponse: () => response }) };
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      new ProblemDetailsFilter().catch(problem, host as never);
      return json.mock.calls[0]![0] as Record<string, unknown>;
    };
    expect(sent(new DomainProblem(503, 'PHARMACY_ACCEPTANCE_UNAVAILABLE', 'Accepting is not available right now. Please try again.',
      undefined, { exposeDetail: true }))).toMatchObject({ status: 503, code: 'PHARMACY_ACCEPTANCE_UNAVAILABLE',
      detail: 'Accepting is not available right now. Please try again.' });
    expect(sent(new DomainProblem(503, 'ORDER_ROUTE_UNAVAILABLE', 'The order route could not be checked')))
      .toMatchObject({ status: 503, detail: 'The service could not complete the request.' });
  });
});

describe('POST pharmacy/work-items/:workItemId/accept (ORD-4): two at once', () => {
  it('answers the loser of a race 200 with the winner\'s acceptance, after DatabaseService runs it again (23505)',
    async () => {
      // The winner commits while this request runs; this insert then meets its row (23505), and the next attempt
      // reads it.
      const winner = { id: '67000000-0000-4000-8000-0000000000aa', work_item_id: id(1), facility_id: facilityId,
        patient_id: ada, accepted_by: otherPharmacistAccount, accepted_by_membership_id: otherPharmacistMembership,
        accepted_at: at(49), accepted_with: 'accept', idempotency_key: 'ord4-winner-key-0001', request_sha256: 'f'.repeat(64),
        correlation_id: 'winner-correlation' };
      const h = harness({ insertErrors: [{ error: uniqueViolation(ITEM_KEY),
        then: (committed) => { committed.acceptances.push(winner); } }] });
      await expect(run(h, accept(1))).resolves.toEqual({ workItemId: id(1), pharmacyStep: 'accepted',
        pharmacistAcceptance: { acceptedAt: at(49), acceptedByMembershipId: otherPharmacistMembership,
          acceptedWith: 'accept' }, alreadyAccepted: true });
      expect(h.transactions.map((transaction) => transaction.committed)).toEqual([false, true]);
      expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toEqual([winner]);
      expect(h.audited().map((row) => row.details)).toEqual([{ outcome: 'already_accepted', acceptedWith: 'accept',
        basis: 'own-work' }]);
    });

  it('runs a cancelled attempt (40001) again and records the acceptance once', async () => {
    const h = harness({ insertErrors: [{ error: sqlError('40001', 'could not serialize access') }] });
    await expect(run(h, accept(1))).resolves.toMatchObject({ alreadyAccepted: false });
    expect(h.transactions.map((transaction) => transaction.committed)).toEqual([false, true]);
    expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toHaveLength(1);
    expect(h.committed.events).toHaveLength(1);
    expect(h.audited()).toHaveLength(1);
  });
});

describe('ORD-4: dispensing a received item accepts it first', () => {
  const dispensingDigest = (n: number) => requestDigest('pharmacy.dispensing.create', { workItemId: id(n), ...dispenseInput });

  it('records the acceptance (dispensing) and its event before the dispensing, in its transaction, and says so in '
    + 'the dispensing\'s audit row', async () => {
    const h = harness();
    const answer = await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(answer).toMatchObject({ workItemId: id(1), status: 'dispensed', effectiveStatus: 'dispensed' });
    expect(answer).not.toHaveProperty('pharmacyStep');
    expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toEqual([expect.objectContaining({
      accepted_with: 'dispensing', accepted_by: pharmacistAccount, accepted_by_membership_id: pharmacistMembership,
      idempotency_key: dispenseKey, request_sha256: dispensingDigest(1) })]);
    expect(h.committed.events).toEqual([[id(1), ada, facilityId, pharmacistAccount, pharmacistMembership,
      PHARMACIST_ACCEPTED_REASON, pharmacist.correlationId]]);
    expect(h.last().map(kind)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'session', 'work item',
      'C17', 'savepoint pharmacy_own_work_access', 'own-work basis', 'release savepoint pharmacy_own_work_access',
      'dispensing replay', 'savepoint pharmacy_own_work_steps', 'steps', 'release savepoint pharmacy_own_work_steps',
      'savepoint pharmacy_dispensing_acceptance', 'insert acceptance', 'insert event',
      'release savepoint pharmacy_dispensing_acceptance', 'insert dispensing', 'outbox', 'audit', 'COMMIT']);
    expect(h.audited()).toEqual([{ action: 'pharmacy.dispensing.create', patientId: ada, resourceType: 'medication-dispensing',
      resourceId: '65000000-0000-4000-8000-0000000000ff', outcome: 'success', details: { workItemId: id(1),
        workItemVersion: 1, status: 'dispensed', basis: 'own-work', acceptedWithDispensing: true } }]);
    // A read now answers it dispensed, accepted with its dispensing.
    const read = await h.service.getWorkItem(pharmacist, id(1));
    expect(read).toMatchObject({ pharmacyStep: 'dispensed', pharmacistAcceptance: { acceptedAt: at(50),
      acceptedByMembershipId: pharmacistMembership, acceptedWith: 'dispensing' } });
  });

  it('records no second acceptance when the same dispensing is sent again (its replay answers first)', async () => {
    const h = harness();
    const first = await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    const replay = await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(replay).toEqual(first);
    expect(h.last().some((sql) => sql === OWN_WORK_STEPS_QUERY.trim() || sql === INSERT_ACCEPTANCE.trim())).toBe(false);
    expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toHaveLength(1);
    expect(h.committed.events).toHaveLength(1);
  });

  it('runs a cancelled dispensing (40001) again and records one acceptance and one dispensing', async () => {
    const h = harness({ dispensingErrors: [sqlError('40001', 'could not serialize access')] });
    await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(h.transactions.map((transaction) => transaction.committed)).toEqual([false, true]);
    expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toHaveLength(1);
    expect(h.committed.dispensings).toHaveLength(1);
    expect(h.audited()[0]!.details).toMatchObject({ acceptedWithDispensing: true });
  });

  it('passes a serialization failure of the acceptance insert on, so the whole dispensing is run again with it', async () => {
    const h = harness({ insertErrors: [{ error: sqlError('40001', 'could not serialize access') }] });
    await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(h.transactions.map((transaction) => transaction.committed)).toEqual([false, true]);
    expect(h.transactions[0]!.statements.map((statement) => statement.sql))
      .not.toContain('rollback to savepoint pharmacy_dispensing_acceptance');
    expect(h.committed.acceptances.filter((row) => row.work_item_id === id(1))).toHaveLength(1);
    expect(h.audited()[0]!.details).toMatchObject({ acceptedWithDispensing: true });
  });

  it.each([
    [2, 'already accepted'],
    [4, 'handed in by hand'],
  ])('writes no acceptance for item %i (%s), and no flag', async (n) => {
    const h = harness();
    await h.service.dispense(pharmacist, id(n), dispenseInput, dispenseKey);
    expect(h.last()).not.toContain(INSERT_ACCEPTANCE.trim());
    expect(h.audited()[0]!.details).not.toHaveProperty('acceptedWithDispensing');
    expect(h.committed.dispensings).toHaveLength(1);
  });

  it('asks no steps for a route-backed item, and dispenses it as before', async () => {
    const h = harness();
    await h.service.dispense(pharmacist, id(5), dispenseInput, dispenseKey);
    expect(h.last().some((sql) => /own_work_item_steps|pharmacy_dispensing_acceptance/.test(sql))).toBe(false);
    expect(h.audited()[0]!.details).toEqual({ workItemId: id(5), workItemVersion: 1, status: 'dispensed',
      basis: 'order-route', orderRouteId: routeId });
  });

  it.each([
    [7, 'This prescription can no longer be dispensed here', undefined],
    [8, 'This prescription was sent to another pharmacy, so it can no longer be dispensed here', 'sent_elsewhere'],
  ])('writes no acceptance for withdrawn item %i, and the dispensing is refused as before', async (n, message, reason) => {
    const h = harness();
    const problem = await refusal(h.service.dispense(pharmacist, id(n), dispenseInput, dispenseKey));
    expect(problem).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', message });
    expect(problem.extensions).toEqual(reason ? { withdrawnReason: reason } : undefined);
    expect(h.transactions[0]!.statements.map((statement) => statement.sql)).not.toContain(INSERT_ACCEPTANCE.trim());
    expect(h.committed.acceptances).toHaveLength(4);
    expect(h.committed.audits).toEqual([]);
  });

  it('is never refused on a schema without ORD-4: the reader\'s savepoint is rolled back, nothing logged', async () => {
    const h = harness({ schema: 'release-a' });
    await expect(h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey)).resolves.toMatchObject({
      status: 'dispensed' });
    expect(h.last()).toContain('rollback to savepoint pharmacy_own_work_steps');
    expect(h.last()).not.toContain('savepoint pharmacy_dispensing_acceptance');
    expect(h.audited()[0]!.details).toEqual({ workItemId: id(1), workItemVersion: 1, status: 'dispensed',
      basis: 'own-work' });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the table missing at the insert (42P01)', sqlError('42P01'), false],
    ['the trigger refusing (23514)', sqlError('23514', 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', 'not_claimed'), true],
    ['an acceptance recorded meanwhile, or the key used before (23505)', sqlError('23505'), true],
    ['a permission refused (42501)', sqlError('42501'), true],
  ])('is never refused because of %s: the acceptance savepoint is rolled back and the dispensing goes on',
    async (_name, error, logged) => {
      const h = harness({ insertErrors: [{ error }] });
      await expect(h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey)).resolves.toMatchObject({
        status: 'dispensed' });
      expect(h.last()).toContain('rollback to savepoint pharmacy_dispensing_acceptance');
      expect(h.committed.acceptances).toHaveLength(4);
      expect(h.committed.dispensings).toHaveLength(1);
      expect(h.audited()[0]!.details).not.toHaveProperty('acceptedWithDispensing');
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(logged ? 1 : 0);
    });

  it('rolls the acceptance back with its event when the event is refused, and dispenses without the flag', async () => {
    const h = harness({ eventError: sqlError('23514', 'Pharmacy work-item event does not match its pharmacist acceptance') });
    await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(h.committed.acceptances).toHaveLength(4);
    expect(h.committed.events).toEqual([]);
    expect(h.committed.dispensings).toHaveLength(1);
    expect(h.audited()[0]!.details).not.toHaveProperty('acceptedWithDispensing');
  });

  it('is never refused when the steps cannot be read (57014): no acceptance, the dispensing as before', async () => {
    const h = harness({ stepsError: sqlError('57014') });
    await expect(h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey)).resolves.toMatchObject({
      status: 'dispensed' });
    expect(h.last()).toContain('rollback to savepoint pharmacy_own_work_steps');
    expect(h.audited()[0]!.details).not.toHaveProperty('acceptedWithDispensing');
  });

  it('passes a serialization failure of the reader on, so the whole dispensing is run again', async () => {
    const h = harness({ stepsError: sqlError('40001') });
    await expect(h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey)).rejects.toMatchObject({
      code: '40001' });
    expect(h.transactions.length).toBeGreaterThan(1);
  });

  it('records no acceptance with a dispensing outside direct care (the trigger would refuse it), asking nothing', async () => {
    const h = harness({ ownBasis: null, identity: { allowed: true, breakGlass: false } });
    await h.service.dispense({ ...pharmacist, purposeOfUse: 'emergency' }, id(1), dispenseInput, dispenseKey);
    expect(h.last().some((sql) => /own_work_item_steps|pharmacy_dispensing_acceptance|work_item_acceptances/.test(sql)))
      .toBe(false);
    expect(h.audited()[0]!.details).not.toHaveProperty('acceptedWithDispensing');
  });

  it('off (the tests\' default), asks nothing new and dispenses as before', async () => {
    const h = harness({ ownWork: false });
    await h.service.dispense(pharmacist, id(1), dispenseInput, dispenseKey);
    expect(h.last().some((sql) => /own_work_item_steps|pharmacy_dispensing_acceptance|work_item_acceptances/.test(sql)))
      .toBe(false);
  });
});

describe('ORD-4: pharmacyStep and pharmacistAcceptance on the work list and a single read', () => {
  const expected: Record<number, { pharmacyStep: string; pharmacistAcceptance: unknown } | undefined> = {
    1: { pharmacyStep: 'received', pharmacistAcceptance: null },
    2: { pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: at(32), acceptedByMembershipId: otherPharmacistMembership,
      acceptedWith: 'accept' } },
    3: { pharmacyStep: 'dispensed', pharmacistAcceptance: { acceptedAt: at(33), acceptedByMembershipId: pharmacistMembership,
      acceptedWith: 'dispensing' } },
    4: { pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: at(4), acceptedByMembershipId: pharmacistMembership,
      acceptedWith: 'hand_off' } },
    5: { pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: at(5), acceptedByMembershipId: routeMemberMembership,
      acceptedWith: 'order_route' } },
    6: { pharmacyStep: 'dispensed', pharmacistAcceptance: null },
    7: { pharmacyStep: 'received', pharmacistAcceptance: null },
    9: { pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: at(39), acceptedByMembershipId: otherPharmacistMembership,
      acceptedWith: 'accept' } },
    10: { pharmacyStep: 'dispensing_reversed', pharmacistAcceptance: { acceptedAt: at(40),
      acceptedByMembershipId: pharmacistMembership, acceptedWith: 'accept' } },
    // Dispensed, each keeps the acceptance it was made with.
    11: { pharmacyStep: 'dispensed', pharmacistAcceptance: { acceptedAt: at(11), acceptedByMembershipId: pharmacistMembership,
      acceptedWith: 'hand_off' } },
    12: { pharmacyStep: 'dispensed', pharmacistAcceptance: { acceptedAt: at(12), acceptedByMembershipId: routeMemberMembership,
      acceptedWith: 'order_route' } },
  };
  const listed = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12];
  const routed = (n: number) => n === 5 || n === 12;
  const fields = (item: Record<string, unknown>) => ('pharmacyStep' in item || 'pharmacistAcceptance' in item
    ? { pharmacyStep: item.pharmacyStep, pharmacistAcceptance: item.pharmacistAcceptance } : undefined);

  it('answers each origin\'s step and acceptance on the list, with one reader statement', async () => {
    const h = harness();
    const page = await h.service.listWorkItems(pharmacist);
    const items = page.items as unknown as Record<string, unknown>[];
    expect(items.map((item) => item.id)).toEqual(listed.map(id));
    expect(Object.fromEntries(items.map((item, index) => [listed[index], fields(item)])))
      .toEqual(Object.fromEntries(listed.map((n) => [n, expected[n]])));
    // `withdrawn` stays a separate flag (received or accepted), and status and acceptedAt are as before.
    expect(items.map((item) => [item.withdrawn === true ? item.withdrawnReason : null, item.status, item.acceptedAt]))
      .toEqual(listed.map((n) => [n === 7 || n === 9 ? 'changed' : null, 'accepted', at(n)]));
    const readers = h.last().filter((sql) => sql === OWN_WORK_STEPS_QUERY.trim() || sql === OWN_WORK_STATES_QUERY.trim());
    expect(readers).toEqual([OWN_WORK_STEPS_QUERY.trim()]);
    expect(h.transactions[0]!.statements.find((statement) => statement.sql === OWN_WORK_STEPS_QUERY.trim())!.values)
      .toEqual([listed.filter((n) => !routed(n)).map(id)]);
    // The list's audit rows are as before: the collection, and the own patient with 0133's basis.
    expect(h.audited().map((row) => [row.action, row.patientId, row.details])).toEqual([
      ['pharmacy.work-item.list', null, { returnedCount: listed.length }],
      ['pharmacy.work-item.list', ada, { basis: 'own-work', workItemIds: listed.filter((n) => !routed(n)).map(id) }]]);
  });

  it('answers the same on a single read of each', async () => {
    const h = harness();
    for (const n of [...listed, 8]) {
      const item = await h.service.getWorkItem(pharmacist, id(n)) as unknown as Record<string, unknown>;
      expect([n, fields(item)]).toEqual([n, expected[n] ?? { pharmacyStep: 'received', pharmacistAcceptance: null }]);
      expect(item).toMatchObject({ status: 'accepted', acceptedAt: at(n) });
    }
    // An item sent elsewhere is read by id: received here, withdrawn and why.
    await expect(h.service.getWorkItem(pharmacist, id(8))).resolves.toMatchObject({ withdrawn: true,
      withdrawnReason: 'sent_elsewhere' });
  });

  it('answers neither field on an own item on a schema without ORD-4\'s reader, and keeps 0133\'s flag', async () => {
    const h = harness({ schema: 'release-a' });
    const page = await h.service.listWorkItems(pharmacist);
    expect((page.items as unknown as Record<string, unknown>[]).map((item) => [item.id, fields(item)])).toEqual(
      listed.map((n) => [id(n), routed(n) ? expected[n] : undefined]));
    expect(page.items.filter((item) => 'withdrawn' in item).map((item) => item.id)).toEqual([id(7), id(9)]);
    for (const n of [1, 4, 6, 11]) {
      expect(fields(await h.service.getWorkItem(pharmacist, id(n)) as unknown as Record<string, unknown>)).toBeUndefined();
    }
    // A route-backed item's acceptance is its own row's, whatever the schema.
    for (const n of [5, 12]) {
      expect(fields(await h.service.getWorkItem(pharmacist, id(n)) as unknown as Record<string, unknown>))
        .toEqual(expected[n]);
    }
  });

  it('answers neither field (and no withdrawn flag) on a single read whose steps cannot be read', async () => {
    const h = harness({ stepsError: sqlError('57014') });
    const item = await h.service.getWorkItem(pharmacist, id(9)) as unknown as Record<string, unknown>;
    expect(fields(item)).toBeUndefined();
    expect(item).not.toHaveProperty('withdrawn');
  });

  it('fails the list when the steps fail (its audit rows need the basis), as 0133\'s reader did', async () => {
    const h = harness({ stepsError: sqlError('57014') });
    await expect(h.service.listWorkItems(pharmacist)).rejects.toMatchObject({ code: '57014' });
    expect(h.committed.audits).toEqual([]);
  });

  it('answers a replayed hand-off (accept-ehr-prescription) as the single read does', async () => {
    const h = harness();
    const input = { patientId: ada, orderingFacilityId: facilityId, sourceEhrPrescriptionId: workRow(ITEMS[3]!)
      .source_ehr_prescription_id, sourceEhrPrescriptionVersion: 2, sourceEncounterId: '70000000-0000-4000-8000-0000000000b1',
    sourceStatus: 'active' as const, medicationDisplay: 'Amoxicillin 500 mg capsule', frequency: 'Every 8 hours',
    instructions: 'After food', prescribedBy: doctorAccount, prescribedAt: '2026-11-20T09:04:00.000Z',
    acceptanceReason: 'Handed in at the counter' };
    const database = (h.service as unknown as { database: DatabaseService }).database;
    const original = database.withTransaction.bind(database);
    database.withTransaction = (async (context: DataAccessContext, operation: (client: PoolClient) => Promise<unknown>,
      options?: unknown) => original(context, (client: PoolClient) => operation({ query: async (sql: string,
      values?: unknown[]) => {
      if (/or w\.source_ehr_prescription_id=\$4/.test(sql)) {
        return { rows: [{ ...workRow(ITEMS[3]!), request_sha256: requestDigest('pharmacy.work-item.accept-ehr-prescription',
          input) }] };
      }
      return (client.query as unknown as (s: string, v?: unknown[]) => Promise<unknown>)(sql, values);
    } } as unknown as PoolClient), options as never)) as typeof database.withTransaction;
    const answer = await h.service.acceptPrescription(pharmacist, input as never, 'ord4-handoff-key-0001') as unknown as
      Record<string, unknown>;
    expect(fields(answer)).toEqual(expected[4]);
  });
});

describe('PharmacyOwnWork.steps and the steps in states (ORD-4)', () => {
  const stepsRow = (n: number, extra: Record<string, unknown> = {}) => ({ work_item_id: id(n), basis: 'own-work',
    withdrawn: false, withdrawn_reason: null, sent_automatically: true, accepted_at: null,
    accepted_by_membership_id: null, accepted_with: null, ...extra });
  const client = (answer: (sql: string, values: unknown[]) => unknown[] | Error) => {
    const statements: { sql: string; values: unknown[] }[] = [];
    return { statements, client: { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      const rows = answer(sql, values);
      if (rows instanceof Error) throw rows;
      return { rows };
    }) } as unknown as PoolClient };
  };

  it('reads the steps, an acceptance only when it reads cleanly, else no steps for that item', async () => {
    const { client: pool } = client((sql) => (sql === OWN_WORK_STEPS_QUERY ? [
      stepsRow(1),
      stepsRow(2, { accepted_at: at(2), accepted_by_membership_id: pharmacistMembership, accepted_with: 'accept' }),
      stepsRow(3, { accepted_at: '2026-11-20T09:03:00.000Z', accepted_by_membership_id: pharmacistMembership,
        accepted_with: 'dispensing' }),
      stepsRow(4, { sent_automatically: false }),
      stepsRow(5, { accepted_at: at(5), accepted_by_membership_id: pharmacistMembership, accepted_with: 'hand_off' }),
      stepsRow(6, { accepted_at: at(6), accepted_by_membership_id: null, accepted_with: 'accept' }),
      stepsRow(7, { sent_automatically: null }),
      stepsRow(8, { withdrawn: true, withdrawn_reason: 'sent_elsewhere' }),
      stepsRow(9, { basis: 'route' }),
    ] : []));
    const states = await new PharmacyOwnWork(true).steps(pool, [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id), 'c');
    expect([...states!.entries()]).toEqual([
      [id(1), { basis: 'own-work', withdrawn: false, steps: { sentAutomatically: true, acceptance: null } }],
      [id(2), { basis: 'own-work', withdrawn: false, steps: { sentAutomatically: true, acceptance: { acceptedAt: at(2),
        acceptedByMembershipId: pharmacistMembership, acceptedWith: 'accept' } } }],
      [id(3), { basis: 'own-work', withdrawn: false, steps: { sentAutomatically: true, acceptance: { acceptedAt: at(3),
        acceptedByMembershipId: pharmacistMembership, acceptedWith: 'dispensing' } } }],
      [id(4), { basis: 'own-work', withdrawn: false, steps: { sentAutomatically: false, acceptance: null } }],
      // Never guessed: a way the table does not know, an acceptance without its member, no sent flag.
      [id(5), { basis: 'own-work', withdrawn: false }],
      [id(6), { basis: 'own-work', withdrawn: false }],
      [id(7), { basis: 'own-work', withdrawn: false }],
      [id(8), { basis: 'own-work', withdrawn: true, withdrawnReason: 'sent_elsewhere',
        steps: { sentAutomatically: true, acceptance: null } }]]);
  });

  it('answers undefined without the reader (42883), after rolling its savepoint back', async () => {
    const { client: pool, statements } = client((sql) => (sql === OWN_WORK_STEPS_QUERY ? sqlError('42883') : []));
    expect(await new PharmacyOwnWork(true).steps(pool, [id(1)], 'c')).toBeUndefined();
    expect(statements.map((statement) => statement.sql)).toEqual(['savepoint pharmacy_own_work_steps',
      OWN_WORK_STEPS_QUERY, 'rollback to savepoint pharmacy_own_work_steps']);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('passes another failure on after rolling back (logged), and a serialization failure without rolling back', async () => {
    const timeout = sqlError('57014');
    const failing = client((sql) => (sql === OWN_WORK_STEPS_QUERY ? timeout : []));
    await expect(new PharmacyOwnWork(true).steps(failing.client, [id(1)], 'c')).rejects.toBe(timeout);
    expect(failing.statements.map((statement) => statement.sql)).toContain('rollback to savepoint pharmacy_own_work_steps');
    expect(Logger.prototype.warn).toHaveBeenCalledWith({ message: 'Own pharmacy work steps could not be read',
      sqlState: '57014', correlationId: 'c' });
    const conflict = sqlError('40001');
    const cancelled = client((sql) => (sql === OWN_WORK_STEPS_QUERY ? conflict : []));
    await expect(new PharmacyOwnWork(true).steps(cancelled.client, [id(1)], 'c')).rejects.toBe(conflict);
    expect(cancelled.statements.map((statement) => statement.sql)).not.toContain('rollback to savepoint pharmacy_own_work_steps');
  });

  it('off, or with no ids, sends nothing', async () => {
    const { client: pool, statements } = client(() => []);
    expect(await OWN_WORK_OFF.steps(pool, [id(1)], 'c')).toBeUndefined();
    expect(await new PharmacyOwnWork(true).steps(pool, [], 'c')).toEqual(new Map());
    expect(statements).toEqual([]);
  });

  it('reads at most 200 ids a statement, in steps and in states', async () => {
    const asked: number[] = [];
    const { client: pool } = client((sql, values) => {
      if (sql === OWN_WORK_STEPS_QUERY) asked.push((values[0] as string[]).length);
      return [];
    });
    const ids = Array.from({ length: 401 }, (_, n) => id(n + 1));
    await new PharmacyOwnWork(true).steps(pool, ids, 'c');
    await new PharmacyOwnWork(true).states(pool, ids, 'c', 'audit');
    expect(asked).toEqual([200, 200, 1, 200, 200, 1]);
  });

  it('in states, asks ORD-4\'s reader first and keeps to it; 0133\'s reader only on 42883, for every batch', async () => {
    const present = client((sql, values) => (sql === OWN_WORK_STEPS_QUERY
      ? (values[0] as string[]).map((workItemId) => ({ ...stepsRow(1), work_item_id: workItemId }))
      : sql === OWN_WORK_STATES_QUERY ? sqlError('XX000') : []));
    const found = await new PharmacyOwnWork(true).states(present.client, [id(1), id(2)], 'c', 'audit');
    expect(found!.get(id(2))).toEqual({ basis: 'own-work', withdrawn: false,
      steps: { sentAutomatically: true, acceptance: null } });
    expect(present.statements.map((statement) => statement.sql)).toEqual(['savepoint pharmacy_own_work_states',
      OWN_WORK_STEPS_QUERY, 'release savepoint pharmacy_own_work_states']);
    const missing = client((sql, values) => (sql === OWN_WORK_STEPS_QUERY ? sqlError('42883')
      : sql === OWN_WORK_STATES_QUERY ? (values[0] as string[]).map((workItemId) => ({ work_item_id: workItemId,
        basis: 'consent', withdrawn: false, withdrawn_reason: null })) : []));
    const ids = Array.from({ length: 201 }, (_, n) => id(n + 1));
    const fallback = await new PharmacyOwnWork(true).states(missing.client, ids, 'c', 'flag');
    expect(fallback.get(id(201))).toEqual({ basis: 'consent', withdrawn: false });
    expect(missing.statements.map((statement) => [statement.sql, (statement.values[0] as string[] | undefined)?.length]))
      .toEqual([['savepoint pharmacy_own_work_states', undefined], [OWN_WORK_STEPS_QUERY, 200],
        ['rollback to savepoint pharmacy_own_work_states', undefined], [OWN_WORK_STATES_QUERY, 200],
        [OWN_WORK_STATES_QUERY, 1], ['release savepoint pharmacy_own_work_states', undefined]]);
  });

  it('asks pharmacy.own_work_item_steps for exactly the SPEC\'s columns', () => {
    const flat = OWN_WORK_STEPS_QUERY.replace(/\s+/g, ' ').trim();
    expect(flat).toBe('select work_item_id::text as work_item_id, basis, withdrawn, withdrawn_reason, sent_automatically, '
      + 'accepted_at, accepted_by_membership_id::text as accepted_by_membership_id, accepted_with '
      + 'from pharmacy.own_work_item_steps($1::uuid[])');
  });
});
