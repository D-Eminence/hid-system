import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const deployment = process.argv[2]
if (!['production', 'staging'].includes(deployment)) {
  throw new Error('Usage: node scripts/wrangler-dry-run.mjs <production|staging>')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workers = [
  'hid-web', 'hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-admin',
  ...(deployment === 'production' ? ['hid-apex-redirect'] : []),
]

for (const worker of workers) {
  const config = resolve(root, 'workers', worker, 'wrangler.json')
  const result = spawnSync('npx', [
    '--yes', 'wrangler@4.33.0', 'deploy', '--dry-run', '--env', deployment, '--config', config,
  ], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`Wrangler ${deployment} dry-run failed for ${worker}`)
  }
}

process.stdout.write(`Wrangler ${deployment} dry-run passed for ${workers.length} Workers without deployment.\n`)
