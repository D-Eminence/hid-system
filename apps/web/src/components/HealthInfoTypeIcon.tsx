import React from 'react'

export function getHealthInfoTypeIcon(typeId: string | undefined | null, size = 18): React.ReactNode {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const

  switch (typeId) {
    case 'condition':
      return (
        <svg {...props}>
          <path d="M3 12h4l2-5 4 10 2-5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'lab_result':
      return (
        <svg {...props}>
          <path d="M9 2h6M10 2v6.5l-4.3 7.6A2 2 0 0 0 7.4 19h9.2a2 2 0 0 0 1.7-2.9L14 8.5V2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 14h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'medication':
      return (
        <svg {...props}>
          <rect x="2.5" y="9" width="19" height="6" rx="3" transform="rotate(45 12 12)" stroke="currentColor" strokeWidth="1.8" />
          <path d="M9.5 14.5l5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'allergy':
      return (
        <svg {...props}>
          <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 8v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="16" r="1" fill="currentColor" />
        </svg>
      )
    case 'vaccination':
      return (
        <svg {...props}>
          <path d="M18 2l4 4-2 2-4-4 2-2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M17 5 7 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M5 17l-2 4 4-2 7-7-2-2-7 7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M10 9l2 2M12.5 6.5l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )
    case 'procedure':
      return (
        <svg {...props}>
          <path d="M4 20 14 10l3 3L7 23Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M14 10l6-6 2 2-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'hospital_visit':
      return (
        <svg {...props}>
          <rect x="4" y="4" width="16" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
          <path d="M12 8v6M9 11h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M9 21v-3h6v3" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      )
    case 'document':
      return (
        <svg {...props}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M12 17v-5M9.5 14.5 12 12l2.5 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'voice_note':
      return (
        <svg {...props}>
          <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )
  }
}
