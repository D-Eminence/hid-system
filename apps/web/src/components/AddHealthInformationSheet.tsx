import React from 'react'
import { badgeMap, BottomSheet } from './ui'
import { getHealthInfoTypeIcon } from './HealthInfoTypeIcon'
import { HEALTH_INFO_TYPES, type HealthInfoTypeConfig } from '../lib/medicalRecordUtils'

interface AddHealthInformationSheetProps {
  open: boolean
  onClose: () => void
  onSelectType: (type: HealthInfoTypeConfig) => void
}

export function AddHealthInformationSheet({ open, onClose, onSelectType }: AddHealthInformationSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Add Health Information">
      <p style={{ color: '#6b7280', fontSize: 13, marginTop: -4, marginBottom: 14 }}>
        Choose the type of health information you want to add to your record.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {HEALTH_INFO_TYPES.map(type => {
          const colors = badgeMap[type.accent]
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => onSelectType(type)}
              style={{
                textAlign: 'left',
                borderRadius: 14,
                border: '1px solid #edf1f5',
                background: '#fff',
                padding: '12px 14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: colors.bg,
                  color: colors.text,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {getHealthInfoTypeIcon(type.id)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{type.label}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{type.description}</div>
              </span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: '#c7ccd4' }} aria-hidden="true">
                <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )
        })}
      </div>
    </BottomSheet>
  )
}
