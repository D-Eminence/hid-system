import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A migration that pins catalog state compares md5(string_agg(... order by
// <text>)) with a literal measured on a database. Without an explicit
// collation the order, and so the md5, follows the database's default
// collation: a database created with en_US.utf8 (the pgvector/pgvector:pg16
// image the database-migration CI job uses, and the usual RDS default)
// ignores underscores at the first level and puts
// ehr.imported_medical_records before ehr.imported_medical_record_versions,
// where C puts it after. The same 27 policies then hash differently and the
// pin refuses a correct database. Every ordered string_agg in these
// migrations therefore orders by collate "C", the order the pins were
// measured in, on every key.
const pinned = ['0118_card_links.sql'];

function orderedAggregates(sql) {
  const found = [];
  let from = 0;
  for (;;) {
    const start = sql.indexOf('string_agg(', from);
    if (start === -1) return found;
    let depth = 0;
    let end = start + 'string_agg'.length;
    for (; end < sql.length; end += 1) {
      if (sql[end] === '(') depth += 1;
      else if (sql[end] === ')' && --depth === 0) break;
    }
    const call = sql.slice(start, end + 1);
    const orderAt = call.search(/\border by\b/i);
    if (orderAt !== -1) found.push({ call, keys: call.slice(orderAt + 'order by'.length, -1) });
    from = end + 1;
  }
}

function topLevelKeys(text) {
  const keys = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      keys.push(current.trim());
      current = '';
    } else current += character;
  }
  keys.push(current.trim());
  return keys;
}

for (const name of pinned) {
  test(`${name}: every ordered string_agg orders by collate "C"`, async () => {
    const sql = await readFile(
      new URL(`../../services/ehr-api/database/migrations/${name}`, import.meta.url), 'utf8');
    const aggregates = orderedAggregates(sql);
    assert.ok(aggregates.length >= 4, `expected the four ordered string_agg calls in ${name}`);
    for (const { call, keys } of aggregates) {
      for (const key of topLevelKeys(keys)) {
        assert.match(key, /\scollate "C"(\s+(asc|desc))?$/i, `order key without collate "C": ${key}\nin ${call}`);
      }
    }
  });
}
