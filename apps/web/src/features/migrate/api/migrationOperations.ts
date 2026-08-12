import { invokeApiFunction } from '../../../lib/functionApi'

type PageEnvelope<T> = { data: T[]; page: { next_cursor: string | null } }

export async function listMigrationResource<T>(
  resource: 'projects' | 'members' | 'batches' | 'assignments' | 'eligible_staff' | 'operations' | 'audit',
  projectId?: string,
  cursor?: string | null,
): Promise<PageEnvelope<T>> {
  const params = new URLSearchParams({ resource, limit: '25' })
  if (projectId) params.set('project_id', projectId)
  if (cursor) params.set('cursor', cursor)
  return invokeApiFunction<PageEnvelope<T>>(
    `migration-operations?${params}`,
    { method: 'GET' },
    'The migration information could not be loaded right now.',
  )
}

export async function runMigrationOperation<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const envelope = await invokeApiFunction<{ data: T }>('migration-operations', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { action, ...payload },
  }, 'The migration operation could not be completed right now.')
  return envelope.data
}
