#!/usr/bin/env node
// Every row lock a service takes must be one its runtime role can take.
// SELECT ... FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE needs UPDATE
// privilege on each locked table, checked before any row is read, and under
// row-level security the locked rows must also pass an UPDATE policy, or the
// lock silently returns no rows. PostgreSQL also refuses a lock on the nullable
// side of an outer join for every role. Unit tests mock the database, so these
// failures only show up as 5xx responses at runtime (Phase 4 Stage 9).
//
// This check needs no database: it reads every service's TypeScript SQL and
// replays the migrations and the role bootstrap (runtime-grants.sql) for table
// privileges, role membership, row-level security and policies. With
// --catalog <database> it also compares that replay with a live catalogue
// through psql (the rehearsal runs it), so the replay cannot drift from what
// PostgreSQL actually grants.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = resolve(import.meta.dirname, '..');
const databaseDirectory = join(repository, 'services/ehr-api/database');

/** The database role each service connects as. A service with SQL row locks must be listed. */
export const SERVICE_ROLES = Object.freeze({
  'identity-api': 'hid_identity_api_runtime',
  'ehr-api': 'hid_ehr_api_runtime',
  'lab-api': 'hid_lab_api_runtime',
  'pharmacy-api': 'hid_pharmacy_api_runtime',
  'ocr-api': 'hid_ocr_api_runtime',
  'outreach-api': 'hid_outreach_api_runtime',
  'ocr-worker': 'hid_ocr_worker',
  'notification-api': 'hid_notification_api_runtime',
  'notification-worker': 'hid_notification_worker',
  'event-dispatcher': 'hid_event_dispatcher',
});

const LOCK = /\bfor\s+(no\s+key\s+update|update|key\s+share|share)\b/gi;
const LOCK_TEST = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i;
// A lock clause whose strength is an interpolation this check cannot resolve.
const LOCK_HOLE = /\bfor\s+(?:no\s+key\s+)?«/i;
const SQL_TEXT = /\b(?:select|from|where|join)\b/i;
const MAX_VARIANTS = 64;

// ---------------------------------------------------------------------------
// TypeScript: string and template literals, outside comments.

/**
 * Returns the string and template literals of a TypeScript source, including
 * templates nested in ${...} expressions, with the offsets of each template
 * expression. Comments are skipped; their ranges are in the result's
 * `comments`. Throws when the source ends inside a literal, so a scanner
 * mistake fails the check instead of hiding statements.
 */
export function scanLiterals(source) {
  const literals = [];
  const comments = [];
  let index = 0;
  const fail = (message) => { throw new Error(`${message} at offset ${index}`); };
  const quoted = (quote) => {
    const start = index++;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') index++;
      else if (source[index] === '\n') fail('Unterminated string literal');
      index++;
    }
    if (index >= source.length) fail('Unterminated string literal');
    index++;
    const literal = { kind: 'string', start, end: index, text: source.slice(start + 1, index - 1), expressions: [] };
    literals.push(literal);
    return literal;
  };
  const template = () => {
    const start = index++;
    const quasis = [];
    const expressions = [];
    const expressionSpans = [];
    let quasiStart = index;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '$' && source[index + 1] === '{') {
        quasis.push(source.slice(quasiStart, index));
        index += 2;
        const expressionStart = index;
        code('}');
        expressions.push(source.slice(expressionStart, index).trim());
        expressionSpans.push({ start: expressionStart, end: index });
        index++;
        quasiStart = index;
        continue;
      }
      index++;
    }
    if (index >= source.length) fail('Unterminated template literal');
    quasis.push(source.slice(quasiStart, index));
    index++;
    const literal = { kind: 'template', start, end: index, quasis, expressions, expressionSpans };
    literals.push(literal);
    return literal;
  };
  // A slash starts a regular expression literal after an operator, an opening
  // bracket or one of these keywords, and is division otherwise.
  const regexAllowed = (position) => {
    let before = position - 1;
    while (before >= 0 && /\s/.test(source[before])) before--;
    if (before < 0) return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(source[before])) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(source.slice(Math.max(0, before - 11), before + 1));
    return Boolean(word && ['return', 'typeof', 'case', 'in', 'of', 'else', 'new', 'delete', 'void', 'throw', 'yield', 'await']
      .includes(word[1]));
  };
  const regex = () => {
    index++;
    let inClass = false;
    while (index < source.length && (inClass || source[index] !== '/')) {
      if (source[index] === '\\') index++;
      else if (source[index] === '[') inClass = true;
      else if (source[index] === ']') inClass = false;
      else if (source[index] === '\n') fail('Unterminated regular expression');
      index++;
    }
    index++;
    while (/[a-z]/i.test(source[index] ?? '')) index++;
  };
  // Scans code until the closing character at depth zero (or the end).
  const code = (closing) => {
    let depth = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index);
        comments.push({ start: index, end: end < 0 ? source.length : end });
        index = end < 0 ? source.length : end;
      } else if (char === '/' && source[index + 1] === '*') {
        const end = source.indexOf('*/', index + 2);
        if (end < 0) fail('Unterminated comment');
        comments.push({ start: index, end: end + 2 });
        index = end + 2;
      } else if (char === '/' && regexAllowed(index)) {
        regex();
      } else if (char === '\'' || char === '"') {
        quoted(char);
      } else if (char === '`') {
        template();
      } else if (char === '{') {
        depth++; index++;
      } else if (char === '}') {
        if (depth === 0 && closing === '}') return;
        depth--; index++;
      } else {
        index++;
      }
    }
    if (closing) fail('Unterminated template expression');
  };
  code(null);
  literals.sort((left, right) => left.start - right.start);
  literals.comments = comments;
  return literals;
}

