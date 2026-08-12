#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolveDevelopmentPorts } from './ports.mjs'

const ports = resolveDevelopmentPorts(process.env)
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'outreach', 'ocr', 'admin']
const children = apps.map(app => spawn('npm', ['--prefix', `apps/${app}`, 'run', 'preview'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, ...(app === 'web' ? { HID_WEB_DIRECT: 'true' } : {}) },
  stdio: 'inherit',
}))

console.log('[hid-system] production frontend previews')
for (const [app, port] of [
  ['web', ports.webUi], ['ehr', ports.ehrUi], ['lab', ports.labUi], ['pharmacy', ports.pharmacyUi],
  ['outreach', ports.outreachUi], ['ocr', ports.ocrUi], ['admin', ports.adminUi],
]) console.log(`[hid-system] ${app.padEnd(9)} http://127.0.0.1:${port}/${app === 'web' ? '' : `${app}/`}`)

let stopping = false
function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const child of children) if (!child.killed) child.kill(signal)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

const exitCodes = await Promise.all(children.map(child => new Promise(resolve => {
  child.once('error', () => resolve(1))
  child.once('exit', code => resolve(code ?? (stopping ? 0 : 1)))
})))
process.exitCode = exitCodes.some(code => code !== 0) && !stopping ? 1 : 0
