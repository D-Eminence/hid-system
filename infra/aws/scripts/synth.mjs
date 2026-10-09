#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'cdk.out')
const cdk = resolve(root, 'node_modules', 'aws-cdk', 'bin', 'cdk')

if (output !== resolve(root, 'cdk.out')) {
  throw new Error('refusing to clean an unexpected synth output path')
}

rmSync(output, { recursive: true, force: true })

const result = spawnSync(process.execPath, [cdk, 'synth', '--no-lookups', '--output', output], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
