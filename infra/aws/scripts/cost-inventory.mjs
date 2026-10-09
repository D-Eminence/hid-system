#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { costInventory } from '../src/cost-inventory.ts'
import { environmentConfig } from '../src/config.ts'

const inventory = {
  generatedFrom: 'typed IaC configuration; quantities only; no fabricated prices',
  profiles: [
    environmentConfig('development'),
    environmentConfig('staging', 'sleep'),
    environmentConfig('staging', 'economy'),
    environmentConfig('staging', 'fidelity'),
    environmentConfig('production'),
  ].map(costInventory),
}
const serialized = `${JSON.stringify(inventory, null, 2)}\n`

if (process.argv.includes('--check')) {
  const path = resolve(import.meta.dirname, '..', 'cost-inventory.json')
  assert.equal(await readFile(path, 'utf8'), serialized,
    'cost-inventory.json is stale; review script output and update it intentionally')
  process.stdout.write('Deterministic cost inventory is current\n')
} else {
  process.stdout.write(serialized)
}
