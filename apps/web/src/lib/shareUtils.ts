import type { BadgeColor } from '../components/ui'
import type { HidShareDurationPreset, HidSharePermissionTier } from '../types/hid'

export interface SharePermissionTierOption {
  value: HidSharePermissionTier
  label: string
  description: string
}

export const SHARE_PERMISSION_TIERS: SharePermissionTierOption[] = [
  { value: 'view_only', label: 'View Only', description: 'Can view your profile and records, but cannot make changes.' },
  { value: 'clinical_review', label: 'Clinical Review', description: 'Can view your profile and records for clinical review.' },
  { value: 'clinical_collaboration', label: 'Clinical Collaboration', description: 'Can view and add to your records.' },
]

export interface ShareDurationOption {
  value: HidShareDurationPreset
  label: string
}

export const SHARE_DURATION_PRESETS: ShareDurationOption[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'until_revoked', label: 'Until revoked' },
]

export function getSharePermissionTierLabel(tier: HidSharePermissionTier | null): string {
  return SHARE_PERMISSION_TIERS.find(option => option.value === tier)?.label ?? 'Standard'
}

export function getShareDurationLabel(preset: HidShareDurationPreset | null): string {
  return SHARE_DURATION_PRESETS.find(option => option.value === preset)?.label ?? ''
}

export function getSharePermissionTierBadge(tier: HidSharePermissionTier | null): BadgeColor {
  switch (tier) {
    case 'clinical_collaboration':
      return 'green'
    case 'clinical_review':
      return 'amber'
    case 'view_only':
      return 'blue'
    default:
      return 'gray'
  }
}
