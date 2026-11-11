import type { ErrorEvent, Event, EventHint, Exception, StackFrame } from '@sentry/node';

/**
 * Privacy allowlist for backend error events.
 *
 * Events are REBUILT from a small allowlist instead of having known-sensitive
 * keys deleted: anything a future SDK version (or an integration) adds is
 * dropped by default. Patient data can appear in request URLs, bodies,
 * headers, exception messages (Postgres and validation errors echo values),
 * local variables and source context, so none of those are ever copied.
 */

export const ALLOWED_TAGS = ['service', 'release_id', 'route'] as const;

const LEVELS = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);
const MAX_TAG_LENGTH = 200;
const MAX_FRAMES = 100;
const MAX_EXCEPTIONS = 10;
const MAX_IDENTIFIER_LENGTH = 200;

function safeString(value: unknown, max = MAX_IDENTIFIER_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Exception class names and mechanism types are code identifiers, never data. */
function safeIdentifier(value: unknown): string | undefined {
  const text = safeString(value);
  return text !== undefined && /^[A-Za-z_$][\w$.\-]*$/.test(text) ? text : undefined;
}

/**
 * Keeps file names relative so a developer's home directory or other host path
 * never leaves the process. Paths under the working directory become relative
 * to it; dependency paths keep only the node_modules suffix; anything else
 * keeps only its base name.
 */
export function relativeFilename(value: unknown, cwd: string = safeCwd()): string | undefined {
  let filename = safeString(value, 1024);
  if (filename === undefined) return undefined;
  filename = filename.replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (filename.startsWith('node:')) return filename.slice(0, MAX_IDENTIFIER_LENGTH);
  const isAbsolute = filename.startsWith('/') || /^[A-Za-z]:\//.test(filename);
  if (!isAbsolute) return filename.slice(0, MAX_IDENTIFIER_LENGTH);
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base.length > 1 && filename.startsWith(`${base}/`)) {
    return filename.slice(base.length + 1).slice(0, MAX_IDENTIFIER_LENGTH);
  }
  const dependency = filename.lastIndexOf('/node_modules/');
  if (dependency >= 0) return filename.slice(dependency + 1).slice(0, MAX_IDENTIFIER_LENGTH);
  return filename.slice(filename.lastIndexOf('/') + 1).slice(0, MAX_IDENTIFIER_LENGTH);
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

/*
 * Stack frames are parsed by Sentry from `error.stack`, which starts with the
 * error MESSAGE. Any message line shaped like "    at ..." is parsed as a frame,
 * so frame fields can carry patient data (Postgres echoes bad input verbatim,
 * newlines included). Frames are therefore allowlisted field by field:
 * - a frame is kept only with a numeric line number;
 * - a filename only if it is `node:...`, `<anonymous>` or a space-free
 *   [A-Za-z0-9_./@-] path ending in .js/.mjs/.cjs/.ts (after relativizing);
 * - a function name only if it is identifier-shaped, else "?";
 * - `module` is rebuilt from the cleaned filename, never copied.
 * When the original error is available (always, for this package's own
 * capture paths), frames forged by message lines are removed first; see
 * withoutForgedFrames below. Without it, a message line mimicking a valid
 * frame could still pass, carrying only identifier-shaped text.
 */
const SAFE_FILENAME = /^[A-Za-z0-9_./@-]+\.(?:js|mjs|cjs|ts)$/;
const SAFE_FUNCTION = /^(?:async |new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$<>][\w$<>]*)*(?: \[as [A-Za-z_$][\w$]*\])?$/;

function safeFilename(value: unknown): string | undefined {
  const filename = relativeFilename(value);
  if (filename === undefined) return undefined;
  if (filename === '<anonymous>') return filename;
  if (/^node:[A-Za-z0-9_./-]+$/.test(filename)) return filename;
  return SAFE_FILENAME.test(filename) ? filename : undefined;
}

