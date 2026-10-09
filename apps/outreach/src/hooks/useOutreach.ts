import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CreateOutreachRegistrationCase, OutreachRegistrationCase } from '@hid/api-client'
import {
  getIdentityActorContext,
  safeSignOut,
  type IdentityActorContext,
  type IdentityFacilityAssignment,
} from '@hid/identity-browser-client'
import { OutreachApiProblem, outreachClient, outreachRequestContext } from '../lib/outreachApi'
import {
  acknowledgeOutreachCommand,
  clearOutreachOfflineData,
  enqueueOutreachRegistration,
  listOutreachCommands,
  listOutreachReceipts,
  updateOutreachCommand,
  type OfflineRegistrationCommand,
  type OutreachReceipt,
} from '../lib/outreachOfflineStore'

type RegistrationValues = Omit<CreateOutreachRegistrationCase, 'localCommandId' | 'temporaryPatientId'>

function outreachFacility(actor: IdentityActorContext): IdentityFacilityAssignment | null {
  const allowed = actor.facilities.filter((facility) =>
    facility.permissions.includes('outreach.registration.read'))
  return allowed.find((facility) => facility.isPrimary) ?? allowed[0] ?? null
}

function retryable(error: unknown): boolean {
  return error instanceof OutreachApiProblem ? error.retryable
    : error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
}

export function useOutreach() {
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [actor, setActor] = useState<IdentityActorContext | null>(null)
  const [facility, setFacility] = useState<IdentityFacilityAssignment | null>(null)
  const [serverCases, setServerCases] = useState<readonly OutreachRegistrationCase[]>([])
  const [commands, setCommands] = useState<OfflineRegistrationCommand[]>([])
  const [receipts, setReceipts] = useState<OutreachReceipt[]>([])
  const [connection, setConnection] = useState<'online' | 'offline'>(navigator.onLine ? 'online' : 'offline')

  const loadLocal = useCallback(async (facilityId: string) => {
    const [nextCommands, nextReceipts] = await Promise.all([
      listOutreachCommands(facilityId), listOutreachReceipts(facilityId),
    ])
    setCommands(nextCommands)
    setReceipts(nextReceipts)
  }, [])

  const loadServer = useCallback(async (facilityId: string) => {
    if (!navigator.onLine) return
    setServerCases(await outreachClient.listRegistrationCases(outreachRequestContext(facilityId)))
  }, [])

  useEffect(() => {
    let mounted = true
    async function load() {
      try {
        const nextActor = await getIdentityActorContext()
        if (!mounted) return
        if (!nextActor) {
          setNeedsAuth(true)
          return
        }
        const nextFacility = outreachFacility(nextActor)
        if (!nextFacility) throw new Error('Your Identity account has no active Outreach facility assignment.')
        setActor(nextActor)
        setFacility(nextFacility)
        await loadLocal(nextFacility.id)
        if (navigator.onLine) await loadServer(nextFacility.id)
      } catch (caught) {
        if (mounted) setError(caught instanceof Error ? caught.message : 'Unable to load Outreach.')
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void load()
    return () => { mounted = false }
  }, [loadLocal, loadServer])

  const syncNow = useCallback(async () => {
    if (!facility || !navigator.onLine || syncing) return
    setSyncing(true)
    setError(null)
    try {
      const pending = await listOutreachCommands(facility.id)
      for (const command of pending) {
        if (command.state === 'terminal') continue
        await updateOutreachCommand(command.commandId, 'syncing', null)
        try {
          const received = await outreachClient.createRegistrationCase(
            command.input, outreachRequestContext(facility.id), command.idempotencyKey)
          await acknowledgeOutreachCommand(command, received.id, received.status)
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : 'Outreach synchronization failed'
          await updateOutreachCommand(command.commandId,
            retryable(caught) ? 'sync_failed_retryable' : 'terminal', message)
          if (!retryable(caught)) setError(message)
        }
      }
      await Promise.all([loadLocal(facility.id), loadServer(facility.id)])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to refresh Outreach synchronization state.')
    } finally {
      setSyncing(false)
    }
  }, [facility, loadLocal, loadServer, syncing])

  useEffect(() => {
    const online = () => { setConnection('online'); void syncNow() }
    const offline = () => setConnection('offline')
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }, [syncNow])

  const metrics = useMemo(() => ({
    serverReceived: serverCases.length,
    pending: commands.filter((command) => command.state !== 'terminal').length,
    attention: commands.filter((command) => command.state === 'terminal').length,
    acknowledged: receipts.length,
  }), [commands, receipts, serverCases])

  async function addRegistration(values: RegistrationValues) {
    if (!facility) throw new Error('An authorized Outreach facility is required.')
    await enqueueOutreachRegistration(facility.id, values)
    await loadLocal(facility.id)
    if (navigator.onLine) queueMicrotask(() => { void syncNow() })
  }

  async function signOut() {
    await clearOutreachOfflineData()
    await safeSignOut()
  }

  return {
    loading, syncing, error, needsAuth, actor, facility, serverCases, commands, receipts,
    connection, metrics, addRegistration, syncNow, signOut,
  }
}