const lineOf = (source, offset) => source.slice(0, offset).split('\n').length;

/** The source with comments, string contents and template text blanked; template expressions stay. */
function codeOnly(source, literals) {
  const blank = new Uint8Array(source.length);
  for (const { start, end } of literals.comments) blank.fill(1, start, end);
  for (const literal of literals) {
    let from = literal.start;
    for (const span of literal.expressionSpans ?? []) { blank.fill(1, from, span.start); from = span.end; }
    blank.fill(1, from, literal.end);
  }
  let out = '';
  for (let index = 0; index < source.length; index++) out += blank[index] && source[index] !== '\n' ? ' ' : source[index];
  return out;
}

/** Decodes the escape sequences of a string literal or template text, as JavaScript does. */
function decodeEscapes(text) {
  return text.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|[\r\n\u2028\u2029])|([\s\S]))/g,
    (_, hex, codePoint, unit, lineBreak, char) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (codePoint) return String.fromCodePoint(parseInt(codePoint, 16));
      if (unit) return String.fromCharCode(parseInt(unit, 16));
      if (lineBreak) return '';
      return { n: '\n', r: '\r', t: '\t', v: '\v', f: '\f', b: '\b', 0: '\0' }[char] ?? char;
    });
}

/**
 * Names an interpolation cannot be resolved from a literal binding. Bindings
 * are collected by name, not by scope, so a name resolves only when every
 * occurrence of it in the file's code is one of its literal declarations or a
 * whole `${name}` interpolation; a parameter, a destructuring, a loop
 * variable, an assignment, another declaration or any other use of the same
 * name could stand for another value (Phase 4 Stage 9 review).
 */
function ambiguousNames(code, literals, bindings) {
  const interpolations = new Map();
  for (const literal of literals) {
    for (const expression of literal.expressions) interpolations.set(expression, (interpolations.get(expression) ?? 0) + 1);
  }
  const names = new Set();
  for (const [name, values] of bindings) {
    const occurrences = [...code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))].length;
    if (occurrences !== values.length + (interpolations.get(name) ?? 0)) names.add(name);
  }
  return names;
}

