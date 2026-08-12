import { useSyncExternalStore } from 'react'

export const SYNC_STATUSES = [
  'local_draft',
  'pending_sync',
  'syncing',
  'synced',
  'conflict',
  'retryable_failure',
  'terminal_failure',
] as const

export type SyncStatus = (typeof SYNC_STATUSES)[number]

export interface OfflineCommandEnvelope<Payload = unknown> {
  localCommandId: string
  operationType: string
  resourceReference?: string
  idempotencyKey: string
  expectedVersion?: number
  createdAt: string
  attemptCount: number
  lastAttemptAt?: string
  syncStatus: Exclude<SyncStatus, 'local_draft' | 'synced'>
  payload: Payload
}

export interface EncryptedPayload {
  algorithm: 'AES-GCM'
  iv: string
  ciphertext: string
}

function onlineSnapshot(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

function subscribeConnectivity(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

export function useConnectivity(): { online: boolean; offline: boolean } {
  const online = useSyncExternalStore(subscribeConnectivity, onlineSnapshot, () => true)
  return { online, offline: !online }
}

export function createStableIdempotencyKey(existing?: string): string {
  if (existing?.trim()) return existing.trim()
  return crypto.randomUUID()
}

export function classifySyncFailure(status: number): 'reauthentication_required' | 'conflict' | 'retryable_failure' | 'terminal_failure' {
  if (status === 401 || status === 403) return 'reauthentication_required'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable_failure'
  return 'terminal_failure'
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return bytes.buffer as ArrayBuffer
}

export function createNonExtractableOfflineKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function encryptOfflineJson(key: CryptoKey, value: unknown): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  return {
    algorithm: 'AES-GCM',
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptOfflineJson<Payload>(key: CryptoKey, value: EncryptedPayload): Promise<Payload> {
  if (value.algorithm !== 'AES-GCM') throw new Error('Unsupported offline encryption algorithm.')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(value.iv) },
    key,
    decodeBase64(value.ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as Payload
}

export async function registerScopedServiceWorker(options: {
  scriptUrl: string
  scope: string
  enabled?: boolean
}): Promise<ServiceWorkerRegistration | null> {
  if (options.enabled === false || typeof window === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register(options.scriptUrl, { scope: options.scope })
  } catch {
    return null
  }
}
