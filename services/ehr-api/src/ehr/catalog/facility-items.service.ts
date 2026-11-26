import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import { DatabaseService } from '../../database/database.service';
import { FACILITY_ITEM_LIST_LIMIT } from './catalog.dto';
import type {
  CATALOG_LAB_CATEGORIES, CatalogDoseForm, CreateFacilityItemDto, FacilityItemKind, UpdateFacilityItemDto,
} from './catalog.dto';
import { FACILITY_CODE_SYSTEM, catalogUnavailable, type CatalogCaller } from './catalog.service';

/**
 * ORD-7, third slice (0155): a facility's own medicines and lab tests, kept
 * by its hospital administrator (ehr.catalog.facility-item.write, admin only).
 * An item is ordered under the code system HID-FACILITY with its id as the
 * code; it holds no patient, so there is no X-Purpose-Of-Use and no patient
 * audit row. Every call runs in a staff transaction with the session's
 * facility, account and membership (app.facility_id, app.actor_subject,
 * app.membership_id), which 0155's row security checks again: a session
 * reads and writes only its own facility's items, and writes only with the
 * permission. The list, each add and each change (even one that changes
 * nothing) write their audit row in the same transaction, so an answer is
 * never sent unaudited.
 */

/** The Idempotency-Key's operation, part of the request digest kept on the row. */
export const FACILITY_ITEM_CREATE_OPERATION = 'ehr.catalog.facility-item.create';

interface FacilityItemFields {
  /** The item's id: the code under HID-FACILITY, 36 characters, lower case. */
  itemId: string;
  codeSystem: typeof FACILITY_CODE_SYSTEM;
  code: string;
  display: string;
  matchedName: null;
  scope: 'facility';
  /** false once withdrawn: never offered again until brought back, and never deleted. */
  active: boolean;
  rowVersion: number;
  addedAt: string;
  /** When it was last withdrawn or brought back; null before any change. */
  changedAt: string | null;
}

/** A medicine of the facility's own, in the medicine search's shape (planned contract, ORD-7). */
export interface FacilityMedicine extends FacilityItemFields {
  kind: 'medicine';
  genericName: string;
  strength: string | null;
  doseForm: CatalogDoseForm | null;
  doseFormText: null;
  routes: string[];
  atcCode: null;
  commonAdultDose: null;
  source: 'facility';
}

/** A lab test of the facility's own, in the lab-test search's shape. */
export interface FacilityLabTest extends FacilityItemFields {
  kind: 'lab_test';
  otherNames: string[];
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number] | null;
}

export type FacilityItem = FacilityMedicine | FacilityLabTest;

export interface FacilityItemList {
  items: FacilityItem[];
  /** true when the facility has more than 1,000 items of the kind asked (or of both), active and withdrawn. */
  more: boolean;
}

export interface FacilityItemRow extends QueryResultRow {
  id: string;
  kind: FacilityItemKind;
  display: string;
  generic_name: string | null;
  strength: string | null;
  dose_form: CatalogDoseForm | null;
  routes: string[] | null;
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number] | null;
  active: boolean;
  row_version: string | number;
  created_at: Date | string;
  changed_at: Date | string | null;
}

interface KeyedRow extends FacilityItemRow {
  request_sha256: string;
}

const ITEM_COLUMNS = `id, kind, display, generic_name, strength, dose_form, routes, specimen, category, active, row_version,
  created_at, changed_at`;

/** This facility's items, the active first, then A to Z ("C" collation) and the id; one more than the limit, to say more. */
export const FACILITY_ITEMS_LIST_SQL = `select ${ITEM_COLUMNS}
  from ehr.catalog_facility_items
 where facility_id = $1 and ($2::text is null or kind = $2)
 order by kind collate "C", active desc, lower(display) collate "C", id
 limit ${FACILITY_ITEM_LIST_LIMIT + 1}`;

