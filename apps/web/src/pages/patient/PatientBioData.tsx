import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { OtpInputs } from '../../components/OtpInputs'
import { PortalShell } from '../../components/PortalShell'
import { Button, Card, Input, Modal, PageLoader, Select, Textarea, showToast } from '../../components/ui'
import { setPatientSession, signOutAndClearSessions, usePortalSession } from '../../lib/auth'
import {
  readPatientProfileSnapshot,
  seedPatientProfileCache,
  warmPatientExperience,
} from '../../lib/experienceWarmup'
import {
  deleteMyAccount,
  fetchMyPatient,
  setMyPatientAccessPin,
  startAccountDeletion,
  updateMyPatientProfile,
  verifyAccountDeletionCode,
} from '../../lib/hidApi'
import {
  BLOOD_GROUPS,
  COUNTRIES,
  GENOTYPES,
  STATES_BY_COUNTRY,
  calculateAge,
  formatDate,
  getPersonInitials,
  parseDisplayDate,
} from '../../lib/utils'
import type { Patient } from '../../types/database'

const patientNav = [
  { path: '/patient/profile', label: 'Home' },
  { path: '/patient/records', label: 'Records' },
  { path: '/patient/history', label: 'Access History' },
  { path: '/patient/biodata', label: 'Biodata' },
]