function moduleFromFilename(filename: string): string | undefined {
  if (!SAFE_FILENAME.test(filename)) return undefined;
  return filename.replace(/^node_modules\//, '').replace(/\.(?:js|mjs|cjs|ts)$/, '').replace(/\//g, '.');
}

function scrubFrame(frame: StackFrame): StackFrame | undefined {
  const lineno = safeNumber(frame.lineno);
  if (lineno === undefined) return undefined;
  const out: StackFrame = {};
  const filename = safeFilename(frame.filename);
  if (filename !== undefined) {
    out.filename = filename;
    const module = moduleFromFilename(filename);
    if (module !== undefined) out.module = module;
  }
  const fn = safeString(frame.function);
  out.function = fn !== undefined && SAFE_FUNCTION.test(fn) ? fn : '?';
  out.lineno = lineno;
  const colno = safeNumber(frame.colno);
  if (colno !== undefined) out.colno = colno;
  if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app;
  return out;
}

/*
 * Forged frames: error.stack is "<name>: <message>\n    at ...", and Sentry
 * parses every "at ..." line, including lines inside the MESSAGE. A message
 * line in exact frame syntax (e.g. "at Jane.Doe (jane-doe-1980.js:1:1)")
 * passes the field rules above, so frames that came from the message are
 * removed using the original error:
 * - Sentry orders frames oldest first and message lines precede the real
 *   frames in error.stack, so forged frames are the NEWEST ones: drop one
 *   frame from the newest end per message line matching /^\s*at\s/ (this may
 *   over-drop a real frame if such a line did not parse; that is acceptable);
 * - additionally drop any frame whose (function, filename, line, column)
 *   appears in a message line, in case the stack was rearranged.
 */
const MESSAGE_FRAME_LINE = /^\s*at\s/;

/**
 * The message lines that sit among the stack's frame lines. The message's
 * first line normally shares the stack header ("Name: <first line>") and is
 * not parsed as a frame, so it only counts when the stack itself starts with
 * it (e.g. an error whose name is empty).
 */
function messageFrameLines(value: unknown): string[] | undefined {
  if (!(value instanceof Error)) return undefined;
  try {
    if (typeof value.message !== 'string') return undefined;
    const lines = value.message.split(/\r?\n/);
    const stack = typeof value.stack === 'string' ? value.stack : '';
    const firstLineIsFrameLine = stack.split(/\r?\n/, 1)[0] === lines[0];
    return lines.filter((line, index) => (index > 0 || firstLineIsFrameLine) && MESSAGE_FRAME_LINE.test(line));
  } catch {
    return undefined;
  }
}

function frameAppearsIn(frame: StackFrame, lines: readonly string[]): boolean {
  if (typeof frame.lineno !== 'number') return false;
  const position = typeof frame.colno === 'number' ? `:${frame.lineno}:${frame.colno}` : `:${frame.lineno}`;
  return lines.some((line) => line.includes(position)
    && (typeof frame.filename !== 'string' || line.includes(frame.filename.replace(/^file:\/\//, '')))
    && (typeof frame.function !== 'string' || frame.function === '?' || line.includes(frame.function)));
}

export function withoutForgedFrames(frames: StackFrame[] | undefined, lines: readonly string[]): StackFrame[] | undefined {
  if (!Array.isArray(frames) || lines.length === 0) return frames;
  return frames.slice(0, Math.max(0, frames.length - lines.length))
    .filter((frame) => !frameAppearsIn(frame, lines));
}

/** Exception types must look like a class name; anything else becomes "Error". */
const SAFE_EXCEPTION_TYPE = /^[A-Z][A-Za-z0-9_$]*$/;
function safeExceptionType(value: unknown): string | undefined {
  const text = safeString(value, 100);
  return text !== undefined && SAFE_EXCEPTION_TYPE.test(text) ? text : undefined;
}

function scrubException(exception: Exception, forgedLines?: readonly string[]): Exception {
  const out: Exception = { type: safeExceptionType(exception.type) ?? 'Error' };
  const mechanism = exception.mechanism;
  if (mechanism && typeof mechanism === 'object') {
    out.mechanism = {
      type: safeIdentifier(mechanism.type) ?? 'generic',
      ...(typeof mechanism.handled === 'boolean' ? { handled: mechanism.handled } : {}),
    };
  }
  const frames = forgedLines === undefined
    ? exception.stacktrace?.frames
    : withoutForgedFrames(exception.stacktrace?.frames, forgedLines);
  if (Array.isArray(frames)) {
    // Sentry orders frames oldest-first; keep the newest (closest to the throw).
    out.stacktrace = {
      frames: frames.slice(-MAX_FRAMES).map(scrubFrame).filter((frame): frame is StackFrame => frame !== undefined),
    };
  }
  return out;
}

function constructorName(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  try {
    return safeExceptionType(value.constructor?.name);
  } catch {
    return undefined;
  }
}

/**
 * Sentry `beforeSend` hook. Returns a brand-new event containing only:
 * event_id, timestamp, platform, level, environment, the allowlisted tags and
 * exception types with stack frames. Events without an exception are dropped.
 */
export function scrubEvent(event: Event | ErrorEvent | null | undefined, hint?: EventHint): ErrorEvent | null {
  if (!event || typeof event !== 'object') return null;
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;

  // Only the thrown (last) exception corresponds to hint.originalException.
  const forgedLines = messageFrameLines(hint?.originalException);
  const kept = values.slice(-MAX_EXCEPTIONS);
  const exceptions = kept.map((value, index) =>
    scrubException(value, index === kept.length - 1 ? forgedLines : undefined));
  // Errors that do not set `name` report as "Error"; use the class name instead.
  const thrown = exceptions[exceptions.length - 1];
  const className = constructorName(hint?.originalException);
  if (thrown && thrown.type === 'Error' && className) thrown.type = className;
  const out: Event = { exception: { values: exceptions } };

  const eventId = safeString(event.event_id, 64);
  if (eventId !== undefined && /^[0-9a-f]+$/i.test(eventId)) out.event_id = eventId;
  const timestamp = safeNumber(event.timestamp);
  if (timestamp !== undefined) out.timestamp = timestamp;
  const platform = safeIdentifier(event.platform);
  if (platform !== undefined) out.platform = platform;
  if (typeof event.level === 'string' && LEVELS.has(event.level)) out.level = event.level;
  const environment = safeString(event.environment, 64);
  if (environment !== undefined) out.environment = environment;

  const tags: Record<string, string> = {};
  const inputTags = event.tags ?? {};
  for (const key of ALLOWED_TAGS) {
    const value = (inputTags as Record<string, unknown>)[key];
    const text = safeString(value, MAX_TAG_LENGTH);
    if (text !== undefined) tags[key] = text;
  }
  if (Object.keys(tags).length > 0) out.tags = tags;

  // Error events carry no `type` key; the cast only narrows the declared type.
  return out as ErrorEvent;
}