/** The item an Idempotency-Key already made, for this account at this facility. */
export const FACILITY_ITEM_BY_KEY_SQL = `select ${ITEM_COLUMNS}, request_sha256
  from ehr.catalog_facility_items
 where facility_id = $1 and created_by = platform.current_account_id() and idempotency_key = $2`;

/**
 * The account and membership come from the session readers, as 0155's
 * insert policy compares them. A second request with the same key, sent
 * while the first is still open, waits for it and inserts nothing.
 */
export const FACILITY_ITEM_INSERT_SQL = `insert into ehr.catalog_facility_items (facility_id, kind, display, generic_name,
  strength, dose_form, routes, specimen, category, idempotency_key, request_sha256, created_by, created_by_membership_id)
values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, $11, platform.current_account_id(),
  platform.current_membership_id())
on conflict on constraint catalog_facility_items_key_uq do nothing
returning ${ITEM_COLUMNS}`;

/** Locks the item; 0155's update policy shows it only to a session that may write it. */
export const FACILITY_ITEM_LOCK_SQL = `select ${ITEM_COLUMNS}
  from ehr.catalog_facility_items
 where id = $1 and facility_id = $2
 for update`;

/** Whether an item the lock did not find is there to read, and whether the session may write items. */
export const FACILITY_ITEM_MISSING_SQL = `select exists (select 1 from ehr.catalog_facility_items
   where id = $1 and facility_id = $2) as found,
  coalesce((select ehr.facility_item_write_allowed()), false) as allowed`;

/** Only active, row_version and the three "changed" columns change (0155's guard refuses anything else). */
export const FACILITY_ITEM_UPDATE_SQL = `update ehr.catalog_facility_items
   set active = $3, row_version = row_version + 1, changed_by = platform.current_account_id(),
       changed_by_membership_id = platform.current_membership_id(), changed_at = clock_timestamp()
 where id = $1 and facility_id = $2 and row_version = $4
returning ${ITEM_COLUMNS}`;

const iso = (value: Date | string): string => new Date(value).toISOString();

/** A row as the routes answer it: the search's shape, with the item's id, state and times. */
export function facilityItem(row: FacilityItemRow): FacilityItem {
  const common = {
    itemId: row.id, codeSystem: FACILITY_CODE_SYSTEM, code: row.id, display: row.display, matchedName: null,
    scope: 'facility' as const, active: row.active, rowVersion: Number(row.row_version), addedAt: iso(row.created_at),
    changedAt: row.changed_at === null ? null : iso(row.changed_at),
  } satisfies FacilityItemFields;
  if (row.kind === 'medicine') {
    return { ...common, kind: 'medicine', genericName: row.generic_name ?? '', strength: row.strength,
      doseForm: row.dose_form, doseFormText: null, routes: row.routes ?? [], atcCode: null, commonAdultDose: null,
      source: 'facility' };
  }
  return { ...common, kind: 'lab_test', otherNames: [], specimen: row.specimen, category: row.category };
}

export function facilityItemNotFound(): DomainProblem {
  return new DomainProblem(404, 'CATALOG_ITEM_NOT_FOUND', 'This list item was not found at this facility.');
}

export function facilityItemExists(): DomainProblem {
  return new DomainProblem(409, 'FACILITY_ITEM_EXISTS', 'This facility already has an active item with this name.');
}

export function facilityItemLimit(): DomainProblem {
  return new DomainProblem(409, 'FACILITY_ITEM_LIMIT', 'This facility already has 500 items of this kind. Withdraw one first.');
}

export function facilityItemVersionConflict(): DomainProblem {
  return new DomainProblem(412, 'VERSION_CONFLICT', 'This item changed since it was loaded. Reload and try again.');
}

export function idempotencyKeyReused(): DomainProblem {
  return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
}

function permissionDenied(): DomainProblem {
  return new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
}

interface DatabaseErrorFields { code?: unknown; message?: unknown; constraint?: unknown; schema?: unknown; table?: unknown }

function databaseError(error: unknown): DatabaseErrorFields {
  return typeof error === 'object' && error !== null ? error as DatabaseErrorFields : {};
}

