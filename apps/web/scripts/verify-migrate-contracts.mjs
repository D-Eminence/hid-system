import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const root = process.cwd()
const constants = await readFile(join(root, 'src', 'features', 'migrate', 'domain', 'constants.ts'), 'utf8')
const stateMachine = await readFile(join(root, 'src', 'features', 'migrate', 'domain', 'stateMachine.ts'), 'utf8')
const migrationApi = await readFile(join(root, 'src', 'features', 'migrate', 'api', 'migrationOperations.ts'), 'utf8')
const processingWorkspace = await readFile(
  join(root, 'src', 'features', 'migrate', 'ui', 'ProcessingWorkspace.tsx'),
  'utf8',
)
const importWorkspace = await readFile(
  join(root, 'src', 'features', 'migrate', 'ui', 'ImportWorkspace.tsx'),
  'utf8',
)
const failures = []
const migrateSource = [constants, stateMachine, processingWorkspace, importWorkspace].join('\n')

for (const status of ['dead_letter', 'needs_rescan', 'correction_required', 'verification_failed']) {
  if (!migrateSource.includes(status)) {
    failures.push(`missing exceptional migration state: ${status}`)
  }
}
if (!migrationApi.includes('invokeApiFunction')) {
  failures.push('migration operations must use the shared first-party API boundary')
}

if (failures.length) {
  console.error(`Migrate contract verification failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log('Verified Migrate exceptional states and shared API routing.')
