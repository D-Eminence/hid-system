import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { StaffAccountContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { databaseMessage, isDatabaseError } from '../patient-safety/database-error';
import {
  isShortcutModuleKey, SHORTCUT_KEY_SHAPE, shortcutAvailable, STAFF_LANGUAGES, STAFF_NOTICE_DEFAULTS, STAFF_SHORTCUTS_MAX,
} from './staff-preferences';

/** 0206's read: the caller's language and version, and the request membership's shortcuts (nulls without one). */
export const READ_STAFF_PREFERENCES_SQL = `select read.preferences_language,
       read.preferences_version::text as preferences_version,
       read.shortcuts_facility_id::text as shortcuts_facility_id,
       read.shortcuts_modules,
       read.shortcuts_version::text as shortcuts_version
  from identity.read_my_staff_preferences() read`;

/** 0206's preferences save: $1 language, $2 expected version, $3 Idempotency-Key, $4 request SHA-256. */
export const SAVE_STAFF_PREFERENCES_SQL = `select saved.replayed
  from identity.save_my_staff_preferences($1::text, $2::bigint, $3::text, $4::text) saved`;

/** 0206's shortcuts save: $1 module keys in order, $2 expected version, $3 Idempotency-Key, $4 request SHA-256. */
export const SAVE_STAFF_SHORTCUTS_SQL = `select saved.replayed
  from identity.save_my_staff_shortcuts($1::text[], $2::bigint, $3::text, $4::text) saved`;

/** The operations the request digests are taken under (requestDigest). */
export const STAFF_PREFERENCES_OPERATION = 'auth.staff-preferences.update';
export const STAFF_SHORTCUTS_OPERATION = 'identity.staff-shortcuts.update';

interface ReadRow extends QueryResultRow {
  preferences_language: string;
  preferences_version: string;
  shortcuts_facility_id: string | null;
  shortcuts_modules: string[] | null;
  shortcuts_version: string | null;
}

export interface StaffShortcutItem {
  module: string;
  available: boolean;
}

export interface StaffPreferencesAnswer {
  version: number;
  language: string;
  languagesAvailable: string[];
  notices: typeof STAFF_NOTICE_DEFAULTS;
  shortcuts: { facilityId: string; version: number; max: number; items: StaffShortcutItem[] } | null;
}

export type StaffPreferencesSaveAnswer = StaffPreferencesAnswer & { replayed: boolean };

export const STAFF_PREFERENCES_MESSAGES = Object.freeze({
  languageNotAvailable: 'Only English is available for now.',
  tooMany: `You can keep up to ${STAFF_SHORTCUTS_MAX} shortcuts.`,
  unknown: 'One of these shortcuts is not a page Health ID knows. Reload and try again.',
  duplicate: 'Each shortcut can appear only once.',
  notAllowed: 'Your role here cannot open one of these pages.',
  versionConflict: 'This changed meanwhile; reload before retrying.',
  keyReused: 'This request was already used for a different change. Please reload and try again.',
  keyRequired: 'Please try again.',
  invalid: 'Check the highlighted fields.',
  unavailable: 'Your settings could not be loaded. Please try again.',
  signInAgain: 'Valid authentication is required',
  facilityDenied: 'You are not working at this facility.',
});

/**
 * Refusals of the shortcuts the database cannot make itself: it stores any
 * key of the right shape, so which keys exist (SX-1's) and which this
 * membership may use now are checked here, before the save. A key already
 * saved for this membership may be sent again and is kept, even when the
 * member's roles no longer show it, and even when this image does not know
 * it (a key of a newer image, or one since retired): it is then answered
 * available: false, never an error. Such a key must still have 0206's shape,
 * so no UUID, Health ID or match reference passes as "kept".
 */
export function shortcutRefusal(modules: readonly string[], kept: ReadonlySet<string>,
  permissions: readonly string[]): DomainProblem | undefined {
  if (modules.length > STAFF_SHORTCUTS_MAX) {
    return new DomainProblem(400, 'SHORTCUTS_TOO_MANY', STAFF_PREFERENCES_MESSAGES.tooMany);
  }
  if (!modules.every((module) => isShortcutModuleKey(module) || (kept.has(module) && SHORTCUT_KEY_SHAPE.test(module)))) {
    return new DomainProblem(400, 'SHORTCUT_UNKNOWN', STAFF_PREFERENCES_MESSAGES.unknown);
  }
  if (new Set(modules).size !== modules.length) {
    return new DomainProblem(400, 'SHORTCUT_DUPLICATE', STAFF_PREFERENCES_MESSAGES.duplicate);
  }
  if (modules.some((module) => !kept.has(module) && !shortcutAvailable(module, permissions))) {
    return new DomainProblem(400, 'SHORTCUT_NOT_ALLOWED', STAFF_PREFERENCES_MESSAGES.notAllowed);
  }
  return undefined;
}

/** 0206's refusals as HTTP problems; anything unexpected is 503 PREFERENCES_UNAVAILABLE (no diagnostic). */
export function staffPreferencesProblem(error: unknown): unknown {
  if (error instanceof DomainProblem) return error;
  if (!isDatabaseError(error)) {
    return new DomainProblem(503, 'PREFERENCES_UNAVAILABLE', STAFF_PREFERENCES_MESSAGES.unavailable);
  }
  const message = databaseMessage(error);
  if (error.code === '22023') {
    switch (message) {
      case 'LANGUAGE_NOT_AVAILABLE':
        return new DomainProblem(400, 'LANGUAGE_NOT_AVAILABLE', STAFF_PREFERENCES_MESSAGES.languageNotAvailable);
      case 'SHORTCUTS_TOO_MANY':
        return new DomainProblem(400, 'SHORTCUTS_TOO_MANY', STAFF_PREFERENCES_MESSAGES.tooMany);
      case 'SHORTCUT_INVALID':
        return new DomainProblem(400, 'SHORTCUT_UNKNOWN', STAFF_PREFERENCES_MESSAGES.unknown);
      case 'SHORTCUT_DUPLICATE':
        return new DomainProblem(400, 'SHORTCUT_DUPLICATE', STAFF_PREFERENCES_MESSAGES.duplicate);
      case 'IDEMPOTENCY_KEY_REQUIRED':
        return new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', STAFF_PREFERENCES_MESSAGES.keyRequired);
      case 'STAFF_PREFERENCES_INVALID':
        return new DomainProblem(400, 'VALIDATION_FAILED', STAFF_PREFERENCES_MESSAGES.invalid);
      default:
        break;
    }
  }
  if (error.code === '23505' && message === 'IDEMPOTENCY_KEY_REUSED') {
    return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', STAFF_PREFERENCES_MESSAGES.keyReused);
  }
  if (error.code === '40001' && message === 'VERSION_CONFLICT') {
    return new DomainProblem(412, 'VERSION_CONFLICT', STAFF_PREFERENCES_MESSAGES.versionConflict);
  }
  // The account is no longer active, or the membership no longer the caller's
  // active one at this facility (both refused by the guard first; here only
  // in a race with a change made meanwhile).
  if (error.code === '42501' && message === 'STAFF_PREFERENCES_NOT_ALLOWED') {
    return new DomainProblem(401, 'AUTHENTICATION_REQUIRED', STAFF_PREFERENCES_MESSAGES.signInAgain);
  }
  if (error.code === '42501' && message === 'STAFF_SHORTCUTS_NOT_ALLOWED') {
    return new DomainProblem(403, 'FACILITY_ACCESS_DENIED', STAFF_PREFERENCES_MESSAGES.facilityDenied);
  }
  return new DomainProblem(503, 'PREFERENCES_UNAVAILABLE', STAFF_PREFERENCES_MESSAGES.unavailable);
}

/**
 * SX-7 (0206): the signed-in staff member's language and the current
 * membership's Home shortcuts. Every read and write goes through 0206's
 * SECURITY DEFINER functions, which take the caller from app.actor_subject
 * and the membership from app.membership_id and app.facility_id (the
 * guard's, through requireStaffAccountContext); the tables themselves grant
 * the runtime nothing.
 */
@Injectable()
export class StaffPreferencesService {
  constructor(private readonly database: DatabaseService) {}

  /** GET: the read answer; shortcuts only when the request named a facility. */
  async read(context: StaffAccountContext): Promise<StaffPreferencesAnswer> {
    try {
      return await this.database.withStaffAccountTransaction(context,
        async (client) => this.answer(context, await this.readRow(client)), { readOnly: true });
    } catch (error) {
      throw staffPreferencesProblem(error);
    }
  }

  /** POST /identity/me/preferences: replaces the language (en only for now). */
  async savePreferences(context: StaffAccountContext, input: { language: string; expectedVersion: number },
    idempotencyKey: string): Promise<StaffPreferencesSaveAnswer> {
    if (!(STAFF_LANGUAGES as readonly string[]).includes(input.language)) {
      throw new DomainProblem(400, 'LANGUAGE_NOT_AVAILABLE', STAFF_PREFERENCES_MESSAGES.languageNotAvailable);
    }
    const digest = requestDigest(STAFF_PREFERENCES_OPERATION,
      { language: input.language, expectedVersion: input.expectedVersion });
    try {
      return await this.database.withStaffAccountTransaction(context, async (client) => {
        const saved = await client.query<{ replayed: boolean }>(SAVE_STAFF_PREFERENCES_SQL,
          [input.language, input.expectedVersion, idempotencyKey, digest]);
        return { ...this.answer(context, await this.readRow(client)), replayed: saved.rows[0]?.replayed === true };
      });
    } catch (error) {
      throw staffPreferencesProblem(error);
    }
  }

  /** POST /identity/me/shortcuts: replaces this facility's shortcuts (the facility is the guard's). */
  async saveShortcuts(context: StaffAccountContext, input: { items: readonly { module: string }[]; expectedVersion: number },
    idempotencyKey: string): Promise<StaffPreferencesSaveAnswer> {
    const facility = context.actor.facility;
    if (!context.facilityId || !context.membershipId || !facility || facility.id !== context.facilityId) {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', STAFF_PREFERENCES_MESSAGES.facilityDenied);
    }
    const modules = input.items.map((item) => item.module);
    // What can be refused without the saved row is refused first (every key
    // sent taken as saved: a key this image does not know, of 0206's shape,
    // is refused below unless it really is saved for this membership).
    const early = shortcutRefusal(modules, new Set(modules), facility.permissions);
    if (early) throw early;
    const digest = requestDigest(STAFF_SHORTCUTS_OPERATION,
      { facilityId: context.facilityId, modules, expectedVersion: input.expectedVersion });
    try {
      return await this.database.withStaffAccountTransaction(context, async (client) => {
        const kept = new Set((await this.readRow(client)).shortcuts_modules ?? []);
        const refusal = shortcutRefusal(modules, kept, facility.permissions);
        if (refusal) throw refusal;
        const saved = await client.query<{ replayed: boolean }>(SAVE_STAFF_SHORTCUTS_SQL,
          [modules, input.expectedVersion, idempotencyKey, digest]);
        return { ...this.answer(context, await this.readRow(client)), replayed: saved.rows[0]?.replayed === true };
      });
    } catch (error) {
      throw staffPreferencesProblem(error);
    }
  }

  private async readRow(client: PoolClient): Promise<ReadRow> {
    const row = (await client.query<ReadRow>(READ_STAFF_PREFERENCES_SQL)).rows[0];
    if (!row) throw new Error('no answer');
    return row;
  }

  private answer(context: StaffAccountContext, row: ReadRow): StaffPreferencesAnswer {
    const permissions = context.actor.facility?.id === context.facilityId ? context.actor.facility?.permissions ?? [] : [];
    return {
      version: Number(row.preferences_version),
      language: row.preferences_language,
      languagesAvailable: [...STAFF_LANGUAGES],
      notices: { ...STAFF_NOTICE_DEFAULTS },
      shortcuts: context.facilityId && row.shortcuts_facility_id
        ? {
          facilityId: row.shortcuts_facility_id,
          version: Number(row.shortcuts_version ?? 0),
          max: STAFF_SHORTCUTS_MAX,
          items: (row.shortcuts_modules ?? []).map((module) => ({ module, available: shortcutAvailable(module, permissions) })),
        }
        : null,
    };
  }
}
