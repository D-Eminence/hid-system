import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Select, Textarea, showToast } from './ui'
import { SHARE_DURATION_PRESETS, SHARE_PERMISSION_TIERS } from '../lib/shareUtils'
import { createShare, createShareInvite, searchStaffForShare } from '../lib/hidApi'
import type { HidShareDurationPreset, HidSharePermissionTier, HidStaffSearchResult } from '../types/hid'

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

interface ShareProfileModalProps {
  open: boolean
  onClose: () => void
  onShared: () => void
}

export function ShareProfileModal({ open, onClose, onShared }: ShareProfileModalProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<HidStaffSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<HidStaffSearchResult | null>(null)
  const [inviteMode, setInviteMode] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [permissionTier, setPermissionTier] = useState<HidSharePermissionTier>('view_only')
  const [durationPreset, setDurationPreset] = useState<HidShareDurationPreset>('7d')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      return
    }

    setSearching(true)
    const timeout = setTimeout(() => {
      searchStaffForShare(trimmed)
        .then(setResults)
        .catch(error => {
          const message = error instanceof Error ? error.message : 'Unable to search for providers.'
          showToast(message, 'error')
        })
        .finally(() => setSearching(false))
    }, 300)

    return () => clearTimeout(timeout)
  }, [query, open])

  function reset() {
    setQuery('')
    setResults([])
    setSelected(null)
    setInviteMode(false)
    setInviteEmail('')
    setInviteName('')
    setPermissionTier('view_only')
    setDurationPreset('7d')
    setReason('')
  }

  function handleClose() {
    if (saving) return
    reset()
    onClose()
  }

  function openInviteMode() {
    setInviteEmail(EMAIL_PATTERN.test(query.trim()) ? query.trim() : '')
    setInviteMode(true)
  }

  async function handleSubmit() {
    if (saving) return

    if (inviteMode) {
      const email = inviteEmail.trim()
      if (!EMAIL_PATTERN.test(email)) {
        showToast('Enter a valid email address.', 'error')
        return
      }

      setSaving(true)
      try {
        const result = await createShareInvite({
          email,
          fullName: inviteName.trim() || undefined,
          permissionTier,
          durationPreset,
          reason: reason.trim() || undefined,
        })
        if (result.mode === 'connected') {
          showToast('Profile shared.', 'success')
        } else {
          showToast("Invitation sent - they'll get access automatically once they join HID.", 'success')
        }
        reset()
        onClose()
        onShared()
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to send the invitation.'
        showToast(message, 'error')
      } finally {
        setSaving(false)
      }
      return
    }

    if (!selected) return
    setSaving(true)
    try {
      await createShare({
        staffAccountId: selected.staff_account_id,
        permissionTier,
        durationPreset,
        reason: reason.trim() || undefined,
      })
      showToast('Profile shared.', 'success')
      reset()
      onClose()
      onShared()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to share your profile.'
      showToast(message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={handleClose} title="Share my profile" width={520}>
      <div style={{ display: 'grid', gap: 14 }}>
        {!selected && !inviteMode ? (
          <>
            <Input
              label="Find a provider"
              placeholder="Search by name, hospital, or email"
              value={query}
              onChange={e => setQuery(e.target.value)}
              hint="Only active, verified providers can be found here."
            />

            {searching && <p style={{ fontSize: 13, color: '#6b7280' }}>Searching...</p>}

            {!searching && query.trim().length >= 2 && results.length === 0 && (
              <>
                <p style={{ fontSize: 13, color: '#9ca3af' }}>No matching providers found.</p>
                <p style={{ fontSize: 13, color: '#6b7280' }}>Invite this provider to HID by email.</p>
              </>
            )}

            {results.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                {results.map(result => (
                  <button
                    key={result.staff_account_id}
                    type="button"
                    onClick={() => setSelected(result)}
                    style={{
                      textAlign: 'left',
                      borderRadius: 12,
                      border: '1px solid #edf1f5',
                      background: '#fff',
                      padding: '10px 14px',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{result.full_name}</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>
                      {result.hospital_name ?? 'Independent practitioner'} · {result.role}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : inviteMode ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>Invite a provider who isn't on HID yet.</span>
              <button
                type="button"
                onClick={() => setInviteMode(false)}
                disabled={saving}
                style={{ border: 'none', background: 'none', color: '#1a6fd4', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 12, padding: 0, flexShrink: 0 }}
              >
                Back to search
              </button>
            </div>

            <Input
              label="Provider email"
              placeholder="provider@example.com"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
            />

            <Input
              label="Provider name (optional)"
              placeholder="e.g. Dr. Jane Doe"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
            />

            <Select
              label="Access level"
              value={permissionTier}
              onChange={e => setPermissionTier(e.target.value as HidSharePermissionTier)}
              options={SHARE_PERMISSION_TIERS.map(tier => ({ value: tier.value, label: tier.label }))}
            />
            <p style={{ fontSize: 12, color: '#6b7280', marginTop: -8 }}>
              {SHARE_PERMISSION_TIERS.find(tier => tier.value === permissionTier)?.description}
            </p>

            <Select
              label="Duration"
              value={durationPreset}
              onChange={e => setDurationPreset(e.target.value as HidShareDurationPreset)}
              options={SHARE_DURATION_PRESETS}
            />

            <Textarea
              label="Reason (optional)"
              placeholder="e.g. Ongoing care with this provider"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </>
        ) : selected ? (
          <>
            <div style={{ border: '1px solid #edf1f5', borderRadius: 12, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{selected.full_name}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{selected.hospital_name ?? 'Independent practitioner'} · {selected.role}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                disabled={saving}
                style={{ border: 'none', background: 'none', color: '#1a6fd4', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 12, padding: 0, flexShrink: 0 }}
              >
                Change
              </button>
            </div>

            <Select
              label="Access level"
              value={permissionTier}
              onChange={e => setPermissionTier(e.target.value as HidSharePermissionTier)}
              options={SHARE_PERMISSION_TIERS.map(tier => ({ value: tier.value, label: tier.label }))}
            />
            <p style={{ fontSize: 12, color: '#6b7280', marginTop: -8 }}>
              {SHARE_PERMISSION_TIERS.find(tier => tier.value === permissionTier)?.description}
            </p>

            <Select
              label="Duration"
              value={durationPreset}
              onChange={e => setDurationPreset(e.target.value as HidShareDurationPreset)}
              options={SHARE_DURATION_PRESETS}
            />

            <Textarea
              label="Reason (optional)"
              placeholder="e.g. Ongoing care with this provider"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 4 }}>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
          {(selected || inviteMode) && (
            <Button loading={saving} onClick={() => void handleSubmit()}>{inviteMode ? 'Send invite' : 'Share profile'}</Button>
          )}
          {!selected && !inviteMode && !searching && query.trim().length >= 2 && results.length === 0 && (
            <Button onClick={openInviteMode}>Invite by email</Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
