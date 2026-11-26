// The dry run's retry of a busy table (coordinator, hid-system #258, 20 November 2026, after Release A's
// production dry run stopped at 01:33 UTC).
//
// A dry run applies every pending file in one transaction. Once that transaction holds an earlier file's locks,
// each later file's lock step makes one NOWAIT attempt and refuses at once if a table is busy ("… so it does not
// wait; nothing applied; run the release again at a quieter time"). A file first in line tries for 5 seconds and
// then refuses ("… stayed busy for 5 seconds; …"). Either refusal is the file's own, raised before it changes
// anything, so the dry run rolls back and runs again from the start after a short random pause, a bounded number of
// times. Any other error, a lock_timeout included, stops at once, as before. --plan and the apply are unchanged: the
// apply gives each file its own transaction and the file's own bounded wait.

export const DRY_RUN_ATTEMPTS = 20;
export const DRY_RUN_WINDOW_MS = 5 * 60 * 1000;
export const DRY_RUN_PAUSE_MS = Object.freeze({ min: 1_000, max: 6_000 });

const BUSY_REFUSAL = /(?:so it does not wait|stayed busy for 5 seconds)(?:; nothing applied)?; run the release again at a quieter time$/;

/** A migration file failed; the message is the runner's usual "Migration <file>: <error>". */
export class MigrationFileError extends Error {
  constructor(version, cause) {
    super(`Migration ${version}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationFileError';
    this.version = version;
    this.cause = cause;
  }
}

/** Whether a file's failure is that file's own busy-table refusal (55P03, its number, its wording). */
export function isBusyRefusal(error) {
  if (!(error instanceof MigrationFileError)) return false;
  const cause = error.cause;
  return cause?.code === '55P03' && typeof cause.message === 'string'
    && cause.message.startsWith(`${error.version.slice(0, 4)}: `) && BUSY_REFUSAL.test(cause.message);
}

/**
 * Runs attempt(number) until it succeeds; after a busy refusal it pauses and runs it again, at most `attempts`
 * times and never past `windowMs` from the first start. One line per refused attempt names the attempt, the file
 * and how long the attempt ran before the refusal, holding the earlier files' locks (Ola, #306). The last refusal
 * is thrown unchanged, so the runner's failure text is the same as without retries.
 */
export async function withDryRunAttempts(attempt, {
  attempts = DRY_RUN_ATTEMPTS,
  windowMs = DRY_RUN_WINDOW_MS,
  pauseMs = DRY_RUN_PAUSE_MS,
  log = (line) => process.stdout.write(line),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  random = Math.random,
} = {}) {
  const startedAt = now();
  for (let number = 1; ; number += 1) {
    const attemptStartedAt = now();
    try {
      return await attempt(number);
    } catch (error) {
      if (!isBusyRefusal(error)) throw error;
      const held = Math.max(0, Math.round(now() - attemptStartedAt));
      const pause = pauseMs.min + Math.floor(random() * (pauseMs.max - pauseMs.min + 1));
      if (number >= attempts || now() - startedAt + pause >= windowMs) {
        log(`Dry run attempt ${number} of ${attempts}: ${error.version} was busy after ${held} ms; no attempt left\n`);
        throw error;
      }
      log(`Dry run attempt ${number} of ${attempts}: ${error.version} was busy after ${held} ms; rolled back, `
        + `trying again in ${pause} ms\n`);
      await sleep(pause);
    }
  }
}

/** Test-only bounds (NODE_ENV=test), so a rehearsal can prove the bound without waiting minutes. */
export function dryRunAttemptOptions(environment = process.env) {
  const attempts = environment.HID_TEST_DRY_RUN_ATTEMPTS;
  const pause = environment.HID_TEST_DRY_RUN_PAUSE_MS;
  if (attempts === undefined && pause === undefined) return {};
  if (environment.NODE_ENV !== 'test') throw new Error('The dry-run attempt override is test-only');
  const options = {};
  if (attempts !== undefined) {
    if (!/^[1-9]\d?$/.test(attempts) || Number(attempts) > DRY_RUN_ATTEMPTS) {
      throw new Error(`HID_TEST_DRY_RUN_ATTEMPTS must be 1-${DRY_RUN_ATTEMPTS}`);
    }
    options.attempts = Number(attempts);
  }
  if (pause !== undefined) {
    if (!/^\d{1,5}$/.test(pause) || Number(pause) > DRY_RUN_PAUSE_MS.max) {
      throw new Error(`HID_TEST_DRY_RUN_PAUSE_MS must be 0-${DRY_RUN_PAUSE_MS.max}`);
    }
    options.pauseMs = { min: Number(pause), max: Number(pause) };
  }
  return options;
}
