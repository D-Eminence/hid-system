import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CarePortal, RecordSummary } from '../../components/CarePortal'
import { carePortalApi, emergencyIsActive, type EmergencyGrant, type ReleasedRecords } from '../../lib/carePortalApi'
import { getIdentityActorContext, identityClient, type IdentityActorContext } from '../../lib/identityClient'

export default function DoctorEmergency() {
  const [actor, setActor] = useState<IdentityActorContext | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [facilityId, setFacilityId] = useState('')
  const [hid, setHid] = useState('')
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState(30)
  const [grant, setGrant] = useState<EmergencyGrant | null>(null)
  const [records, setRecords] = useState<ReleasedRecords | null>(null)
  const [closingReason, setClosingReason] = useState('Emergency treatment access no longer required')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef(0)
  useEffect(() => {
    let active = true
    void getIdentityActorContext().then(value => {
      if (!active) return
      setActor(value); setLoaded(true)
      setFacilityId(value?.facilities.find(facility => facility.permissions.includes('identity.break-glass.write'))?.id || '')
    }).catch(() => { if (active) { setLoaded(true); setError('Unable to verify your clinical session. Sign in again.') } })
    const { data } = identityClient.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { requestVersion.current++; setActor(null); setGrant(null); setRecords(null) }
    })
    return () => { active = false; requestVersion.current++; data.subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (!grant) return
    let active = true
    async function refresh() {
      if (!active) return
      if (!emergencyIsActive(grant!)) {
        requestVersion.current++; setRecords(null); setGrant(null); setNotice('Emergency access expired. Records have been cleared.'); return
      }
      const version = ++requestVersion.current
      setRecords(null)
      if (document.hidden) return
      try {
        const value = await carePortalApi.emergencyRecords(facilityId, grant!)
        if (active && requestVersion.current === version) { setRecords(value); setError('') }
      } catch (failure) {
        if (active && requestVersion.current === version) { setRecords(null); setError(failure instanceof Error ? failure.message : 'Access could not be verified. Records were cleared.') }
      }
    }
    void refresh()
    const poll = window.setInterval(() => { void refresh() }, 30_000)
    const expiry = window.setTimeout(() => { void refresh() }, Math.max(1, Date.parse(grant.expiresAt) - Date.now()))
    const onVisibility = () => { void refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { active = false; requestVersion.current++; clearInterval(poll); clearTimeout(expiry); document.removeEventListener('visibilitychange', onVisibility) }
  }, [grant, facilityId])
  async function activate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setRecords(null); setNotice('')
    const version = ++requestVersion.current
    try {
      const value = await carePortalApi.activate(facilityId, hid, reason, duration)
      if (version !== requestVersion.current) return
      setGrant(value); setHid(''); setReason('')
      setNotice(value.existingGrant
        ? 'Existing emergency access restored with its original expiry. This activation was recorded for facility review.'
        : 'Emergency access recorded for facility review. A patient notification has been queued.')
    } catch (failure) { if (version === requestVersion.current) setError(failure instanceof Error ? failure.message : 'Emergency access denied.') }
    finally { setBusy(false) }
  }
  async function close() {
    if (!grant) return
    setBusy(true); setRecords(null); setError(''); requestVersion.current++
    try {
      await carePortalApi.close(facilityId, grant.consentGrantId, closingReason)
      setGrant(null); setNotice('Emergency access revoked. Records have been cleared.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Revocation could not be confirmed. Retry closing access.') }
    finally { setBusy(false) }
  }
  const facilities = actor?.facilities.filter(facility => facility.permissions.includes('identity.break-glass.write') && facility.permissions.includes('identity.consent.write')) ?? []
  return <CarePortal title="Emergency access">
    {!loaded ? <p role="status">Verifying clinical session…</p> : !actor ? <p><Link to="/hospital/auth">Sign in with your clinical account</Link></p> : <>
      <p>Signed in as {actor.displayName || actor.email || 'authorized clinician'}.</p>
      <p>Use emergency access only when urgent treatment requires it. Access is limited to reading released records at your selected facility. Each activation requires a reason, an expiry, audit recording, and facility review.</p>
      {!facilities.length ? <p role="alert">Your active facility memberships do not permit emergency access.</p> : !grant ? <form onSubmit={activate} style={{ display: 'grid', gap: 16 }}>
        <label>Facility<select required value={facilityId} onChange={event => setFacilityId(event.target.value)}>{facilities.map(facility => <option key={facility.id} value={facility.id}>{facility.name}</option>)}</select></label>
        <label>Patient HID<input required autoComplete="off" value={hid} onChange={event => setHid(event.target.value.toUpperCase())} placeholder="HID-ABCDEFGH" /></label>
        <label>Emergency reason<textarea required minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label>Access duration in minutes<input required type="number" min={5} max={240} step={1} value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>
        <button disabled={busy}>Activate emergency read access</button>
      </form> : <section>
        <h2>Emergency read access</h2><p>Expires {new Date(grant.expiresAt).toLocaleString()} · {facilities.find(facility => facility.id === facilityId)?.name}</p>
        <label>Closing reason<input minLength={8} maxLength={500} value={closingReason} onChange={event => setClosingReason(event.target.value)} /></label>
        <button disabled={busy} onClick={() => { void close() }}>Revoke access now</button>
        {records && <RecordSummary records={records} />}
      </section>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </CarePortal>
}
