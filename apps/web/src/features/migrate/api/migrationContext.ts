import { invokeApiFunction } from '../../../lib/functionApi'
import type { MigrationAccessContext } from '../domain'

export async function fetchMigrationContext(): Promise<MigrationAccessContext> {
  const envelope = await invokeApiFunction<{ data?: MigrationAccessContext } | MigrationAccessContext | null>(
    'migration-context',
    { method: 'GET' },
    'HID Migrate could not verify your access right now.',
  )
  const context = envelope && 'projects' in envelope
    ? envelope
    : envelope?.data
  if (!context || !Array.isArray(context.projects)) {
    throw new Error('HID Migrate returned an invalid access response.')
  }
  return context
}