/** A literal's possible string values; null when the expression is not a plain literal. */
function stringValues(expression) {
  const literal = /^(['"`])((?:(?!\1)[^\\]|\\.)*)\1$/s.exec(expression.trim());
  if (literal && !(literal[1] === '`' && literal[2].includes('${'))) return [decodeEscapes(literal[2])];
  return null;
}

// A visible placeholder: never a schema-qualified table, never a keyword, so an
// unresolved table name in a locked FROM list or an unresolved lock strength is refused.
const placeholder = (text) => `«${text.trim().replace(/[^\w.$]+/g, '_')}»`;

/**
 * The values an interpolated expression can take: a literal, a ternary of
 * literals, or a name bound to them (see literalBindings). Anything else
 * becomes a placeholder. `trace` collects what the values came from: the
 * expression spans resolved from literals and the names resolved by binding.
 */
function expressionValues(expression, span, context, depth, trace) {
  const text = expression.trim();
  const literal = stringValues(text);
  if (literal) { if (span) trace.resolved.push(span); return literal; }
  const ternary = /^[^?]+\?\s*((['"`])(?:(?!\2)[^\\]|\\.)*\2)\s*:\s*((['"`])(?:(?!\4)[^\\]|\\.)*\4)\s*$/sd.exec(text);
  if (ternary) {
    const branches = [stringValues(ternary[1]), stringValues(ternary[3])];
    // Only the two branch literals count as placed, not the condition.
    if (span && branches.every(Boolean)) {
      const offset = span.start + context.source.slice(span.start, span.end).search(/\S/);
      for (const group of [1, 3]) trace.resolved.push({ start: offset + ternary.indices[group][0], end: offset + ternary.indices[group][1] });
    }
    return branches.flatMap((values, index) => values ?? [placeholder(index ? ternary[3] : ternary[1])]);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(text) && context.bindings.has(text) && !context.ambiguous.has(text) && depth < 8) {
    if (span) trace.names.push({ name: text, at: span.start });
    return context.bindings.get(text).flatMap((value) => value(depth + 1, trace));
  }
  return [placeholder(text)];
}

/**
 * Constants bound to a string or template literal, or to a ternary of string
 * literals, anywhere in the file, by name, with the range of each initializer.
 * A name bound more than once keeps every binding, so each is checked.
 */
function literalBindings(source, literals) {
  const bindings = new Map();
  const initializers = [];
  const byStart = new Map(literals.map((literal) => [literal.start, literal]));
  const context = { bindings, ambiguous: new Set(), source };
  for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$<>[\]| '"]+)?=\s*/g)) {
    const start = match.index + match[0].length;
    // A literal binds only when it is the whole initializer ('a' + b does not).
    const literal = byStart.get(start);
    const whole = literal && /^\s*(?:as\s+const\s*)?(?:[;,)}]|$)/.test(source.slice(literal.end));
    let value;
    let end;
    if (literal && !whole) continue;
    if (literal) {
      value = (depth, trace) => templateValues(literal, context, depth, trace);
      end = literal.end;
    } else {
      const stop = source.indexOf(';', start);
      end = stop < 0 ? source.length : stop;
      const expression = source.slice(start, end);
      if (!/^[^;\n]*\?[^;]*:/s.test(expression) || /[`]/.test(expression)) continue;
      value = (depth, trace) => expressionValues(expression, null, context, depth, trace);
    }
    bindings.set(match[1], [...(bindings.get(match[1]) ?? []), value]);
    initializers.push({ name: match[1], start, end });
  }
  return { context, initializers };
}

function templateValues(literal, context, depth = 0, trace = newTrace()) {
  if (literal.kind === 'string') return [decodeEscapes(literal.text)];
  const parts = literal.expressions.map((expression, index) =>
    expressionValues(expression, literal.expressionSpans[index], context, depth, trace));
  if (parts.reduce((count, values) => count * values.length, 1) > MAX_VARIANTS) {
    trace.overflow = true;
    trace.lockInValues ||= parts.some((values) => values.some((value) => LOCK_TEST.test(value)));
    return [];
  }
  const quasis = literal.quasis.map(decodeEscapes);
  let variants = [quasis[0]];
  parts.forEach((values, index) => {
    variants = variants.flatMap((variant) => values.map((value) => variant + value + quasis[index + 1]));
  });
  return variants;
}

const newTrace = () => ({ resolved: [], names: [], overflow: false, lockInValues: false });
const within = (offset, range) => offset >= range.start && offset < range.end;

/**
 * The SQL statements of a TypeScript source that take a row lock, with every
 * variant of their interpolated constants and conditional fragments. Lock
 * text this check cannot place in such a statement is returned as unassembled,
 * with the reason, instead of being skipped.
 */
export function lockingStatements(source) {
  const literals = scanLiterals(source);
  const { context, initializers } = literalBindings(source, literals);
  const code = codeOnly(source, literals);
  context.ambiguous = ambiguousNames(code, literals, context.bindings);
  const statements = [];
  const seen = new Set();
  const consumed = [];
  const nameUses = new Map();
  const pending = [];
  const unassembled = (literal, text, reason) => {
    const raw = source.slice(literal.start, literal.end);
    statements.push({ line: lineOf(source, literal.start + Math.max(raw.search(/\bfor\b/i), 0)), sql: text.trim(), unassembled: true, reason });
  };
  for (const literal of literals) {
    const raw = source.slice(literal.start, literal.end);
    const line = lineOf(source, literal.start + Math.max(raw.search(LOCK_TEST), 0));
    const text = literal.kind === 'string' ? decodeEscapes(literal.text) : literal.quasis.map(decodeEscapes).join('«»');
    // SQL comments are whitespace to PostgreSQL, and text in SQL strings is not a lock.
    const sqlText = maskSql(text);
    const lockText = LOCK_TEST.test(sqlText) || /^\s*for\s*(?:$|(?:no\s+key\s+)?«)/i.test(sqlText)
      || (SQL_TEXT.test(sqlText) && (LOCK_HOLE.test(sqlText) || /\bfor\s*$/i.test(sqlText)));
    const trace = newTrace();
    const variants = new Set(templateValues(literal, context, 0, trace));
    if (trace.overflow && (lockText || trace.lockInValues)) {
      unassembled(literal, text, `more than ${MAX_VARIANTS} variants`);
      continue;
    }
    let complete = false;
    for (const sql of variants) {
      const masked = maskSql(sql);
      if (!/\bselect\b/i.test(masked) || !/\bfrom\b/i.test(masked)) continue;
      if (LOCK_HOLE.test(masked)) {
        unassembled(literal, sql, 'the lock strength is an interpolation this check cannot resolve');
        complete = true;
        continue;
      }
      if (!LOCK_TEST.test(masked)) continue;
      complete = true;
      const key = `${line}\0${sql}`;
      if (seen.has(key)) continue;
      seen.add(key);
      statements.push({ line, sql });
    }
    if (complete) {
      consumed.push(...trace.resolved);
      for (const { name, at } of trace.names) nameUses.set(name, new Set([...(nameUses.get(name) ?? []), at]));
    } else if (lockText) {
      pending.push({ literal, text });
    }
  }
  // Lock text outside a whole statement (a conditional fragment, a constant)
  // must be part of one: inside an interpolation that a locking statement
  // resolved, or bound to a name, not exported, that is used only as such
  // interpolations (another file could import and append an exported one).
  const references = (name) => [...code.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))].length;
  const exported = (name) => new RegExp(`\\bexport\\s+(?:const|let)\\s+${name.replace(/\$/g, '\\$')}\\b`).test(code)
    || [...code.matchAll(/\bexport\s*(?:\{([^}]*)\}|default\s+([A-Za-z_$][\w$]*))/g)]
      .some((match) => (match[1] ?? match[2]).split(',').some((part) => part.trim().split(/\s+as\s+/)[0].trim() === name));
  for (const { literal, text } of pending) {
    if (consumed.some((range) => within(literal.start, range))) continue;
    const bound = initializers.filter((range) => within(literal.start, range));
    const used = bound.length > 0 && bound.every(({ name }) => !context.ambiguous.has(name) && !exported(name)
      && (nameUses.get(name)?.size ?? 0) > 0
      && references(name) - context.bindings.get(name).length === nameUses.get(name).size);
    if (!used) unassembled(literal, text, 'lock text that is not part of a statement this check can assemble');
  }
  return statements;
}

// ---------------------------------------------------------------------------
// SQL: which tables each lock clause locks.

/** Replaces the contents of every parenthesised group with spaces, keeping offsets. */
function flattenParentheses(sql) {
  let depth = 0;
  let out = '';
  for (const char of sql) {
    if (char === '(') { out += depth === 0 ? '(' : ' '; depth++; continue; }
    if (char === ')') { depth--; out += depth === 0 ? ')' : ' '; continue; }
    out += depth > 0 ? ' ' : char;
  }
  return out;
}

/** Masks string literals, quoted identifiers and comments so keywords inside them are ignored. */
function maskSql(sql) {
  // One pass, left to right, so a quote inside a comment or `--` inside a string is not taken for the other.
  return sql.replace(/[Ee]'(?:[^'\\]|\\.|'')*'|'(?:[^']|'')*'|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g, (match) => {
    if (match.startsWith('--') || match.startsWith('/*')) return match.replace(/[^\n]/g, ' ');
    const open = match.startsWith('$') ? match.indexOf('$', 1) + 1 : match.indexOf("'") + 1;
    const close = match.startsWith('$') ? match.length - open : 1;
    return match.slice(0, open) + match.slice(open, match.length - close).replace(/[^\n]/g, ' ') + match.slice(match.length - close);
  });
}

const JOIN = /\s*(,|\bnatural\s+|\b(?:left|right|full)(?:\s+outer)?\s+join\b|\bcross\s+join\b|\b(?:inner\s+)?join\b)\s*/gi;
const FROM_END = /\b(where|group\s+by|having|window|order\s+by|limit|offset|fetch|for\s+(?:no\s+key\s+update|update|key\s+share|share)|union|intersect|except)\b/i;

/**
 * The FROM items of one query level (the text from its SELECT to its lock
 * clause), with their alias and whether an outer join makes them nullable.
 */
function fromItems(level) {
  const flat = flattenParentheses(level);
  let from = -1;
  for (const match of flat.matchAll(/\bfrom\b/gi)) {
    if (/\bdistinct\s+$/i.test(flat.slice(0, match.index))) continue;
    from = match.index + match[0].length;
    break;
  }
  if (from < 0) return { error: 'no FROM clause' };
  const rest = flat.slice(from);
  const endMatch = FROM_END.exec(rest);
  const clause = rest.slice(0, endMatch ? endMatch.index : undefined);
  const items = [];
  let last = 0;
  let pendingJoin = 'first';
  const push = (text, join) => {
    const condition = /\s+(?:on|using)\b/i.exec(text);
    const length = condition ? condition.index : text.length;
    const item = text.slice(0, length).trim();
    if (!item) return;
    const table = /^(?:only\s+)?([a-z_][\w]*\.[a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?$/i.exec(item);
    if (table) {
      items.push({ table: table[1].toLowerCase(), alias: (table[2] ?? table[1].split('.')[1]).toLowerCase(), join });
    } else {
      items.push({ table: null, alias: (/(?:\bas\s+)?([a-z_][\w]*)\s*$/i.exec(item)?.[1] ?? '').toLowerCase(), join,
        text: level.slice(from + last, from + last + length).trim() });
    }
  };
  for (const match of clause.matchAll(JOIN)) {
    push(clause.slice(last, match.index), pendingJoin);
    pendingJoin = match[1].toLowerCase().replace(/\s+/g, ' ');
    last = match.index + match[0].length;
  }
  push(clause.slice(last), pendingJoin);
  // Nullable sides: LEFT makes the joined item nullable, RIGHT everything
  // before it, FULL both.
  items.forEach((item, index) => {
    if (/^left/.test(item.join) || /^full/.test(item.join)) item.nullable = true;
    if (/^(right|full)/.test(item.join)) for (const earlier of items.slice(0, index)) earlier.nullable = true;
  });
  return { items };
}

const AGGREGATE = /\b(?:count|sum|avg|min|max|array_agg|string_agg|json_agg|jsonb_agg|json_object_agg|jsonb_object_agg|bool_and|bool_or|every|bit_and|bit_or|xmlagg)\s*\(/i;
const SET_RETURNING = /\b(?:generate_series|generate_subscripts|unnest|regexp_matches|regexp_split_to_table|jsonb?_array_elements(?:_text)?|jsonb?_each(?:_text)?|jsonb?_object_keys|jsonb?_to_recordset|jsonb?_populate_recordset)\s*\(/i;

/**
 * Query forms with which PostgreSQL refuses a row lock for every role (0A000):
 * DISTINCT, GROUP BY, HAVING, aggregates, window functions, set-returning
 * functions in the select list, and set operations that the lock's query level
 * is part of.
 */
function refusedForms(masked, start, lock, level, strength) {
  const flat = flattenParentheses(level);
  const name = `FOR ${strength.toUpperCase()}`;
  const found = [];
  const selectList = flat.slice(0, (/\bfrom\b/i.exec(flat)?.index) ?? flat.length);
  if (/^\s*select\s+distinct\b/i.test(flat)) found.push(`${name} is not allowed with DISTINCT`);
  if (/\bgroup\s+by\b/i.test(flat)) found.push(`${name} is not allowed with GROUP BY`);
  if (/\bhaving\b/i.test(flat)) found.push(`${name} is not allowed with HAVING`);
  if (AGGREGATE.test(flat)) found.push(`${name} is not allowed with aggregate functions`);
  if (/\bover\s*\(|\bover\s+[a-z_]/i.test(flat) || /\bwindow\b/i.test(flat)) found.push(`${name} is not allowed with window functions`);
  if (SET_RETURNING.test(selectList)) found.push(`${name} is not allowed with set-returning functions in the target list`);
  // A set operation joins this level with others: within the enclosing
  // parentheses, or around them when the level is a parenthesised operand.
  let depth = 0;
  let from = 0;
  for (let index = start - 1; index >= 0; index--) {
    if (masked[index] === ')') depth++;
    else if (masked[index] === '(') { if (depth === 0) { from = index + 1; break; } depth--; }
  }
  let to = masked.length;
  depth = 0;
  for (let index = lock; index < masked.length; index++) {
    if (masked[index] === '(') depth++;
    else if (masked[index] === ')') { if (depth === 0) { to = index; break; } depth--; }
  }
  const SET_OPERATION = /\b(?:union|intersect|except)\b/i;
  const inside = SET_OPERATION.test(flattenParentheses(masked.slice(from, lock)))
    || SET_OPERATION.test(flattenParentheses(masked.slice(lock, to)));
  const around = from > 0 && (/\b(?:union|intersect|except)(?:\s+(?:all|distinct))?\s*$/i.test(masked.slice(0, from - 1))
    || /^\s*(?:union|intersect|except)\b/i.test(masked.slice(to + 1)));
  if (inside || around) found.push(`${name} is not allowed with UNION, INTERSECT or EXCEPT`);
  return found;
}

/**
 * Every lock clause of a statement, with the tables it locks and the defects
 * PostgreSQL refuses for every role.
 */
export function analyseLocks(sql) {
  const masked = maskSql(sql);
  const clauses = [];
  for (const match of masked.matchAll(LOCK)) {
    // The query level: back to the nearest SELECT at the same depth.
    let depth = 0;
    let start = -1;
    for (let index = match.index - 1; index >= 0; index--) {
      const char = masked[index];
      if (char === ')') depth++;
      else if (char === '(') { if (depth === 0) break; depth--; }
      else if (depth === 0 && /\bselect\b/i.test(masked.slice(index, index + 7))
        && (index === 0 || /\W/.test(masked[index - 1]))) { start = index; break; }
    }
    const strength = match[1].toLowerCase().replace(/\s+/g, ' ');
    const after = masked.slice(match.index + match[0].length);
    const of = /^\s+of\s+([a-z_][\w]*(?:\s*,\s*[a-z_][\w]*)*)/i.exec(after);
    const clause = { strength, of: of ? of[1].split(',').map((name) => name.trim().toLowerCase()) : null,
      tables: [], defects: [] };
    clauses.push(clause);
    // The rest of the lock clause, up to the next lock clause or the end of its
    // query level, must be readable: an interpolation there could add locked
    // aliases (FOR UPDATE OF s${more}).
    let tailEnd = after.length;
    for (let index = 0, depth = 0; index < after.length; index++) {
      if (after[index] === '(') depth++;
      else if (after[index] === ')') { if (depth === 0) { tailEnd = index; break; } depth--; }
    }
    const nextLock = after.slice(0, tailEnd).search(/\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i);
    if (after.slice(0, nextLock < 0 ? tailEnd : nextLock).includes('«')) {
      clause.defects.push(`FOR ${strength.toUpperCase()} is followed by an interpolation this check cannot resolve`);
    }
    if (start < 0) { clause.defects.push('cannot find the SELECT this lock clause belongs to'); continue; }
    const level = masked.slice(start, match.index);
    const { items, error } = fromItems(level);
    if (error) { clause.defects.push(error); continue; }
    clause.defects.push(...refusedForms(masked, start, match.index, level, strength));
    const targets = clause.of
      ? clause.of.map((name) => items.find((item) => item.alias === name)
        ?? { table: null, alias: name, missing: true })
      : items;
    for (const target of targets) {
      if (target.missing) clause.defects.push(`FOR ${strength.toUpperCase()} OF ${target.alias} names no FROM item`);
      else if (!target.table) clause.defects.push(`locks a FROM item that is not a schema-qualified table: ${target.text ?? target.alias}`);
      else clause.tables.push(target.table);
    }
    const nullable = targets.filter((item) => item.nullable);
    if (!clause.of && items.some((item) => item.nullable)) {
      clause.defects.push(`FOR ${strength.toUpperCase()} without OF over an outer join locks its nullable side`);
    } else if (nullable.length > 0) {
      clause.defects.push(`FOR ${strength.toUpperCase()} OF ${nullable.map((item) => item.alias).join(', ')} locks the nullable side of an outer join`);
    }
    clause.tables = [...new Set(clause.tables)];
  }
  return clauses;
}

// ---------------------------------------------------------------------------
// Database: table privileges, role membership, row-level security, policies.

const stripComments = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const DOLLAR = /\$([a-z_]*)\$[\s\S]*?\$\1\$/gi;
const names = (list) => list.split(',').map((name) => name.trim().toLowerCase().replace(/"/g, '')).filter(Boolean);
const TABLE_PRIVILEGES = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];

export function databaseScripts(directory = databaseDirectory) {
  return [
    ...readdirSync(join(directory, 'migrations')).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => join(directory, 'migrations', name)),
    join(directory, 'runtime-grants.sql'),
  ];
}

/** Statement forms the replay does not follow. None occurs today; if one appears, extend the replay. */
export function unfollowedForms(scripts) {
  const found = [];
  for (const [name, text] of scripts) {
    const raw = stripComments(text);
    for (const [body] of raw.matchAll(DOLLAR)) {
      if (/\b(?:grant|revoke)\s+[\w\s,()]*\bon\s+(?:table\s+)?(?:all\s+tables|[a-z_]+\.[a-z_])/i.test(body)) {
        found.push(`${name}: table GRANT or REVOKE in a dollar-quoted body`);
      }
      if (/\b(?:create|alter|drop)\s+policy\b/i.test(body)) found.push(`${name}: policy statement in a dollar-quoted body`);
      if (/\b(?:enable|disable)\s+row\s+level\s+security\b/i.test(body)) found.push(`${name}: row-level security change in a dollar-quoted body`);
    }
    const top = raw.replace(DOLLAR, "''");
    if (/\balter\s+policy\b/i.test(top)) found.push(`${name}: ALTER POLICY`);
    if (/\balter\s+table\s+[^;]*\brename\s+to\b/i.test(top)) found.push(`${name}: ALTER TABLE ... RENAME TO`);
    if (/\balter\s+default\s+privileges\b[^;]*\bgrant\b/i.test(top)) found.push(`${name}: ALTER DEFAULT PRIVILEGES ... GRANT`);
    if (/\bgrant\s+[^;]*\bon\s+all\s+tables\b[^;]*\bwith\s+grant\s+option\b/i.test(top)) found.push(`${name}: GRANT ... WITH GRANT OPTION`);
    // CREATE ROLE ... ROLE / ADMIN / USER add members to the new role; IN ROLE is followed.
    if (/\bcreate\s+role\s+\w+[^;]*?(?<!\bin\s+)\b(?:role|admin|user)\s+[a-z_]/i.test(raw)) found.push(`${name}: CREATE ROLE ... ROLE, ADMIN or USER`);
  }
  return found;
}

/**
 * Replays the scripts in order: tables, table and column privileges, role
 * membership, row-level security and policies. Statements in dollar-quoted
 * bodies are not followed (see unfollowedForms).
 */
export function databaseModel(scripts) {
  const tables = new Set();
  const privileges = new Map(); // table -> role -> Set of privileges (column privileges as 'update(col)')
  const members = new Map(); // role -> Set of roles it is a direct member of
  const inherits = new Map(); // 'member|role' -> whether the membership passes on privileges
  const roleInherit = new Map(); // role -> its INHERIT attribute (default true)
  const rls = new Set();
  const policies = new Map(); // table -> name -> { command, permissive, roles }
  const tablePrivileges = (table) => privileges.get(table) ?? privileges.set(table, new Map()).get(table);
  const rolePrivileges = (table, role) => tablePrivileges(table).get(role)
    ?? tablePrivileges(table).set(role, new Set()).get(role);
  const targetTables = (target) => {
    const all = /^all\s+tables\s+in\s+schema\s+([\s\S]+)$/i.exec(target);
    if (all) {
      const schemas = names(all[1]);
      return [...tables].filter((table) => schemas.includes(table.split('.')[0]));
    }
    return names(target.replace(/^table\s+/i, '')).filter((name) => name.includes('.'));
  };
  const privilegeList = (list) => {
    const out = [];
    for (const part of list.replace(/\(([^)]*)\)/g, (_, columns) => `(${columns.replace(/,/g, '|')})`).split(',')) {
      const text = part.trim().toLowerCase();
      if (/^all(\s+privileges)?$/.test(text)) out.push(...TABLE_PRIVILEGES);
      else {
        const column = /^(\w+)\s*\(([^)]*)\)$/.exec(text);
        if (column) for (const name of column[2].split('|')) out.push(`${column[1]}(${name.trim()})`);
        else out.push(text);
      }
    }
    return out;
  };
  const grantRole = (member, role, option) => {
    const set = members.get(member) ?? members.set(member, new Set()).get(member);
    set.add(role);
    // PostgreSQL 16: a membership passes on privileges per its INHERIT
    // option, which defaults to the member's INHERIT attribute at grant time.
    inherits.set(`${member}|${role}`, option ?? roleInherit.get(member) ?? true);
  };
  for (const [, text] of scripts) {
    const stripped = stripComments(text);
    // Role attributes and CREATE ROLE ... IN ROLE, in statement order: roles are
    // created in dollar-quoted DO blocks and altered at the top level, and a
    // grant takes the member's INHERIT attribute at the time it is made.
    const roleEvents = [...stripped.matchAll(/\b(create|alter)\s+role\s+([a-z_][\w]*)\b([^;]*)/gi)];
    let nextEvent = 0;
    const applyRoleEventsBefore = (offset) => {
      for (; nextEvent < roleEvents.length && roleEvents[nextEvent].index < offset; nextEvent++) {
        const [, verb, roleName, rest] = roleEvents[nextEvent];
        const role = roleName.toLowerCase();
        const attribute = /\b(no)?inherit\b/i.exec(rest);
        if (attribute) roleInherit.set(role, !attribute[1]);
        else if (/^create$/i.test(verb) && !roleInherit.has(role)) roleInherit.set(role, true);
        const inRole = /^create$/i.test(verb) && /\bin\s+(?:role|group)\s+([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)/i.exec(rest);
        if (inRole) for (const parent of names(inRole[1])) grantRole(role, parent);
      }
    };
    // Dollar-quoted bodies blanked to the same length, so offsets line up with roleEvents.
    const top = stripped.replace(DOLLAR, (body) => `'${' '.repeat(body.length - 2)}'`);
    for (const chunk of top.matchAll(/[^;]+/g)) {
      applyRoleEventsBefore(chunk.index);
      const statement = chunk[0].trim().replace(/\s+/g, ' ');
      if (!statement) continue;
      let match;
      if ((match = /^create (?:unlogged )?table (?:if not exists )?([a-z_]+\.[a-z_][\w]*)/i.exec(statement))) {
        tables.add(match[1].toLowerCase());
      } else if ((match = /^drop table (?:if exists )?([\s\S]+?)(?: cascade| restrict)?$/i.exec(statement))) {
        for (const table of names(match[1])) { tables.delete(table); privileges.delete(table); policies.delete(table); rls.delete(table); }
      } else if ((match = /^alter table (?:if exists )?(?:only )?([a-z_]+\.[a-z_][\w]*) (enable|disable) row level security$/i.exec(statement))) {
        if (match[2].toLowerCase() === 'enable') rls.add(match[1].toLowerCase()); else rls.delete(match[1].toLowerCase());
      } else if ((match = /^create policy (\S+) on ([a-z_]+\.[a-z_][\w]*)(?: as (permissive|restrictive))?(?: for (all|select|insert|update|delete))?(?: to ([\w, ]+?))?(?: using\b| with check\b|$)/i.exec(statement))) {
        const table = match[2].toLowerCase();
        const map = policies.get(table) ?? policies.set(table, new Map()).get(table);
        map.set(match[1].toLowerCase(), { command: (match[4] ?? 'all').toLowerCase(),
          permissive: (match[3] ?? 'permissive').toLowerCase() === 'permissive',
          roles: match[5] ? names(match[5]) : ['public'] });
      } else if ((match = /^drop policy (?:if exists )?(\S+) on ([a-z_]+\.[a-z_][\w]*)/i.exec(statement))) {
        policies.get(match[2].toLowerCase())?.delete(match[1].toLowerCase());
      } else if ((match = /^(grant|revoke) (?:grant option for )?([\s\S]+?) on ((?:table )?[a-z_]+\.[\s\S]+?|all tables in schema [\s\S]+?) (?:to|from) ([\w, ]+?)(?: with grant option| cascade| restrict| granted by \w+)?$/i.exec(statement))) {
        const granting = match[1].toLowerCase() === 'grant';
        const list = privilegeList(match[2]);
        for (const table of targetTables(match[3])) {
          for (const role of names(match[4])) {
            const held = rolePrivileges(table, role);
            for (const privilege of list) {
              if (granting) held.add(privilege);
              else {
                held.delete(privilege);
                // Revoking a table privilege also revokes it on every column.
                if (!privilege.includes('(')) for (const value of [...held]) if (value.startsWith(`${privilege}(`)) held.delete(value);
              }
            }
          }
        }
      } else if ((match = /^revoke inherit option for ([\w, ]+?) from ([\w, ]+?)(?: cascade| restrict)?$/i.exec(statement))) {
        for (const member of names(match[2])) for (const role of names(match[1])) inherits.set(`${member}|${role}`, false);
      } else if ((match = /^(grant|revoke) ([\w, ]+?) (to|from) ([\w, ]+?)((?: with (?:admin|inherit|set) (?:option|true|false))*)(?: granted by \w+)?$/i.exec(statement))
        && !/\bon\b/i.test(match[2]) && !/^(?:all|usage|select|insert|update|delete|execute|connect|create|temporary|temp|truncate|references|trigger)\b/i.test(match[2])) {
        const option = /\bwith inherit (option|true|false)\b/i.exec(match[5] ?? '');
        for (const member of names(match[4])) {
          for (const role of names(match[2])) {
            if (match[1].toLowerCase() === 'grant') grantRole(member, role, option ? option[1].toLowerCase() !== 'false' : undefined);
            else {
              members.get(member)?.delete(role);
              inherits.delete(`${member}|${role}`);
            }
          }
        }
      }
    }
    applyRoleEventsBefore(Infinity);
  }
  return { tables, privileges, members, inherits, rls, policies };
}

/** The role, every role whose privileges it inherits (transitively) and PUBLIC. */
export function effectiveRoles(model, role) {
  const roles = new Set([role, 'public']);
  const pending = [role];
  while (pending.length > 0) {
    const member = pending.pop();
    for (const parent of model.members.get(member) ?? []) {
      if (model.inherits?.get(`${member}|${parent}`) === false) continue;
      if (!roles.has(parent)) { roles.add(parent); pending.push(parent); }
    }
  }
  return roles;
}

/** Whether a role may lock rows of a table, and why not. */
export function lockPermission(model, role, table) {
  const roles = effectiveRoles(model, role);
  if (!model.tables.has(table)) return { allowed: false, reason: `${table} is not a table created by the migrations` };
  const held = [...roles].flatMap((name) => [...(model.privileges.get(table)?.get(name) ?? [])]);
  const update = held.some((privilege) => privilege === 'update' || privilege.startsWith('update('));
  if (!update) return { allowed: false, reason: `${role} has no UPDATE privilege on ${table} (42501 permission denied)` };
  if (model.rls.has(table)) {
    const policy = [...(model.policies.get(table)?.values() ?? [])].some((candidate) => candidate.permissive
      && ['all', 'update'].includes(candidate.command) && candidate.roles.some((name) => roles.has(name)));
    if (!policy) {
      return { allowed: false, reason: `${table} has row-level security and no UPDATE policy for ${role}, so the lock returns no rows` };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// The check.

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every row lock in every service's source, with its role, tables and violations. */
export function inspectServices(model, servicesDirectory = join(repository, 'services')) {
  const results = [];
  for (const service of readdirSync(servicesDirectory).sort()) {
    const src = join(servicesDirectory, service, 'src');
    let files;
    try { files = sourceFiles(src); } catch { continue; }
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      let statements;
      try { statements = lockingStatements(source); } catch (error) {
        throw new Error(`${relative(repository, file)}: ${error.message}`, { cause: error });
      }
      for (const statement of statements) {
        const role = SERVICE_ROLES[service];
        const location = `${relative(repository, file)}:${statement.line}`;
        if (statement.unassembled) {
          results.push({ service, role: role ?? null, location, strength: null, of: null, tables: [],
            violations: ['lock text that is not part of a statement this check can assemble'], sql: statement.sql });
          continue;
        }
        const clauses = analyseLocks(statement.sql);
        if (clauses.length === 0) {
          results.push({ service, role: role ?? null, location, strength: null, of: null, tables: [],
            violations: ['a locking statement in which this check finds no lock clause'], sql: statement.sql });
        }
        for (const clause of clauses) {
          const violations = [...clause.defects];
          if (!role) violations.push(`service ${service} has no runtime role in SERVICE_ROLES`);
          else for (const table of clause.tables) {
            const permission = lockPermission(model, role, table);
            if (!permission.allowed) violations.push(permission.reason);
          }
          results.push({ service, role: role ?? null, location, strength: clause.strength, of: clause.of,
            tables: clause.tables, violations, sql: statement.sql.replace(/\s+/g, ' ').trim() });
        }
      }
    }
  }
  return results;
}

/**
 * Compares the replay with a live catalogue: for every runtime role and every
 * table the replay knows, UPDATE (table or column), row-level security and an
 * applicable permissive UPDATE policy. Uses psql, as the rehearsal does.
 */
export function catalogueDifferences(model, database, psql = 'psql') {
  const roles = [...new Set(Object.values(SERVICE_ROLES))];
  const query = `select r.rolname || '|' || n.nspname || '.' || c.relname || '|' ||
      (has_table_privilege(r.oid, c.oid, 'UPDATE') or has_any_column_privilege(r.oid, c.oid, 'UPDATE'))::text || '|' ||
      c.relrowsecurity::text || '|' ||
      exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polpermissive and p.polcmd in ('*', 'w')
        and (p.polroles = '{0}' or exists (select 1 from unnest(p.polroles) role_oid
          where pg_has_role(r.oid, role_oid, 'USAGE'))))::text
    from pg_roles r cross join pg_class c join pg_namespace n on n.oid = c.relnamespace
   where r.rolname = any (array[${roles.map((role) => `'${role}'`).join(',')}])
     and c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   order by 1`;
  const result = spawnSync(psql, ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', query],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(result.status, 0, `psql failed: ${result.stderr}`);
  const differences = [];
  const live = new Set();
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const [role, table, update, rowSecurity, policy] = line.split('|');
    if (table.startsWith('migration.') && !model.tables.has(table)) continue;
    live.add(table);
    const roles = effectiveRoles(model, role);
    const replayUpdate = [...roles].some((name) => [...(model.privileges.get(table)?.get(name) ?? [])]
      .some((privilege) => privilege === 'update' || privilege.startsWith('update(')));
    const replayPolicy = [...(model.policies.get(table)?.values() ?? [])].some((candidate) => candidate.permissive
      && ['all', 'update'].includes(candidate.command) && candidate.roles.some((name) => roles.has(name)));
    const expected = { update: replayUpdate, rowSecurity: model.rls.has(table), policy: replayPolicy };
    const actual = { update: update === 'true', rowSecurity: rowSecurity === 'true', policy: policy === 'true' };
    if (!model.tables.has(table)) differences.push(`${table}: in the catalogue but not created by the replayed migrations`);
    else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      differences.push(`${role} on ${table}: replay ${JSON.stringify(expected)}, catalogue ${JSON.stringify(actual)}`);
    }
  }
  for (const table of model.tables) if (!live.has(table)) differences.push(`${table}: created by the replay but not in the catalogue`);
  return [...new Set(differences)];
}

function main(argv) {
  const scripts = databaseScripts().map((path) => [relative(repository, path), readFileSync(path, 'utf8')]);
  const unfollowed = unfollowedForms(scripts);
  assert.deepEqual(unfollowed, [], `The privilege replay cannot follow:\n${unfollowed.join('\n')}`);
  const model = databaseModel(scripts);
  const results = inspectServices(model);
  const option = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
  const catalogue = option('--catalog');
  const differences = catalogue ? catalogueDifferences(model, catalogue, option('--psql') ?? 'psql') : null;
  const failed = results.filter((result) => result.violations.length > 0);
  const summary = { status: failed.length === 0 && (differences?.length ?? 0) === 0 ? 'passed' : 'failed',
    lockClauses: results.length, services: [...new Set(results.map((result) => result.service))],
    violations: failed.map(({ location, role, strength, tables, violations }) => ({ location, role, strength, tables, violations })),
    ...(differences ? { catalogueTablesCompared: model.tables.size, catalogueDifferences: differences } : {}) };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'passed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