/**
 * 0155's refusals in the contract's words. The name index (23505 on
 * catalog_facility_items_active_name_uq) is FACILITY_ITEM_EXISTS; the guard's
 * 501st active item (P0001) is FACILITY_ITEM_LIMIT; row security refusing a
 * write (42501: the database no longer finds the permission the session
 * named) is the guards' PERMISSION_DENIED; a check of ehr.catalog_facility_items
 * or the guard's route check (23514), which the request's validation should
 * have caught, is VALIDATION_FAILED. A schema without 0155 (42P01, 42883) and
 * any other failure, another table's check included (an audit row's), is 503
 * CATALOG_UNAVAILABLE, logged with its SQLSTATE only (never a name).
 */
export function facilityItemProblem(error: unknown, logger: Logger): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const { code, message, constraint, schema, table } = databaseError(error);
  if (code === '23505' && constraint === 'catalog_facility_items_active_name_uq') return facilityItemExists();
  if (code === 'P0001' && message === 'FACILITY_ITEM_LIMIT') return facilityItemLimit();
  if (code === '42501') return permissionDenied();
  if (code === '23514' && ((schema === 'ehr' && table === 'catalog_facility_items')
    || message === 'FACILITY_ITEM_ROUTES_INVALID')) {
    return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.');
  }
  if (code !== '42P01' && code !== '42883') {
    logger.warn(`Facility items failed (${typeof code === 'string' ? code : 'no database code'})`);
  }
  return catalogUnavailable();
}

/** The fields kept on the row, from the validated body, absent ones as null (the digest covers the body as sent). */
function insertValues(caller: CatalogCaller, input: CreateFacilityItemDto, idempotencyKey: string, digest: string): unknown[] {
  return [caller.facilityId, input.kind, input.display, input.genericName ?? null, input.strength ?? null,
    input.doseForm ?? null, input.routes ?? [], input.specimen ?? null, input.category ?? null, idempotencyKey, digest];
}

@Injectable()
export class FacilityItemsService {
  private readonly logger = new Logger(FacilityItemsService.name);

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  /** GET: this facility's items, active and withdrawn, at most 1,000. The read and its audit row commit together. */
  async list(caller: CatalogCaller, kind: FacilityItemKind | undefined): Promise<FacilityItemList> {
    try {
      return await this.database.withStaffTransaction(caller, async (client) => {
        const rows = (await client.query<FacilityItemRow>(FACILITY_ITEMS_LIST_SQL, [caller.facilityId, kind ?? null])).rows;
        const items = rows.slice(0, FACILITY_ITEM_LIST_LIMIT).map(facilityItem);
        await this.record(client, caller, 'ehr.catalog.facility-item.list-read', undefined,
          { kind: kind ?? 'all', resultCount: items.length });
        return { items, more: rows.length > FACILITY_ITEM_LIST_LIMIT };
      });
    } catch (error) {
      throw facilityItemProblem(error, this.logger);
    }
  }

  /**
   * POST: adds an item, active, at row version 1. The Idempotency-Key and the
   * request's sha256 stay on the row: the same key with the same body answers
   * the item that key made (as it is now), and with another body 409
   * IDEMPOTENCY_KEY_REUSED. The name and the 500-item limit are 0155's checks.
   */
  async create(caller: CatalogCaller, input: CreateFacilityItemDto, idempotencyKey: string): Promise<FacilityItem> {
    const digest = requestDigest(FACILITY_ITEM_CREATE_OPERATION, input);
    try {
      return await this.database.withStaffTransaction(caller, async (client) => {
        const replay = await this.byKey(client, caller, idempotencyKey, digest);
        if (replay) return this.created(client, caller, replay, true);
        const inserted = (await client.query<FacilityItemRow>(FACILITY_ITEM_INSERT_SQL,
          insertValues(caller, input, idempotencyKey, digest))).rows[0];
        if (inserted) return this.created(client, caller, inserted, false);
        // Another request with this key committed while this one waited.
        const raced = await this.byKey(client, caller, idempotencyKey, digest);
        if (!raced) throw new Error('The Idempotency-Key row was not found after its conflict');
        return this.created(client, caller, raced, true);
      });
    } catch (error) {
      throw facilityItemProblem(error, this.logger);
    }
  }

