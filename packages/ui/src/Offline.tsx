import React from 'react'

export type SharedSyncStatus = 'online' | 'offline' | 'pending_sync' | 'syncing' | 'synced' | 'conflict' | 'retryable_failure' | 'terminal_failure'

export const OFFLINE_MESSAGE = 'Offline — live data and protected commands require reconnection.'

const labels: Record<SharedSyncStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  pending_sync: 'Pending synchronization',
  syncing: 'Synchronizing',
  synced: 'Synchronized',
  conflict: 'Conflict requires review',
  retryable_failure: 'Synchronization failed — retry available',
  terminal_failure: 'Synchronization blocked',
}

const colors: Record<SharedSyncStatus, { background: string; color: string }> = {
  online: { background: '#e8f7ef', color: '#17633a' },
  offline: { background: '#fff2d8', color: '#7a4d00' },
  pending_sync: { background: '#eaf3ff', color: '#175ea8' },
  syncing: { background: '#eaf3ff', color: '#175ea8' },
  synced: { background: '#e8f7ef', color: '#17633a' },
  conflict: { background: '#fff2d8', color: '#7a4d00' },
  retryable_failure: { background: '#fff2d8', color: '#7a4d00' },
  terminal_failure: { background: '#fdecec', color: '#9b1c1c' },
}

export function OfflineBanner({ offline }: { offline: boolean }) {
  if (!offline) return null
  return <div role="status" aria-live="polite" style={{ padding: '8px 16px', textAlign: 'center', fontSize: 13, fontWeight: 600, ...colors.offline }}>{OFFLINE_MESSAGE}</div>
}

export function SyncStatus({ status }: { status: SharedSyncStatus }) {
  return <span role="status" style={{ display: 'inline-flex', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 600, ...colors[status] }}>{labels[status]}</span>
}

export function PendingSyncBadge() { return <SyncStatus status="pending_sync" /> }

export function ConflictState({ children = 'The server version changed. Review current authoritative data before retrying.' }: { children?: React.ReactNode }) {
  return <div role="alert" style={{ borderLeft: '4px solid #b46d00', padding: 12, ...colors.conflict }}>{children}</div>
}

export function RetryState({ terminal = false }: { terminal?: boolean }) {
  return <SyncStatus status={terminal ? 'terminal_failure' : 'retryable_failure'} />
}
