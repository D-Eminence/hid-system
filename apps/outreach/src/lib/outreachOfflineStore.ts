import type { CreateOutreachRegistrationCase } from '@hid/api-client'

const DATABASE_NAME = 'hid-outreach-offline-v1'
const DATABASE_VERSION = 1
const COMMANDS = 'commands'
const KEYS = 'keys'
const RECEIPTS = 'receipts'
const ENCRYPTION_KEY = 'outreach-command-key-v1'

export type OfflineCommandState = 'pending_sync' | 'syncing' | 'sync_failed_retryable' | 'terminal'

export interface OfflineRegistrationSummary {
  commandId: string
  idempotencyKey: string
  operationType: 'registration_case_create'
  temporaryPatientId: string
  facilityId: string
  state: OfflineCommandState
  attemptCount: number
  lastAttemptAt: string | null
  createdAt: string
  lastError: string | null
}

export interface OfflineRegistrationCommand extends OfflineRegistrationSummary {
  input: CreateOutreachRegistrationCase
}

interface StoredCommand extends OfflineRegistrationSummary {
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

export interface OutreachReceipt {
  commandId: string
  temporaryPatientId: string
  serverCaseId: string
  facilityId: string
  status: 'identity_resolution_pending' | 'identity_resolved'
  acknowledgedAt: string
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB operation failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  })
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      if (!db.objectStoreNames.contains(COMMANDS)) db.createObjectStore(COMMANDS, { keyPath: 'commandId' })
      if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS)
      if (!db.objectStoreNames.contains(RECEIPTS)) db.createObjectStore(RECEIPTS, { keyPath: 'commandId' })
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('Unable to open the Outreach offline store'))
  })
}

async function encryptionKey(db: IDBDatabase): Promise<CryptoKey> {
  const read = db.transaction(KEYS, 'readonly')
  const existing = await requestResult(read.objectStore(KEYS).get(ENCRYPTION_KEY)) as CryptoKey | undefined
  await transactionDone(read)
  if (existing) return existing
  const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const write = db.transaction(KEYS, 'readwrite')
  const store = write.objectStore(KEYS)
  const winner = await requestResult(store.get(ENCRYPTION_KEY)) as CryptoKey | undefined
  if (!winner) store.put(created, ENCRYPTION_KEY)
  await transactionDone(write)
  return winner ?? created
}

async function encrypt(input: CreateOutreachRegistrationCase, key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(input))
  return { iv: iv.buffer, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext) }
}

async function decrypt(value: StoredCommand, key: CryptoKey): Promise<CreateOutreachRegistrationCase> {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv }, key, value.ciphertext)
  return JSON.parse(new TextDecoder().decode(plaintext)) as CreateOutreachRegistrationCase
}

export function generateTemporaryPatientId(): string {
  return `tmp_${crypto.randomUUID()}`
}

export async function enqueueOutreachRegistration(
  facilityId: string,
  values: Omit<CreateOutreachRegistrationCase, 'localCommandId' | 'temporaryPatientId'>,
): Promise<OfflineRegistrationCommand> {
  const db = await database()
  try {
    const commandId = crypto.randomUUID()
    const command: OfflineRegistrationCommand = {
      commandId,
      idempotencyKey: crypto.randomUUID(),
      operationType: 'registration_case_create',
      temporaryPatientId: generateTemporaryPatientId(),
      facilityId,
      state: 'pending_sync',
      attemptCount: 0,
      lastAttemptAt: null,
      createdAt: new Date().toISOString(),
      lastError: null,
      input: { ...values, localCommandId: commandId, temporaryPatientId: '' },
    }
    command.input.temporaryPatientId = command.temporaryPatientId
    const key = await encryptionKey(db)
    const encrypted = await encrypt(command.input, key)
    const { input: _encryptedInput, ...summary } = command
    const stored: StoredCommand = { ...summary, ...encrypted }
    const transaction = db.transaction(COMMANDS, 'readwrite')
    transaction.objectStore(COMMANDS).add(stored)
    await transactionDone(transaction)
    return command
  } finally {
    db.close()
  }
}

export async function listOutreachCommands(facilityId: string): Promise<OfflineRegistrationCommand[]> {
  const db = await database()
  try {
    const transaction = db.transaction(COMMANDS, 'readonly')
    const rows = await requestResult(transaction.objectStore(COMMANDS).getAll()) as StoredCommand[]
    await transactionDone(transaction)
    const key = await encryptionKey(db)
    return Promise.all(rows.filter((row) => row.facilityId === facilityId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(async (row) => ({ ...row, input: await decrypt(row, key) })))
  } finally {
    db.close()
  }
}

export async function updateOutreachCommand(commandId: string, state: OfflineCommandState,
  lastError: string | null): Promise<void> {
  const db = await database()
  try {
    const transaction = db.transaction(COMMANDS, 'readwrite')
    const store = transaction.objectStore(COMMANDS)
    const row = await requestResult(store.get(commandId)) as StoredCommand | undefined
    if (row) store.put({ ...row, state, lastError,
      attemptCount: state === 'syncing' ? row.attemptCount + 1 : row.attemptCount,
      lastAttemptAt: state === 'syncing' ? new Date().toISOString() : row.lastAttemptAt })
    await transactionDone(transaction)
  } finally {
    db.close()
  }
}

export async function acknowledgeOutreachCommand(command: OfflineRegistrationCommand,
  serverCaseId: string, status: OutreachReceipt['status']): Promise<void> {
  const db = await database()
  try {
    const transaction = db.transaction([COMMANDS, RECEIPTS], 'readwrite')
    transaction.objectStore(COMMANDS).delete(command.commandId)
    transaction.objectStore(RECEIPTS).put({ commandId: command.commandId,
      temporaryPatientId: command.temporaryPatientId, serverCaseId, facilityId: command.facilityId,
      status, acknowledgedAt: new Date().toISOString() } satisfies OutreachReceipt)
    await transactionDone(transaction)
  } finally {
    db.close()
  }
}

export async function listOutreachReceipts(facilityId: string): Promise<OutreachReceipt[]> {
  const db = await database()
  try {
    const transaction = db.transaction(RECEIPTS, 'readonly')
    const rows = await requestResult(transaction.objectStore(RECEIPTS).getAll()) as OutreachReceipt[]
    await transactionDone(transaction)
    return rows.filter((row) => row.facilityId === facilityId)
      .sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt))
  } finally {
    db.close()
  }
}

export function clearOutreachOfflineData(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('Unable to clear Outreach offline data'))
    request.onblocked = () => reject(new Error('Close other Outreach tabs before signing out'))
  })
}
