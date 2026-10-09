import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CarePortal } from '../../components/CarePortal'
import { getIdentityActorContext, identityClient, type IdentityActorContext } from '../../lib/identityClient'
import { patientRegistrationApi, type RegistrationCapabilities, type RegistrationCase, type RegistrationInput } from '../../lib/patientRegistrationApi'

const emptyInput: RegistrationInput = { nin: '', firstName: '', lastName: '', dateOfBirth: '' }
export default function PatientRegistration() {
  const [actor, setActor] = useState<IdentityActorContext | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [facility, setFacility] = useState('')
  const [capabilities, setCapabilities] = useState<RegistrationCapabilities | null>(null)
  const [capabilitiesError, setCapabilitiesError] = useState(false)
  const [input, setInput] = useState(emptyInput)
  const [registration, setRegistration] = useState<RegistrationCase | null>(null)
  const [caseId, setCaseId] = useState('')
  const [candidate, setCandidate] = useState('')
  const [reason, setReason] = useState('')
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  // Kept only in memory; unchanged retries reuse the original command key.
  const command = useRef<{ signature: string; key: string } | null>(null)
  const keyFor = (value: unknown) => {
    const signature = JSON.stringify(value)
    if (command.current?.signature !== signature) command.current = { signature, key: crypto.randomUUID() }
    return command.current.key
  }
  const clear = () => {
    generation.current++; command.current = null; setRegistration(null); setInput(emptyInput)
    setCandidate(''); setReason(''); setEmail(''); setCaseId(''); setNotice(''); setError('')
  }
  useEffect(() => {
    let active = true
    void getIdentityActorContext().then(value => {
      if (!active) return
      setActor(value); setFacility(value?.facilities.find(row => row.permissions.includes('identity.registration.write'))?.id ?? '')
      setLoaded(true)
    }).catch(() => { if (active) { setLoaded(true); setError('Unable to verify your session. Sign in again.') } })
    const { data } = identityClient.auth.onAuthStateChange(event => {
      if (event === 'SIGNED_OUT') { clear(); setActor(null) }
    })
    return () => { active = false; generation.current++; command.current = null; data.subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    let active = true
    setCapabilities(null); setCapabilitiesError(false)
    if (facility) void patientRegistrationApi.capabilities(facility).then(value => {
      if (active) setCapabilities(value)
    }).catch(() => { if (active) setCapabilitiesError(true) })
    return () => { active = false }
  }, [facility])
  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Registration could not be completed. Retry or reopen the case.')
    } finally { setBusy(false) }
  }
  async function load(id: string, version: number) {
    const value = await patientRegistrationApi.read(facility, id)
    if (generation.current === version) { setRegistration(value); setCaseId(value.caseId); setCandidate('') }
  }
  async function resolve(event: React.FormEvent) {
    event.preventDefault()
    if (!capabilities?.nin.enabled) return
    const version = generation.current
    await perform(async () => {
      const value = await patientRegistrationApi.resolve(facility, input, keyFor(['resolve', facility, input]))
      if (generation.current !== version) return
      setInput(emptyInput); command.current = null; setRegistration(value); setCaseId(value.caseId)
      await load(value.caseId, version)
    })
  }
  async function review(event: React.FormEvent) {
    event.preventDefault(); if (!registration) return
    const version = generation.current
    await perform(async () => {
      const value = await patientRegistrationApi.review(facility, registration, reason,
        registration.status === 'review_required' ? candidate : null, keyFor(['review', facility, registration.caseId, registration.version, reason, candidate]))
      if (generation.current === version) { setRegistration(value); setReason(''); command.current = null }
    })
  }
  async function enroll(event: React.FormEvent) {
    event.preventDefault(); if (!registration) return
    const version = generation.current
    await perform(async () => {
      const value = await patientRegistrationApi.enroll(facility, registration, email, reason,
        keyFor(['enroll', facility, registration.caseId, registration.version, email, reason]))
      if (generation.current === version) {
        setEmail(''); setReason(''); command.current = null
        setNotice(`Portal account prepared for ${value.hid}. The patient must verify their email and set a password using account recovery before signing in.`)
      }
    })
  }
  const facilities = actor?.facilities.filter(row => row.permissions.includes('identity.registration.write')) ?? []
  const canApprove = facilities.find(row => row.id === facility)?.permissions.includes('identity.registration.approve') ?? false
  const awaitingReview = registration?.status === 'pending_new_identity_approval' || registration?.status === 'review_required'
  return <CarePortal title="Patient registration">
    {!loaded ? <p role="status">Verifying your session…</p> : !actor ? <p><Link to="/hospital/auth">Sign in with your facility account</Link></p> : !facilities.length ?
      <p role="alert">Your current facility memberships do not permit patient registration.</p> : <>
      <p>Verify identity, review possible matches, and confirm the canonical HID before enrolling a patient portal account.</p>
      <label>Facility<select disabled={busy} value={facility} onChange={event => { clear(); setFacility(event.target.value) }}>
        {facilities.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label>
      {!registration ? <>
        {capabilitiesError ? <p role="alert">Registration availability could not be checked. Reload this page to retry.</p>
          : !capabilities ? <p role="status">Checking registration availability…</p>
          : !capabilities.nin.enabled ? <p role="status">{capabilities.nin.state === 'deferred'
            ? 'NIN registration is deferred in staging. Prepared staging patient accounts can still use sign-in, recovery, records and care access.'
            : 'NIN registration is currently unavailable.'}</p>
          : <form onSubmit={resolve} autoComplete="off" style={{ display: 'grid', gap: 12 }}>
          <h2>Verify NIN</h2>
          <label>NIN<input required inputMode="numeric" pattern="[0-9]{11}" maxLength={11} value={input.nin} onChange={event => setInput({ ...input, nin: event.target.value })} /></label>
          <label>First name<input required maxLength={100} value={input.firstName} onChange={event => setInput({ ...input, firstName: event.target.value })} /></label>
          <label>Last name<input required maxLength={100} value={input.lastName} onChange={event => setInput({ ...input, lastName: event.target.value })} /></label>
          <label>Date of birth<input required type="date" max={new Date().toISOString().slice(0, 10)} value={input.dateOfBirth} onChange={event => setInput({ ...input, dateOfBirth: event.target.value })} /></label>
          <button disabled={busy}>Verify and check for an existing patient</button>
        </form>}
        <form onSubmit={event => { event.preventDefault(); void perform(() => load(caseId, generation.current)) }}>
          <h2>Continue a registration case</h2>
          <label>Case reference<input required value={caseId} onChange={event => setCaseId(event.target.value.trim())} /></label>
          <button disabled={busy}>Open case</button>
        </form>
      </> : <section>
        <h2>Registration case</h2><p>Reference: {registration.caseId}</p><p>{registration.status.replace(/_/g, ' ')}</p>
        {registration.patient && <p>Canonical HID: <strong>{registration.patient.hid}</strong></p>}
        {awaitingReview && (canApprove ? <form onSubmit={review} style={{ display: 'grid', gap: 12 }}>
          {registration.status === 'review_required' ? <>
            <p>Review the possible matches with the patient. A new HID cannot be issued while this review is unresolved.</p>
            <label>Confirmed existing patient<select required value={candidate} onChange={event => setCandidate(event.target.value)}>
              <option value="">Select a reviewed match</option>
              {registration.candidates?.map(row => <option key={row.patientId} value={row.patientId}>{row.fullName} · {row.dateOfBirth ?? 'Date of birth unavailable'}</option>)}
            </select></label>
          </> : <p>No candidate was found. Confirm this is a new person before approving HID issuance.</p>}
          <label>Review reason<textarea required minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button disabled={busy}>{registration.status === 'review_required' ? 'Confirm existing patient' : 'Approve new patient identity'}</button>
        </form> : <p>An authorized registration reviewer must complete this case.</p>)}
        {registration.patient && canApprove && <form onSubmit={enroll} style={{ display: 'grid', gap: 12 }}>
          <h2>Prepare portal access</h2><p>Confirm the patient's contact details in person. An existing account or patient mapping cannot be replaced here.</p>
          <label>Patient email<input required type="email" maxLength={254} autoComplete="off" value={email} onChange={event => setEmail(event.target.value)} /></label>
          <label>Enrollment reason<textarea required minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <button disabled={busy}>Prepare account for email verification</button>
        </form>}
        <button disabled={busy} onClick={clear}>Start another case</button>
      </section>}
    </>}
    {notice && <p role="status">{notice} <Link to="/patient">Patient sign in and recovery</Link></p>}
    {error && <p role="alert">{error}</p>}
  </CarePortal>
}