  /**
   * PATCH: withdraws an item or brings it back, at the row version the
   * screen loaded (412 VERSION_CONFLICT otherwise). Asked for the state it is
   * already in, it answers the item unchanged and changes no row; its audit
   * row says so (unchanged: true, the same row version). Bringing an item
   * back is held to the name index and the 500-item limit, as an add is.
   */
  async update(caller: CatalogCaller, itemId: string, input: UpdateFacilityItemDto): Promise<FacilityItem> {
    try {
      return await this.database.withStaffTransaction(caller, async (client) => {
        const current = (await client.query<FacilityItemRow>(FACILITY_ITEM_LOCK_SQL, [itemId, caller.facilityId])).rows[0];
        if (!current) {
          const missing = (await client.query<{ found: boolean; allowed: boolean }>(FACILITY_ITEM_MISSING_SQL,
            [itemId, caller.facilityId])).rows[0];
          throw missing?.found === true && missing.allowed !== true ? permissionDenied() : facilityItemNotFound();
        }
        if (Number(current.row_version) !== input.expectedRowVersion) throw facilityItemVersionConflict();
        if (current.active === input.active) {
          await this.record(client, caller, 'ehr.catalog.facility-item.changed', current.id, {
            kind: current.kind, active: current.active, rowVersion: Number(current.row_version),
            previousRowVersion: Number(current.row_version), unchanged: true,
          });
          return facilityItem(current);
        }
        const changed = (await client.query<FacilityItemRow>(FACILITY_ITEM_UPDATE_SQL,
          [itemId, caller.facilityId, input.active, input.expectedRowVersion])).rows[0];
        if (!changed) throw facilityItemVersionConflict();
        await this.record(client, caller, 'ehr.catalog.facility-item.changed', changed.id, {
          kind: changed.kind, active: changed.active, rowVersion: Number(changed.row_version),
          previousRowVersion: Number(current.row_version), unchanged: false,
        });
        return facilityItem(changed);
      });
    } catch (error) {
      throw facilityItemProblem(error, this.logger);
    }
  }

  /** The row this key made, when the digest matches; 409 when the key was used with another body. */
  private async byKey(client: PoolClient, caller: CatalogCaller, idempotencyKey: string, digest: string):
  Promise<FacilityItemRow | undefined> {
    const row = (await client.query<KeyedRow>(FACILITY_ITEM_BY_KEY_SQL, [caller.facilityId, idempotencyKey])).rows[0];
    if (!row) return undefined;
    if (row.request_sha256 !== digest) throw idempotencyKeyReused();
    return row;
  }

  private async created(client: PoolClient, caller: CatalogCaller, row: FacilityItemRow, idempotentReplay: boolean):
  Promise<FacilityItem> {
    await this.record(client, caller, 'ehr.catalog.facility-item.created', row.id, { kind: row.kind, idempotentReplay });
    return facilityItem(row);
  }

  /** The audit row, with the item and the actor; never a name the item carries. */
  private async record(client: PoolClient, caller: CatalogCaller, action: string, itemId: string | undefined,
    details: Readonly<Record<string, unknown>>): Promise<void> {
    await this.audit.recordWithClient(client, {
      correlationId: caller.correlationId,
      actorType: 'staff',
      actorSubject: caller.subject,
      actorAccountId: caller.accountId,
      actorMembershipId: caller.membershipId,
      organizationId: caller.organizationId,
      facilityId: caller.facilityId,
      action,
      resourceType: itemId === undefined ? 'catalog-facility-items' : 'catalog-facility-item',
      ...(itemId === undefined ? {} : { resourceId: itemId }),
      outcome: 'success',
      details,
    });
  }
}