const PROFILE_IMAGE_MAX_BYTES = 500 * 1024
const PROFILE_IMAGE_REQUIREMENTS = '600 to 800px, JPG, PNG, or IMG, up to 500 KB.'
const PATIENT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function PatientBioData() {
  const navigate = useNavigate()
  const { patient: session, hydrated } = usePortalSession()
  const cachedPatient = useMemo(() => (
    session ? readPatientProfileSnapshot(session.hidCode) : null
  ), [session])
  const [patient, setPatient] = useState<Patient | null>(cachedPatient)
  const [loading, setLoading] = useState(!cachedPatient)
  const [saving, setSaving] = useState(false)
  const [savedProfileSnapshot, setSavedProfileSnapshot] = useState(() => (
    cachedPatient ? buildProfileSnapshot(cachedPatient, formatDate(cachedPatient.dob), '') : ''
  ))
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [profileConfirmed, setProfileConfirmed] = useState(false)
  const [accessPinDraft, setAccessPinDraft] = useState('')
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteChallengeId, setDeleteChallengeId] = useState('')
  const [deleteMaskedEmail, setDeleteMaskedEmail] = useState('')
  const [deleteOtp, setDeleteOtp] = useState('')
  const [deleteVerificationToken, setDeleteVerificationToken] = useState('')
  const [sendingDeleteOtp, setSendingDeleteOtp] = useState(false)
  const [verifyingDeleteOtp, setVerifyingDeleteOtp] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [dobInput, setDobInput] = useState(() => cachedPatient ? formatDate(cachedPatient.dob) : '')
  const [openSections, setOpenSections] = useState({
    about: false,
    coverage: false,
    health: false,
    emergency: false,
    notes: false,
  })

  useEffect(() => {
    if (!hydrated) return
    if (!session) {
      navigate('/patient')
      return
    }

    let active = true
    void (async () => {
      try {
        const nextPatient = await fetchMyPatient()
        if (!active) return
        seedPatientProfileCache(nextPatient)
        if (session) {
          warmPatientExperience(session, nextPatient)
        }
        setPatient(nextPatient)
        setDobInput(formatDate(nextPatient.dob))
        setSavedProfileSnapshot(buildProfileSnapshot(nextPatient, formatDate(nextPatient.dob), ''))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to load your profile.'
        showToast(message, 'error')
        if (active) navigate('/patient')
      } finally {
        if (active) setLoading(false)
      }
    })()

    return () => { active = false }
  }, [hydrated, navigate, session])

  const hasPendingProfileChanges = useMemo(() => {
    if (!patient) return false

    return buildProfileSnapshot(patient, dobInput, accessPinDraft) !== savedProfileSnapshot
  }, [accessPinDraft, dobInput, patient, savedProfileSnapshot])

  async function logout() {
    await signOutAndClearSessions()
    navigate('/patient')
  }

  function updatePatientDraft(updater: (current: Patient) => Patient) {
    setPatient(current => current ? updater(current) : current)
  }

  async function uploadProfilePicture(file: File) {
    if (!patient || uploadingPhoto) return

    const validation = await validateProfileImage(file)
    if (!validation.ok) {
      showToast(validation.message, 'error')
      return
    }

    setUploadingPhoto(true)
    try {
      const nextPatient = await updateMyPatientProfile({ photo_url: validation.dataUrl })
      setPatient(nextPatient)
      setSavedProfileSnapshot(buildProfileSnapshot(nextPatient, formatDate(nextPatient.dob), accessPinDraft))
      showToast('Profile photo updated.', 'success')
      seedPatientProfileCache(nextPatient)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update your profile photo.'
      showToast(message, 'error')
    } finally {
      setUploadingPhoto(false)
    }
  }

  async function saveProfile() {
    if (!patient || saving) return
    if (!hasPendingProfileChanges) {
      return
    }
    if (!profileConfirmed) {
      showToast('Confirm that the information provided is correct before saving.', 'error')
      return
    }

    const parsedDob = parseDisplayDate(dobInput)
    if (dobInput && !parsedDob) {
      showToast('Date of birth must use DD-MM-YYYY format.', 'error')
      return
    }

    const normalizedEmail = normalizePatientEmail(patient.email)
    if (normalizedEmail && !PATIENT_EMAIL_PATTERN.test(normalizedEmail)) {
      showToast('Enter a valid email address before saving.', 'error')
      return
    }
    if (accessPinDraft.trim() && !/^\d{4,8}$/.test(accessPinDraft.trim())) {
      showToast('Access PIN must be 4 to 8 digits.', 'error')
      return
    }

    setSaving(true)
    try {
      const fullName = `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim() || patient.full_name
      const profilePercent = calculateProfilePercent(patient, parsedDob, patient.access_pin_configured || !!accessPinDraft.trim())
      let nextPatient = await updateMyPatientProfile({
        ...patient,
        full_name: fullName,
        email: normalizedEmail,
        dob: parsedDob,
        profile_percent: profilePercent,
      })

      if (accessPinDraft.trim()) {
        const accessPin = await setMyPatientAccessPin(accessPinDraft.trim())
        nextPatient = {
          ...nextPatient,
          access_pin_configured: accessPin.configured,
        }
      }

      seedPatientProfileCache(nextPatient)
      if (session) {
        warmPatientExperience(session, nextPatient)
      }

      setPatient(nextPatient)
      setAccessPinDraft('')
      setSavedProfileSnapshot(buildProfileSnapshot(nextPatient, formatDate(nextPatient.dob), ''))
      setProfileConfirmed(false)
      setOpenSections(current => ({ ...current, about: false }))
      setPatientSession({
        hidCode: nextPatient.hid_code,
        phone: nextPatient.phone ?? '',
        fullName: nextPatient.full_name,
      })
      showToast('Profile saved.', 'success')
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save your profile.'
      showToast(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  function resetDeleteFlow() {
    setDeleteConfirmText('')
    setDeleteChallengeId('')
    setDeleteMaskedEmail('')
    setDeleteOtp('')
    setDeleteVerificationToken('')
    setSendingDeleteOtp(false)
    setVerifyingDeleteOtp(false)
    setDeletingAccount(false)
  }

  async function requestDeleteOtp() {
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      showToast('Type DELETE to confirm account deletion.', 'error')
      return
    }

    setSendingDeleteOtp(true)
    try {
      const result = await startAccountDeletion()
      setDeleteChallengeId(result.challengeId)
      setDeleteMaskedEmail(result.maskedEmail ?? '')
      setDeleteOtp('')
      setDeleteVerificationToken('')
      showToast(`We sent a 6-digit code to ${result.maskedEmail || 'your email address'}.`, 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send a verification code right now.'
      showToast(message, 'error')
    } finally {
      setSendingDeleteOtp(false)
    }
  }

  async function verifyDeleteOtp(nextCode = deleteOtp) {
    if (nextCode.trim().length !== 6 || !deleteChallengeId) {
      showToast('Enter the full 6-digit verification code first.', 'error')
      return
    }

    setVerifyingDeleteOtp(true)
    try {
      const result = await verifyAccountDeletionCode(deleteChallengeId, nextCode.trim())
      setDeleteVerificationToken(result.verificationToken)
      showToast('Verification complete. You can now delete your account.', 'success')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The verification code is not correct.'
      showToast(message, 'error')
    } finally {
      setVerifyingDeleteOtp(false)
    }
  }

  async function confirmPermanentDelete() {
    if (!deleteChallengeId || !deleteVerificationToken) {
      showToast('Verify the 6-digit code before deleting your account.', 'error')
      return
    }

    setDeletingAccount(true)
    try {
      await deleteMyAccount(deleteChallengeId, deleteVerificationToken)
      showToast('Your account has been deleted and is no longer available.', 'success')
      navigate('/patient', { replace: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete your account right now.'
      showToast(message, 'error')
    } finally {
      setDeletingAccount(false)
    }
  }

  if (!hydrated) return <PageLoader label="Restoring your secure session..." />
  if (!session) return null
  if (loading || !patient) {
    return (
      <PortalShell
        title="Biodata"
        subtitle="Update the details tied to your HID profile."
        items={patientNav}
        onLogout={() => { void logout() }}
        userName={session.fullName}
        notificationPath="/patient/notifications"
        notificationHidCode={session.hidCode}
      >
        <PageLoader label="Loading your profile..." />
      </PortalShell>
    )
  }

  const stateOptions = (patient.country ? STATES_BY_COUNTRY[patient.country] ?? [] : []).map(value => ({ value, label: value }))
  const showStateSelect = stateOptions.length > 0
  const liveProfilePercent = calculateProfilePercent(patient, parseDisplayDate(dobInput), patient.access_pin_configured || !!accessPinDraft.trim())
  const patientName = `${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim() || patient.full_name
  const patientInitials = getPersonInitials(patientName)

  function onDobTextChange(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 8)
    if (digits.length <= 2) {
      setDobInput(digits)
      return
    }
    if (digits.length <= 4) {
      setDobInput(`${digits.slice(0, 2)}-${digits.slice(2)}`)
      return
    }
    setDobInput(`${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`)
  }

  function toggleSection(section: keyof typeof openSections) {
    setOpenSections(current => ({ ...current, [section]: !current[section] }))
  }

  function handleProfileAction() {
    if (hasPendingProfileChanges) {
      void saveProfile()
      return
    }

    setOpenSections(current => ({ ...current, about: true }))
  }

  return (
    <PortalShell
      title="Biodata"
      subtitle={`${patient.full_name} | ${patient.hid_code}`}
      items={patientNav}
      onLogout={() => { void logout() }}
      userName={patientName}
      avatarUrl={patient.photo_url}
      notificationPath="/patient/notifications"
      notificationHidCode={session.hidCode}
      onAvatarUpload={file => { void uploadProfilePicture(file) }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 28, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <Card style={{ borderRadius: 24, padding: 22 }}>
            <div style={{ color: '#4b5563', fontSize: 15, fontWeight: 700 }}>Profile completion</div>
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #edf1f5', fontSize: 42, fontWeight: 700, color: '#111827', lineHeight: 1 }}>
              {liveProfilePercent}%
            </div>
          </Card>

          <Card style={{ borderRadius: 28, padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                {patient.photo_url ? (
                  <img src={patient.photo_url} alt={patient.full_name} style={{ width: 66, height: 66, borderRadius: '50%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: 66, height: 66, borderRadius: '50%', background: 'linear-gradient(180deg, #f4f7fb 0%, #dfe8f4 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#68758b' }}>
                    {patientInitials}
                  </div>
                )}
                <span style={{ position: 'absolute', right: 2, bottom: 2, width: 11, height: 11, borderRadius: '50%', background: '#22c55e', border: '2px solid #fff' }} />
              </div>
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 700, color: '#111827', fontSize: 16 }}>{patient.full_name}</div>
                <div style={{ marginTop: 4, color: '#1f8cff', fontSize: 12, fontWeight: 600 }}>{patient.hid_code}</div>
              </div>
            </div>

            <div style={{ marginTop: 18, color: '#8a95a6', fontSize: 11 }}>{uploadingPhoto ? 'Uploading photo...' : `Profile photo: ${PROFILE_IMAGE_REQUIREMENTS}`}</div>

            <ProfileSummarySection
              title="Basic Information"
              items={[
                { label: 'Name', value: patient.full_name || '-' },
                { label: 'Health ID', value: patient.hid_code },
                { label: 'Phone', value: patient.phone || '-' },
                { label: 'Email', value: patient.email || '-' },
                { label: 'Access PIN', value: patient.access_pin_configured ? 'Set' : 'Not set' },
                { label: 'Date of Birth', value: formatDate(patient.dob) },
                { label: 'Gender', value: patient.gender || '-' },
                { label: 'Country, State', value: [patient.country, patient.state].filter(Boolean).join(', ') || '-' },
              ]}
            />
            <ProfileSummarySection
              title="Health Information"
              items={[
                { label: 'Blood Group', value: patient.blood_group || '-' },
                { label: 'Genotype', value: patient.genotype || '-' },
                { label: 'Allergies', value: patient.allergies || '-' },
                { label: 'Chronic Conditions', value: patient.chronic_conditions || '-' },
                { label: 'Current Medication', value: patient.current_medications || '-' },
              ]}
            />
            <ProfileSummarySection
              title="Emergency Contact"
              items={[
                { label: 'Name', value: patient.emergency_contact_name || '-' },
                { label: 'Relationship', value: patient.emergency_contact_relationship || '-' },
                { label: 'Phone Number', value: patient.emergency_contact_phone || '-' },
                { label: 'Address', value: patient.emergency_contact_address || '-' },
              ]}
            />
            <ProfileSummarySection
              title="Coverage"
              items={[
                { label: 'Current Hospital', value: patient.hospital_currently_using || '-' },
                { label: 'HMO Organization', value: patient.hmo_organization || '-' },
              ]}
            />
          </Card>
        </div>

        <Card style={{ borderRadius: 28, padding: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#111827' }}>Complete Your Profile</div>
          <div style={{ color: '#8a95a6', fontSize: 12, marginTop: 6 }}>
            Update the details patients and providers rely on most often.
          </div>

          <AccordionHeader
            title="About Me"
            subtitle="Basic identity and contact details."
            open={openSections.about}
            onClick={() => toggleSection('about')}
          />
          {openSections.about && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 16 }}>
                <Input label="First Name" value={patient.first_name ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, first_name: e.target.value }))} />
                <Input label="Last Name" value={patient.last_name ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, last_name: e.target.value }))} />
                <Input label="Phone Number" value={patient.phone ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, phone: e.target.value }))} />
                <Input label="Email Address" type="email" placeholder="yourname@gmail.com" value={patient.email ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, email: e.target.value }))} />
                <Input
                  label="Access PIN"
                  type="password"
                  placeholder={patient.access_pin_configured ? 'Enter a new 4 to 8 digit PIN to change it' : 'Create a 4 to 8 digit PIN'}
                  value={accessPinDraft}
                  onChange={e => setAccessPinDraft(e.target.value.replace(/\D/g, '').slice(0, 8))}
                />
                <Select
                  placeholder="Gender"
                  value={patient.gender ?? ''}
                  onChange={e => updatePatientDraft(current => ({ ...current, gender: e.target.value }))}
                  options={[{ value: 'Female', label: 'Female' }, { value: 'Male', label: 'Male' }, { value: 'Other', label: 'Other' }]}
                />
                <Input label="Date of Birth" value={dobInput} onChange={e => onDobTextChange(e.target.value)} placeholder="31-12-2000" />
                <Input label="Age" disabled value={calculateAge(parseDisplayDate(dobInput) ?? patient.dob)} />
                <Select
                  label="Country"
                  value={patient.country ?? ''}
                  onChange={e => updatePatientDraft(current => ({ ...current, country: e.target.value, state: '' }))}
                  options={COUNTRIES.map(value => ({ value, label: value }))}
                />
                {showStateSelect ? (
                  <Select
                    label="State"
                    value={patient.state ?? ''}
                    onChange={e => updatePatientDraft(current => ({ ...current, state: e.target.value }))}
                    options={stateOptions}
                  />
                ) : (
                  <Input label="State / Region" value={patient.state ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, state: e.target.value }))} />
                )}
              </div>
              <div style={{ marginTop: 10, color: '#8a95a6', fontSize: 11 }}>
                Standard hospital access uses this PIN together with your HID code. {patient.access_pin_configured ? 'A PIN is already set for this account.' : 'No Access PIN has been set yet.'}
              </div>
            </>
          )}

          <AccordionHeader
            title="Coverage Details"
            subtitle="Hospital and HMO information."
            open={openSections.coverage}
            onClick={() => toggleSection('coverage')}
          />
          {openSections.coverage && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 16 }}>
              <Input
                label="Current Hospital"
                value={patient.hospital_currently_using ?? ''}
                onChange={e => updatePatientDraft(current => ({ ...current, hospital_currently_using: e.target.value }))}
                placeholder="Enter your current hospital"
              />
              <Input
                label="HMO Organization"
                value={patient.hmo_organization ?? ''}
                onChange={e => updatePatientDraft(current => ({ ...current, hmo_organization: e.target.value }))}
                placeholder="Enter your HMO organization"
              />
            </div>
          )}

          <AccordionHeader
            title="Health Information"
            subtitle="Details clinicians commonly review first."
            open={openSections.health}
            onClick={() => toggleSection('health')}
          />
          {openSections.health && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 16 }}>
                <Select label="Blood Group" value={patient.blood_group ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, blood_group: e.target.value }))} options={BLOOD_GROUPS.map(value => ({ value, label: value }))} />
                <Select label="Genotype" value={patient.genotype ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, genotype: e.target.value }))} options={GENOTYPES.map(value => ({ value, label: value }))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: 14, marginTop: 14 }}>
                <Textarea label="Allergies" value={patient.allergies ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, allergies: e.target.value }))} />
                <Textarea label="Current Medications" value={patient.current_medications ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, current_medications: e.target.value }))} />
                <Textarea label="Chronic Conditions" value={patient.chronic_conditions ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, chronic_conditions: e.target.value }))} />
              </div>
            </>
          )}

          <AccordionHeader
            title="Emergency Contact"
            subtitle="Who should be contacted in urgent situations?"
            open={openSections.emergency}
            onClick={() => toggleSection('emergency')}
          />
          {openSections.emergency && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 14 }}>
              <Input label="Full Name" value={patient.emergency_contact_name ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, emergency_contact_name: e.target.value }))} />
              <Input label="Relationship" value={patient.emergency_contact_relationship ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, emergency_contact_relationship: e.target.value }))} />
              <Input label="Phone Number" value={patient.emergency_contact_phone ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, emergency_contact_phone: e.target.value }))} />
              <Input label="Address" value={patient.emergency_contact_address ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, emergency_contact_address: e.target.value }))} />
            </div>
          )}

          <AccordionHeader
            title="Medical Notes (Optional)"
            subtitle="Anything your care team should know?"
            open={openSections.notes}
            onClick={() => toggleSection('notes')}
          />
          {openSections.notes && (
            <div style={{ marginTop: 14 }}>
              <Textarea label="Medical Notes" value={patient.medical_notes ?? ''} onChange={e => updatePatientDraft(current => ({ ...current, medical_notes: e.target.value }))} />
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
            <div style={{ color: '#6b7280', fontSize: 12 }}>
              Profile completion: {liveProfilePercent}%
            </div>
            <Button loading={saving} onClick={handleProfileAction}>
              {hasPendingProfileChanges ? 'Save' : 'Edit'}
            </Button>
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, color: '#4b5563', fontSize: 12 }}>
            <input type="checkbox" checked={profileConfirmed} onChange={e => setProfileConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
            <span>I confirm the information provided is correct.</span>
          </label>

          <div style={{ marginTop: 28, borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#374151' }}>Danger Zone</div>
            <div style={{ color: '#6b7280', fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
              Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored.
            </div>
            <Button
              variant="outline"
              style={{ marginTop: 14, borderColor: '#d1d5db', color: '#374151', background: '#f9fafb' }}
              onClick={() => {
                resetDeleteFlow()
                setDeleteModalOpen(true)
              }}
            >
              Delete account
            </Button>
          </div>
        </Card>
      </div>

      <Modal open={deleteModalOpen} onClose={() => { if (!sendingDeleteOtp && !verifyingDeleteOtp && !deletingAccount) setDeleteModalOpen(false) }} title="Delete patient account" width={520}>
        <div style={{ display: 'grid', gap: 16 }}>
          {!deleteChallengeId ? (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored. Type DELETE, then we will send a 6-digit verification code to your email.
              </div>
              <Input
                label='Type "DELETE" to confirm'
                value={deleteConfirmText}
                onChange={event => setDeleteConfirmText(event.target.value)}
                placeholder="DELETE"
                autoComplete="off"
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={sendingDeleteOtp}>
                  Cancel
                </Button>
                <Button variant="danger" loading={sendingDeleteOtp} onClick={() => void requestDeleteOtp()}>
                  Send OTP
                </Button>
              </div>
            </>
          ) : !deleteVerificationToken ? (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                We sent a 6-digit code to {deleteMaskedEmail || 'your email address'}. Enter it below to confirm account deletion.
              </div>
              <OtpInputs value={deleteOtp} onChange={setDeleteOtp} onComplete={verifyDeleteOtp} />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void requestDeleteOtp()}
                  style={{ border: 'none', background: 'none', color: '#1f8cff', fontSize: 12, cursor: 'pointer', padding: 0 }}
                >
                  Send code again
                </button>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={verifyingDeleteOtp || sendingDeleteOtp}>
                    Cancel
                  </Button>
                  <Button variant="danger" loading={verifyingDeleteOtp} onClick={() => void verifyDeleteOtp()}>
                    Verify code
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div style={{ color: '#4b5563', fontSize: 13, lineHeight: 1.7 }}>
                Verification complete. Deleting your account removes your access to HID immediately. You can recover your account through HID Support within 30 days. After 30 days, your account and data are permanently deleted and cannot be restored.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={() => setDeleteModalOpen(false)} disabled={deletingAccount}>
                  Cancel
                </Button>
                <Button variant="danger" loading={deletingAccount} onClick={() => void confirmPermanentDelete()}>
                  Delete account
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </PortalShell>
  )
}

function AccordionHeader({ title, subtitle, open, onClick }: { title: string; subtitle: string; open: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ marginTop: 24, width: '100%', border: 'none', background: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 0, cursor: 'pointer' }}>
      <div style={{ textAlign: 'left' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{title}</div>
        <div style={{ marginTop: 6, color: '#9aa6b2', fontSize: 11 }}>{subtitle}</div>
      </div>
      <span style={{ color: '#9aa6b2', fontSize: 18, fontWeight: 700 }}>{open ? '-' : '+'}</span>
    </button>
  )
}

function ProfileSummarySection({ title, items }: { title: string; items: Array<{ label: string; value: string }> }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#60a5fa', fontSize: 12, fontWeight: 700 }}>
        <span style={{ width: 18, height: 18, borderRadius: 999, border: '1px solid #bfdbfe', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
          i
        </span>
        {title}
      </div>
      <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
        {items.map(item => (
          <div key={`${title}-${item.label}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 140px) minmax(0, 1fr)', gap: 10, fontSize: 13 }}>
            <div style={{ color: '#9aa6b2' }}>{item.label}:</div>
            <div style={{ color: '#111827', fontWeight: 500, wordBreak: 'break-word' }}>{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function calculateProfilePercent(patient: Patient, parsedDob: string | null, accessPinConfigured = Boolean(patient.access_pin_configured)) {
  const requiredFields = [
    patient.first_name,
    patient.last_name,
    patient.phone,
    patient.hospital_currently_using,
    patient.gender,
    parsedDob,
    patient.country,
    patient.state,
    patient.hmo_organization,
    patient.genotype,
    patient.blood_group,
    patient.emergency_contact_name,
    patient.emergency_contact_relationship,
    patient.emergency_contact_phone,
    patient.emergency_contact_address,
    accessPinConfigured ? 'configured' : null,
  ]
  return Math.round((requiredFields.filter(Boolean).length / requiredFields.length) * 100)
}

function buildProfileSnapshot(patient: Patient, dobValue: string, accessPinDraft: string) {
  return JSON.stringify({
    first_name: patient.first_name ?? '',
    last_name: patient.last_name ?? '',
    full_name: patient.full_name ?? '',
    phone: patient.phone ?? '',
    email: normalizePatientEmail(patient.email),
    gender: patient.gender ?? '',
    dob: parseDisplayDate(dobValue) ?? '',
    blood_group: patient.blood_group ?? '',
    genotype: patient.genotype ?? '',
    country: patient.country ?? '',
    state: patient.state ?? '',
    hospital_currently_using: patient.hospital_currently_using ?? '',
    allergies: patient.allergies ?? '',
    chronic_conditions: patient.chronic_conditions ?? '',
    current_medications: patient.current_medications ?? '',
    photo_url: patient.photo_url ?? '',
    emergency_contact_name: patient.emergency_contact_name ?? '',
    emergency_contact_relationship: patient.emergency_contact_relationship ?? '',
    emergency_contact_phone: patient.emergency_contact_phone ?? '',
    emergency_contact_address: patient.emergency_contact_address ?? '',
    hmo_organization: patient.hmo_organization ?? '',
    medical_notes: patient.medical_notes ?? '',
    notifications_enabled: Boolean(patient.notifications_enabled),
    access_pin_draft: accessPinDraft.trim(),
  })
}

function normalizePatientEmail(value: string | null | undefined) {
  const normalized = (value ?? '').trim().toLowerCase()
  return normalized || null
}

async function validateProfileImage(file: File): Promise<
  | { ok: true; dataUrl: string }
  | { ok: false; message: string }
> {
  const fileName = file.name.toLowerCase()
  const fileType = file.type.toLowerCase()
  const hasAllowedExtension = ['.img', '.png', '.jpg', '.jpeg'].some(extension => fileName.endsWith(extension))
  const hasAllowedType = ['image/png', 'image/jpeg'].includes(fileType)

  if (!hasAllowedExtension && !hasAllowedType) {
    return { ok: false, message: 'Profile photo must be a JPG, PNG, or IMG file.' }
  }

  if (file.size > PROFILE_IMAGE_MAX_BYTES) {
    return { ok: false, message: 'Profile photo must be 500 KB or smaller.' }
  }

  try {
    const dataUrl = await readFileAsDataUrl(file)
    const dimensions = await loadImageDimensions(dataUrl)

    if (
      dimensions.width < 600 ||
      dimensions.width > 800 ||
      dimensions.height < 600 ||
      dimensions.height > 800
    ) {
      return { ok: false, message: 'Profile photo width and height must each be between 600px and 800px.' }
    }

    return { ok: true, dataUrl }
  } catch {
    return { ok: false, message: 'We could not read that profile photo. Use a clear JPG, PNG, or IMG file.' }
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Invalid image result'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'))
    reader.readAsDataURL(file)
  })
}

function loadImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.width, height: image.height })
    image.onerror = () => reject(new Error('Image load failed'))
    image.src = dataUrl
  })
}
