#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
const manifest = JSON.parse(readFileSync(new URL('../toolchain/production-build.json', import.meta.url), 'utf8'))
const go = process.env.HID_TUF_BUILD_GO || 'go'
const env = { ...process.env, GOTOOLCHAIN: 'local', GOENV: 'off' }
const run = args => execFileSync(go, args, { env, encoding: 'utf8' }).trim()
assert.equal(run(['version']), `go version ${manifest.go_version} ${manifest.platform}`)
const binary = join(run(['env', 'GOROOT']), 'bin/go')
const stat = lstatSync(binary); assert.ok(stat.isFile() && !stat.isSymbolicLink())
assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.go_binary_sha256)
const dockerfile = readFileSync(new URL('../Dockerfile.signing-broker', import.meta.url), 'utf8')
assert.ok(dockerfile.includes(manifest.build_image) && dockerfile.includes(manifest.go_version))
process.stdout.write(`Release build toolchain verified: ${manifest.go_version}, ${manifest.go_binary_sha256}\n`)
