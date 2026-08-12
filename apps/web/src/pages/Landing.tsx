import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import folderPreviewImage from '../../lp/B.png'
import { HIDLogo } from '../components/HIDLogo'
import { LegalDocumentsModal } from '../components/LegalDocumentsModal'
import { PROVIDER_ACCESS_HREF } from '../lib/providerAccess'
import { preloadRoute, preloadRoutesWhenIdle } from '../lib/routePreload'

type FooterLink = {
  label: string
  href?: string
  onClick?: () => void
}

type SecurityCardKind =
  | 'controlled-access'
  | 'consent-sharing'
  | 'secure-cloud'
  | 'encryption'
  | 'verified-identity'
  | 'compliance'

type EcosystemKind = 'identity' | 'ehr' | 'lab' | 'pharmacy' | 'outreach'

const sectionPadding = '80px clamp(20px, 5vw, 48px)'
const landingTrustBadges = ['HIPAA + NDPC aligned', 'End-to-end encrypted', 'Built for African healthcare'] as const
const SUPPORT_EMAIL = 'support@healthidentitydirectory.com'
const DEMO_HREF = `mailto:${SUPPORT_EMAIL}?subject=Book a Demo`
const HOSPITAL_AUTH_HREF = PROVIDER_ACCESS_HREF

const footerLinkStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  color: '#6b7280',
  marginBottom: 10,
  background: 'none',
  border: 'none',
  padding: 0,
  textAlign: 'left',
  cursor: 'pointer',
}

function FooterLinkItem({ link }: { link: FooterLink }) {
  if (link.onClick) {
    return (
      <button type="button" onClick={link.onClick} style={footerLinkStyle}>
        {link.label}
      </button>
    )
  }

  return (
    <a href={link.href} style={footerLinkStyle}>
      {link.label}
    </a>
  )
}

function SocialIconLink({
  href,
  label,
  children,
}: {
  href: string
  label: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        border: '1px solid #d7deea',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#4b5563',
        transition: 'all 0.2s ease',
        background: '#fff',
      }}
      onMouseEnter={event => {
        event.currentTarget.style.color = '#1a6fd4'
        event.currentTarget.style.borderColor = '#1a6fd4'
      }}
      onMouseLeave={event => {
        event.currentTarget.style.color = '#4b5563'
        event.currentTarget.style.borderColor = '#d7deea'
      }}
    >
      {children}
    </a>
  )
}

function EcosystemIcon({ kind }: { kind: EcosystemKind }) {
  if (kind === 'identity') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="9" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M5.8 16c.4-1.6 1.7-2.5 3.2-2.5s2.8.9 3.2 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M14.5 10h4M14.5 13h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'ehr') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="3.5" width="14" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 3.5v2.5h6V3.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M12 10v5M9.5 12.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'lab') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M10 3.5h4M10.5 3.5v6L6.5 17a2 2 0 0 0 1.8 3h7.4a2 2 0 0 0 1.8-3l-4-7.5v-6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M8.2 14h7.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'pharmacy') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3.5" y="8.5" width="11" height="11" rx="3" transform="rotate(-45 3.5 8.5)" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 7l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M6.5 17.5l2-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function SecurityCardIcon({
  kind,
}: {
  kind: SecurityCardKind
}) {
  if (kind === 'controlled-access') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="5" y="10" width="14" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 10V7.5A4 4 0 0 1 12 3.5A4 4 0 0 1 16 7.5V10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="12" cy="14.5" r="1.2" fill="currentColor" />
      </svg>
    )
  }

  if (kind === 'consent-sharing') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.5 13.5L4.5 10.5A2.5 2.5 0 1 1 8 7l1.5 1.5L11 10l1.5-1.5L14 7a2.5 2.5 0 1 1 3.5 3.5l-5.5 5.5-2.5-2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 14h6M16 11v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'secure-cloud') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.5 18.5h9a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 6.45 9.2A3.8 3.8 0 0 0 7.5 18.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 10.5v7M9.5 15l2.5 2.5L14.5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (kind === 'encryption') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3.5L5.5 6v5.8c0 4.1 2.6 7.8 6.5 8.9c3.9-1.1 6.5-4.8 6.5-8.9V6L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M9.5 12.5l1.7 1.7l3.3-3.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (kind === 'verified-identity') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M6.5 18.5a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M17 9.5l1.4 1.4L21 8.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5L5.5 6v5.8c0 4.1 2.6 7.8 6.5 8.9c3.9-1.1 6.5-4.8 6.5-8.9V6L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 11.8l2 2l4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 16.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

type CtaVariant = 'primary' | 'secondary' | 'white' | 'outlineWhite'

function ctaLook(variant: CtaVariant): React.CSSProperties {
  switch (variant) {
    case 'secondary':
      return { background: '#fff', color: '#1a6fd4', border: '1.5px solid #1a6fd4' }
    case 'white':
      return { background: '#fff', color: '#1a6fd4', border: '1.5px solid #fff' }
    case 'outlineWhite':
      return { background: 'transparent', color: '#fff', border: '1.5px solid rgba(255,255,255,0.55)' }
    default:
      return { background: '#1a6fd4', color: '#fff', border: '1.5px solid #1a6fd4' }
  }
}

function ctaHoverLook(variant: CtaVariant): React.CSSProperties {
  switch (variant) {
    case 'secondary':
      return { background: '#e8f1fc', color: '#1a6fd4', borderColor: '#1a6fd4' }
    case 'white':
      return { filter: 'brightness(0.96)' }
    case 'outlineWhite':
      return { background: 'rgba(255,255,255,0.1)' }
    default:
      return { filter: 'brightness(0.94)' }
  }
}

function ctaActiveLook(variant: CtaVariant): React.CSSProperties {
  switch (variant) {
    case 'secondary':
      return { background: '#dbeafe', color: '#1254a8', borderColor: '#1254a8' }
    case 'white':
      return { filter: 'brightness(0.92)' }
    case 'outlineWhite':
      return { background: 'rgba(255,255,255,0.18)' }
    default:
      return { filter: 'brightness(0.88)' }
  }
}

function Cta({
  variant = 'primary',
  size = 'md',
  href,
  onClick,
  onMouseEnter,
  onFocus,
  fullWidth,
  children,
}: {
  variant?: CtaVariant
  size?: 'sm' | 'md'
  href?: string
  onClick?: () => void
  onMouseEnter?: () => void
  onFocus?: () => void
  fullWidth?: boolean
  children: React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pressed, setPressed] = useState(false)
  const sizing: React.CSSProperties = size === 'sm'
    ? { padding: '10px 22px', fontSize: 14 }
    : { padding: '14px 28px', fontSize: 15 }
  const style: React.CSSProperties = {
    borderRadius: 999,
    fontWeight: 700,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    lineHeight: 1,
    boxSizing: 'border-box',
    width: fullWidth ? '100%' : undefined,
    transition: 'filter 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
    ...sizing,
    ...ctaLook(variant),
    ...(hovered ? ctaHoverLook(variant) : null),
    ...(pressed ? ctaActiveLook(variant) : null),
    ...(focused ? { outline: 'none', boxShadow: '0 0 0 3px rgba(26,111,212,0.22)' } : null),
  }
  const handleEnter = () => {
    setHovered(true)
    onMouseEnter?.()
  }
  const handleLeave = () => {
    setHovered(false)
    setPressed(false)
  }
  const handleFocus = () => {
    setHovered(true)
    setFocused(true)
    onFocus?.()
  }
  const handleBlur = () => {
    setHovered(false)
    setFocused(false)
    setPressed(false)
  }
  const handlePress = () => setPressed(true)
  const handleRelease = () => setPressed(false)
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') setPressed(true)
  }
  const handleKeyUp = () => setPressed(false)

  if (href) {
    return (
      <a href={href} onClick={onClick} onMouseEnter={handleEnter} onMouseLeave={handleLeave} onMouseDown={handlePress} onMouseUp={handleRelease} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onFocus={handleFocus} onBlur={handleBlur} style={style}>
        {children}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} onMouseEnter={handleEnter} onMouseLeave={handleLeave} onMouseDown={handlePress} onMouseUp={handleRelease} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onFocus={handleFocus} onBlur={handleBlur} style={style}>
      {children}
    </button>
  )
}

function OpsImage({ src, alt, label }: { src: string; alt: string; label: string }) {
  const [errored, setErrored] = useState(false)
  if (errored) {
    return (
      <div style={{ width: '100%', minHeight: 180, borderRadius: 10, border: '1px dashed #bfdbfe', background: '#fff', boxShadow: '0 18px 38px rgba(15,23,42,0.06)', padding: '36px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#1a6fd4', textAlign: 'center' }}>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="8.5" r="3.2" stroke="currentColor" strokeWidth="1.7" />
          <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M16.5 4.5l1.5 1.5 3-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}>Preview coming soon</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setErrored(true)}
      style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 10, border: '1px solid #e5e7eb', boxShadow: '0 18px 38px rgba(15,23,42,0.06)' }}
    />
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const [openFaq, setOpenFaq] = useState<number | null>(null)
  const [legalOpen, setLegalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [productsOpen, setProductsOpen] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1024))

  const faqs = [
    { q: 'What is HID?', a: 'HID (Health Identity Directory) is a connected healthcare infrastructure platform. At its center is a secure digital health identity that links patients to the hospitals, laboratories, pharmacies, and outreach programs that care for them.' },
    { q: 'What can I do with my HID?', a: 'Your HID gives you a single, secure health identity. With it, participating hospitals and clinics can access your verified medical history, prescriptions, and lab results, so your care continues seamlessly wherever you go.' },
    { q: 'Is my data safe?', a: 'Yes. All data is encrypted in transit and at rest, stored on secure cloud infrastructure, and governed by strict consent controls. Only verified providers you authorise can access your records.' },
    { q: 'Can any hospital access my records?', a: 'Only hospitals and clinicians in the HID network, and only with the appropriate access. Within the network, your records follow your HID, ensuring continuity of care anywhere.' },
    { q: 'Who is HID for?', a: 'HID serves patients, hospitals, laboratories, pharmacies, and outreach programs. Patients get a unified health identity; providers get connected EHR, lab, pharmacy, and outreach tools built around it.' },
    { q: 'How do healthcare providers partner with HID?', a: `Hospitals, labs, pharmacies, and outreach organisations can join the HID network to access EHR, diagnostics, dispensing, and outreach tools. Reach out at ${SUPPORT_EMAIL} to get started.` },
  ]

  const challenges = [
    'Fragmented patient records',
    'Disconnected healthcare systems',
    'Repeated tests and procedures',
    'Delayed access to critical information',
    'Poor continuity of care',
    'Limited visibility across providers',
  ]

  const ecosystem: Array<{ icon: EcosystemKind; title: string; desc: string }> = [
    { icon: 'identity', title: 'Digital Health Identity', desc: 'A unique, secure health ID that lets patients access their information and follows them across every participating provider.' },
    { icon: 'ehr', title: 'HID EHR', desc: 'Electronic medical records and clinical workflow management that help providers deliver connected, efficient care.' },
    { icon: 'lab', title: 'HID Lab', desc: 'Laboratory operations, diagnostics management, and fast, reliable result reporting.' },
    { icon: 'pharmacy', title: 'HID Pharmacy', desc: 'Prescription management, dispensing workflows, and real-time inventory across branches.' },
    { icon: 'outreach', title: 'HID Outreach', desc: 'Tools to run medical outreaches, community health programs, and population health initiatives.' },
    { icon: 'ehr', title: 'HID Migrate', desc: 'Digitize physical folders with scanning, OCR, AI-assisted extraction, human validation, and patient matching.' },
    { icon: 'identity', title: 'HID API', desc: 'Connect existing EHRs, laboratory systems, pharmacies, HMOs, and external health applications.' },
  ]

  const operationsScreens: Array<{ src: string; tag: string; title: string; desc: string; flip: boolean }> = [
    {
      src: '/screenshots/dashboard-hospital.png',
      tag: 'Hospital Management',
      title: 'Clinical Dashboards Built for the Front Line',
      desc: 'Clinicians see their day at a glance, patients in queue, results to review, pending sign-offs, and start a consultation in one click.',
      flip: false,
    },
    {
      src: '/screenshots/dashboard-lab.png',
      tag: 'Laboratory Operations',
      title: 'From Sample to Verified Result',
      desc: 'Labs of every size run the full diagnostic pipeline, registration, collection, processing, verification, and release, with critical-result alerts built in.',
      flip: true,
    },
    {
      src: '/screenshots/dashboard-pharmacy.png',
      tag: 'Pharmacy Operations',
      title: 'Pharmacy and Inventory, Across Every Branch',
      desc: 'Owners track revenue, margin, and stock in real time across all branches, with reorder and top-product insights at a glance.',
      flip: false,
    },
    {
      src: '/screenshots/dashboard-outreach.png',
      tag: 'Medical Outreach',
      title: 'Community Health, Coordinated in the Field',
      desc: 'Run medical outreaches and community health programs, register encounters, capture consent, and sync records back to each patient identity.',
      flip: true,
    },
  ]

  const outcomes = [
    { title: 'Improve patient outcomes', desc: 'Complete histories mean faster, safer, better-informed clinical decisions.' },
    { title: 'Strengthen healthcare delivery', desc: 'Connected providers reduce duplication, delays, and gaps in care.' },
    { title: 'Support healthcare programs', desc: 'Outreach and public health initiatives reach the right people with the right data.' },
    { title: 'Improve healthcare planning', desc: 'Aggregated, privacy-protected trends help systems plan capacity and resources.' },
    { title: 'Enable responsible research', desc: 'Connected data, governed by consent, can support ethical medical research.' },
  ]

  const securityCards: Array<{ icon: SecurityCardKind; title: string; desc: string }> = [
    { icon: 'controlled-access', title: 'Controlled Access', desc: 'Only verified medical professionals can access or update a patient health information.' },
    { icon: 'consent-sharing', title: 'Consent-Based Sharing', desc: 'Patients approve when and where their data can be accessed, keeping control in the right hands.' },
    { icon: 'secure-cloud', title: 'Secure Cloud Infrastructure', desc: 'Reliable, monitored, redundant systems that ensure uptime, stability, and continuous protection.' },
    { icon: 'encryption', title: 'End-to-End Encryption', desc: 'Records are encrypted at rest and in transit, unreadable to anyone except authorized hospitals.' },
    { icon: 'verified-identity', title: 'Verified Identity Protection', desc: 'Each HID is linked to a unique patient record, reducing duplicates, fraud, and identity mix-ups.' },
    { icon: 'compliance', title: 'Compliance Standards', desc: 'Built with healthcare privacy and auditability in mind.' },
  ]

  const footerGroups: Array<{ head: string; links: FooterLink[] }> = [
    {
      head: 'Ecosystem',
      links: [
        { label: 'Digital Health Identity', href: '#ecosystem' },
        { label: 'HID EHR', href: '#ecosystem' },
        { label: 'HID Lab', href: '#ecosystem' },
        { label: 'HID Pharmacy', href: '#ecosystem' },
        { label: 'HID Outreach', href: '#ecosystem' },
      ],
    },
    {
      head: 'Access',
      links: [
        { label: 'Patient Portal', onClick: () => navigate('/patient') },
        { label: 'Hospital / Provider Access', href: HOSPITAL_AUTH_HREF },
        { label: 'Book a Demo', href: DEMO_HREF },
        { label: 'FAQs', href: '#faq' },
      ],
    },
    {
      head: 'Legal',
      links: [
        { label: 'Privacy Policy', onClick: () => setLegalOpen(true) },
        { label: 'Terms of Service', onClick: () => setLegalOpen(true) },
      ],
    },
  ]

  const isNarrow = viewportWidth < 640
  const isCompact = viewportWidth < 820
  const responsiveSectionPadding = isNarrow ? '56px 18px' : sectionPadding
  const stackedGridColumns = isNarrow ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))'

  const navLinks = [
    { label: 'Why HID', href: '#why-hid' },
    { label: 'Ecosystem', href: '#ecosystem' },
    { label: 'How it Works', href: '#how-it-works' },
    { label: 'Security', href: '#security' },
  ]
  const productLinks = [
    { label: 'HID Identity', description: 'One persistent patient identity.', href: '/products/identity' },
    { label: 'HID EHR', description: 'Modular hospital operations.', href: '/products/ehr' },
    { label: 'HID Laboratory', description: 'Complete diagnostic workflows.', href: '/products/laboratory' },
    { label: 'HID Pharmacy', description: 'Stock, dispensing, and sales.', href: '/products/pharmacy' },
    { label: 'HID Migrate', description: 'Digitize legacy patient folders.', href: '/products/migrate' },
    { label: 'HID Outreach', description: 'Connected care in the field.', href: '/products/outreach' },
  ]

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!isCompact && menuOpen) setMenuOpen(false)
  }, [isCompact, menuOpen])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  useEffect(() => preloadRoutesWhenIdle(['patientAuth', 'doctorAuth', 'adminLogin']), [])

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, sans-serif", color: '#111827', background: '#fff' }}>
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: isNarrow ? '12px 16px' : '12px clamp(16px, 4vw, 48px)',
          minHeight: 64,
          gap: 16,
        }}
      >
        <HIDLogo size="sm" />

        {!isCompact && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(16px, 4vw, 32px)' }}>
            <div
              style={{ position: 'relative' }}
              onMouseEnter={() => setProductsOpen(true)}
              onMouseLeave={() => setProductsOpen(false)}
            >
              <button
                type="button"
                aria-expanded={productsOpen}
                onClick={() => setProductsOpen(open => !open)}
                style={{ border: 'none', background: 'transparent', fontSize: 14, fontWeight: 500, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '10px 0' }}
              >
                Products <span aria-hidden="true" style={{ fontSize: 10 }}>▾</span>
              </button>
              {productsOpen && (
                <div style={{ position: 'absolute', top: '100%', left: -16, width: 330, padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-md)', display: 'grid', gap: 2 }}>
                  {productLinks.map(product => (
                    <a key={product.label} href={product.href} style={{ display: 'grid', gap: 2, padding: '10px 12px', borderRadius: 'var(--r-md)', color: 'var(--text)' }}>
                      <strong style={{ fontSize: 13 }}>{product.label}</strong>
                      <span style={{ color: 'var(--t3)', fontSize: 12 }}>{product.description}</span>
                    </a>
                  ))}
                  <a href="/products" style={{ marginTop: 4, padding: '10px 12px', borderTop: '1px solid var(--border)', color: 'var(--blue)', fontSize: 12, fontWeight: 700 }}>View all products →</a>
                </div>
              )}
            </div>
            {navLinks.map(link => (
              <a
                key={link.label}
                href={link.href}
                style={{ fontSize: 14, fontWeight: 500, color: '#6b7280', transition: 'color 0.15s' }}
                onMouseEnter={event => {
                  event.currentTarget.style.color = '#111827'
                }}
                onMouseLeave={event => {
                  event.currentTarget.style.color = '#6b7280'
                }}
              >
                {link.label}
              </a>
            ))}
          </div>
        )}

        {!isCompact && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Cta
              variant="secondary"
              size="sm"
              href={HOSPITAL_AUTH_HREF}
              onMouseEnter={() => preloadRoute('doctorAuth')}
              onFocus={() => preloadRoute('doctorAuth')}
            >
              Hospital / Provider Access
            </Cta>
          </div>
        )}

        {isCompact && (
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 10, width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#111827', cursor: 'pointer' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </nav>

      {isCompact && menuOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 200, display: 'flex', flexDirection: 'column', padding: isNarrow ? '12px 16px 24px' : '12px clamp(16px, 4vw, 48px) 24px', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 42 }}>
            <HIDLogo size="sm" />
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 10, width: 42, height: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#111827', cursor: 'pointer' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 14 }}>
            <button
              type="button"
              onClick={() => setProductsOpen(open => !open)}
              aria-expanded={productsOpen}
              style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', background: 'transparent', border: 'none', textAlign: 'left', padding: '16px 6px', borderBottom: '1px solid var(--bg)' }}
            >
              Products <span aria-hidden="true">{productsOpen ? '▴' : '▾'}</span>
            </button>
            {productsOpen && <div style={{ display: 'grid', padding: '6px 0 10px 14px', borderBottom: '1px solid var(--bg)' }}>{productLinks.map(product => <a key={product.label} href={product.href} onClick={() => setMenuOpen(false)} style={{ padding: '10px 6px', color: 'var(--t2)', fontSize: 14, fontWeight: 600 }}>{product.label}</a>)}</div>}
            {navLinks.map(link => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                style={{ fontSize: 16, fontWeight: 600, color: '#111827', textDecoration: 'none', padding: '16px 6px', borderBottom: '1px solid #f3f4f6' }}
              >
                {link.label}
              </a>
            ))}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 24 }}>
            <Cta variant="primary" size="md" fullWidth onClick={() => { setMenuOpen(false); navigate('/patient') }}>
              Get Your HID
            </Cta>
            <Cta variant="secondary" size="md" fullWidth href={DEMO_HREF} onClick={() => setMenuOpen(false)}>
              Book a Demo
            </Cta>
            <Cta
              variant="secondary"
              size="md"
              fullWidth
              href={HOSPITAL_AUTH_HREF}
              onClick={() => setMenuOpen(false)}
              onMouseEnter={() => preloadRoute('doctorAuth')}
              onFocus={() => preloadRoute('doctorAuth')}
            >
              Hospital / Provider Access
            </Cta>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 960, margin: '0 auto', padding: isNarrow ? '42px 16px 56px' : '72px clamp(20px, 5vw, 24px) 80px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: isNarrow ? 18 : 24,
            padding: isNarrow ? '34px 18px 26px' : '48px clamp(20px, 5vw, 40px) 36px',
            width: '100%',
            maxWidth: 580,
            boxShadow: '0 4px 32px rgba(0,0,0,0.06)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#e8f1fc', color: '#1a6fd4', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 999, marginBottom: 18 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a6fd4', display: 'inline-block' }} />
            Connected Healthcare Infrastructure
          </span>
          <h1 className="hid-hero-title" style={{ fontWeight: 800, lineHeight: 1.15, letterSpacing: isNarrow ? 0 : '-0.8px', marginBottom: 14 }}>
            <span style={{ display: 'block' }}>Health Identity Directory</span>
            <span className="hid-hero-tagline" style={{ display: 'block', color: '#1a6fd4' }}>One Identity. Connected Records. Better Care.</span>
          </h1>
          <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7, marginBottom: 28, maxWidth: 420, margin: '0 auto 28px' }}>
            Health Identity Directory (HID) is building the digital infrastructure for connected healthcare by providing every patient with a secure, lifelong Health ID that enables seamless and secure access to medical records, empowering patients and helping healthcare providers deliver faster, safer, and more coordinated care.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 18 }}>
            <Cta
              variant="primary"
              size="md"
              fullWidth
              onClick={() => navigate('/patient')}
              onMouseEnter={() => preloadRoute('patientAuth')}
              onFocus={() => preloadRoute('patientAuth')}
            >
              Get Your HID
            </Cta>
            <Cta variant="secondary" size="md" fullWidth href={DEMO_HREF}>
              Book a Demo
            </Cta>
          </div>

          <div style={{ background: '#f3f4f6', borderRadius: 14, padding: 'clamp(16px, 4vw, 24px)', marginTop: 28, width: '100%' }}>
            <img
              src={folderPreviewImage}
              alt="HID patient folder preview"
              style={{ display: 'block', width: '100%', maxWidth: 420, height: 'auto', margin: '0 auto' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            {landingTrustBadges.map(text => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
                <div style={{ width: 16, height: 16, background: '#1a6fd4', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M1.5 4.5l2 2L7.5 2" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>

      <section style={{ padding: responsiveSectionPadding, background: '#f8fbff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 34 }}>
            <div style={{ color: '#1a6fd4', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>One connected ecosystem</div>
            <h2 style={{ fontSize: isNarrow ? 25 : 34, fontWeight: 800, letterSpacing: '-.04em', margin: '10px 0' }}>One ecosystem. Built for healthcare.</h2>
            <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7, maxWidth: 680, margin: '0 auto' }}>Use HID as a complete hospital operating environment, activate individual standalone products, or connect the healthcare software you already use.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: stackedGridColumns, gap: 14 }}>
            {[
              ['HID EHR Core', 'The modular core subscription for hospital clinical and operational workflows.', '/products/ehr'],
              ['Add only what you need', 'Laboratory, Pharmacy, Migrate, HMO & Claims, and Analytics can extend HID EHR.', '/configure-ehr'],
              ['Standalone or connected', 'Laboratories, pharmacies, outreach teams, migration projects, and existing systems can join independently.', '/products'],
            ].map(([title, description, href]) => <a key={title} href={href} style={{ background: '#fff', border: '1px solid #e1e8f0', borderRadius: 16, padding: 22, color: '#111827', textDecoration: 'none', boxShadow: '0 8px 24px rgba(15,23,42,.04)' }}><h3 style={{ margin: 0 }}>{title}</h3><p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>{description}</p><span style={{ color: '#1a6fd4', fontWeight: 700, fontSize: 13 }}>Explore →</span></a>)}
          </div>
        </div>
      </section>

      <section style={{ padding: responsiveSectionPadding, background: '#0f2742', color: '#fff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0,1fr) minmax(300px,.8fr)', gap: 36, alignItems: 'center' }}>
          <div><div style={{ color: '#82b9f5', fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.08em' }}>HID Migrate</div><h2 style={{ fontSize: isNarrow ? 25 : 36, lineHeight: 1.15, letterSpacing: '-.04em' }}>Your old records don&apos;t have to stay on paper.</h2><p style={{ color: '#c8d6e6', lineHeight: 1.7 }}>Move years of patient records into a structured digital healthcare system without starting from zero.</p><a href="/products/migrate" style={{ display: 'inline-flex', background: '#fff', color: '#1a6fd4', padding: '11px 17px', borderRadius: 10, fontWeight: 700, textDecoration: 'none' }}>Digitize Your Records</a></div>
          <div style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 18, padding: 24, lineHeight: 2, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>Paper Folder<br/>↓ Scan<br/>↓ OCR & AI Extraction<br/>↓ Human Validation<br/>↓ Patient Matching<br/>↓ Digital Patient Folder</div>
        </div>
      </section>

      <section id="why-hid" style={{ padding: responsiveSectionPadding, background: '#f8f9fb' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: isNarrow ? 32 : 48 }}>
            <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px', maxWidth: 620, margin: '0 auto' }}>
              Healthcare Is Disconnected. We&apos;re Building the Infrastructure to Connect It.
            </h2>
            <p style={{ fontSize: 14, color: '#6b7280', marginTop: 12, lineHeight: 1.7, maxWidth: 520, margin: '12px auto 0' }}>
              Across hospitals, labs, and pharmacies, patient information lives in silos, and that fragmentation costs time, money, and lives.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
            {challenges.map(text => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: '#f3f4f6', color: '#6b7280', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M3.5 7h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                </span>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#4b5563' }}>{text}</span>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', fontSize: 15, color: '#1a6fd4', fontWeight: 600, lineHeight: 1.7, maxWidth: 560, margin: '32px auto 0' }}>
            HID is the connective layer, a shared health identity that links every part of the care journey.
          </p>
        </div>
      </section>

      <section id="ecosystem" style={{ padding: responsiveSectionPadding, background: '#fff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: isNarrow ? 32 : 48 }}>
            <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px' }}>
              Building the Infrastructure for <span style={{ color: '#1a6fd4' }}>Connected Healthcare</span>
            </h2>
            <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, lineHeight: 1.7, maxWidth: 520, margin: '10px auto 0' }}>
              Five connected solutions, one health identity at the center.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
            {ecosystem.map(({ icon, title, desc }) => (
              <div key={title} style={{ border: '1px solid #e5e7eb', borderRadius: 16, padding: '26px 22px' }}>
                <div style={{ width: 46, height: 46, borderRadius: 12, background: '#e8f1fc', color: '#1a6fd4', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                  <EcosystemIcon kind={icon} />
                </div>
                <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{title}</h3>
                <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="operations" style={{ padding: responsiveSectionPadding, background: '#f8f9fb' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: isNarrow ? 32 : 48 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#e8f1fc', color: '#1a6fd4', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 999, marginBottom: 14 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a6fd4', display: 'inline-block' }} />
              Live in production
            </span>
            <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px' }}>Already Powering Real Healthcare Operations</h2>
            <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, lineHeight: 1.7, maxWidth: 540, margin: '10px auto 0' }}>
              HID isn&apos;t a concept, it&apos;s live software running hospital, laboratory, pharmacy, and outreach workflows today.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {operationsScreens.map(({ src, tag, title, desc, flip }) => (
              <div
                key={tag}
                style={{
                  border: '1px solid #e5e7eb',
                  borderRadius: 20,
                  overflow: 'hidden',
                  display: 'grid',
                  gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1.25fr) minmax(0, 1fr)',
                  background: '#fff',
                  direction: !isNarrow && flip ? 'rtl' : 'ltr',
                }}
              >
                <div style={{ background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isNarrow ? 18 : 28, direction: 'ltr' }}>
                  <OpsImage src={src} alt={`${tag} dashboard preview`} label={tag} />
                </div>
                <div style={{ padding: isNarrow ? '26px 22px 30px' : '40px 36px', display: 'flex', flexDirection: 'column', justifyContent: 'center', direction: 'ltr' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', background: '#e8f1fc', color: '#1a6fd4', fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 999, marginBottom: 14, width: 'fit-content' }}>{tag}</span>
                  <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 12 }}>{title}</h3>
                  <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>{desc}</p>
                  <div style={{ marginTop: 20 }}>
                    <Cta variant="secondary" size="sm" href={DEMO_HREF}>Book a Demo</Cta>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', fontSize: 13, color: '#9ca3af', marginTop: 24 }}>
            All four run on the same connected platform, with EHR woven through every workflow.
          </p>
        </div>
      </section>

      <section id="features" style={{ padding: responsiveSectionPadding, background: '#fff', maxWidth: 960, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: isNarrow ? 32 : 48 }}>
          <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px' }}>
            <span style={{ color: '#1a6fd4' }}>Built With Purpose:</span> One Platform, Every Side of Care
          </h2>
          <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, lineHeight: 1.7, maxWidth: 520, margin: '10px auto 0' }}>
            HID brings patients and healthcare providers onto one secure platform, centralizing records, simplifying care, and ensuring every decision is informed and connected.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {[
            { tag: 'For Patients', title: 'Your Entire Health Story, In One Secure Place', desc: 'A simple, unified patient profile stores medical history, prescriptions, lab results, and emergencies, so the right information is available when it matters.', flip: false },
            { tag: 'For Providers', title: 'Connected Tools for Hospitals, Labs & Pharmacies', desc: 'Providers retrieve verified patient records in seconds, update files in real time, and deliver faster, safer care without duplicate tests or missing details.', flip: true },
          ].map(({ tag, title, desc, flip }) => (
            <div
              key={tag}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 20,
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: stackedGridColumns,
                direction: !isNarrow && flip ? 'rtl' : 'ltr',
              }}
            >
              <div style={{ background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isNarrow ? 26 : 40, minHeight: isNarrow ? 170 : 220, direction: 'ltr' }}>
                <svg width={isNarrow ? 136 : 160} height={isNarrow ? 120 : 140} viewBox="0 0 160 140" fill="none">
                  {flip ? (
                    <>
                      <rect x="20" y="20" width="90" height="100" rx="4" fill="#dbeafe" stroke="#bfdbfe" strokeWidth="1.5" />
                      <rect x="30" y="10" width="70" height="16" rx="3" fill="#93c5fd" />
                      <rect x="48" y="20" width="18" height="5" rx="2.5" fill="white" />
                      <rect x="55" y="14" width="6" height="17" rx="3" fill="white" />
                      {[36, 52, 68, 84].map((y, index) => (
                        <rect key={index} x="30" y={y} width={[40, 28, 32, 40][index]} height="6" rx="3" fill="white" opacity="0.7" />
                      ))}
                      <rect x="90" y="68" width="58" height="44" rx="6" fill="white" stroke="#bfdbfe" strokeWidth="1" />
                      <rect x="99" y="78" width="32" height="5" rx="2.5" fill="#bfdbfe" />
                      <rect x="99" y="88" width="24" height="5" rx="2.5" fill="#dbeafe" />
                      <rect x="99" y="98" width="28" height="5" rx="2.5" fill="#dbeafe" />
                      <text x="120" y="77" textAnchor="middle" fontSize="6" fill="#1a6fd4" fontFamily="Inter,sans-serif">Patient Info</text>
                    </>
                  ) : (
                    <>
                      <rect x="15" y="18" width="100" height="104" rx="8" fill="#e8f1fc" stroke="#bfdbfe" strokeWidth="1.5" />
                      <rect x="50" y="10" width="30" height="14" rx="5" fill="#93c5fd" />
                      <rect x="56" y="12" width="18" height="10" rx="3" fill="#1a6fd4" />
                      <rect x="28" y="38" width="74" height="6" rx="3" fill="#bfdbfe" />
                      {[50, 62, 74, 86].map((y, index) => (
                        <rect key={index} x="28" y={y} width={[58, 44, 52, 36][index]} height="6" rx="3" fill="#dbeafe" />
                      ))}
                      <circle cx="122" cy="50" r="20" fill="#1a6fd4" />
                      <path d="M115 50h14M122 43v14" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                    </>
                  )}
                </svg>
              </div>
              <div style={{ padding: isNarrow ? '26px 22px 30px' : '40px 36px', display: 'flex', flexDirection: 'column', justifyContent: 'center', direction: 'ltr' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', background: '#e8f1fc', color: '#1a6fd4', fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 999, marginBottom: 14, width: 'fit-content' }}>{tag}</span>
                <h3 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px', marginBottom: 12 }}>{title}</h3>
                <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="how-it-works" style={{ padding: responsiveSectionPadding, background: '#f8f9fb' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: isNarrow ? 34 : 52 }}>
            <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px' }}>How HID Works</h2>
            <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, lineHeight: 1.7 }}>Four steps that show exactly how HID connects you and your healthcare providers without stress or paperwork.</p>
          </div>
          {[
            { n: '01', title: 'Create Your HID Profile', desc: 'Patient sign up creates the account and issues a unique Health ID for future lookups and updates.' },
            { n: '02', title: 'Connect Your Health Records', desc: 'Hospitals, labs, and pharmacies link records to the HID. Visit notes, prescriptions, and lab results all attach to one identity.' },
            { n: '03', title: 'Access Anywhere', desc: 'Patients use their HID at any provider in the network. Records are instantly accessible to authorized medical staff across the country.' },
            { n: '04', title: 'Providers Pull Your Data', desc: 'Medical staff retrieve the complete patient file instantly. No paperwork, no delays, and no duplicate onboarding flow.' },
          ].map(({ n, title, desc }, index) => (
            <div
              key={n}
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 20,
                overflow: 'hidden',
                display: 'grid',
                gridTemplateColumns: stackedGridColumns,
                marginBottom: 20,
                background: '#fff',
                direction: !isNarrow && index % 2 === 1 ? 'rtl' : 'ltr',
              }}
            >
              <div style={{ background: '#e8f1fc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: isNarrow ? 24 : 32, minHeight: isNarrow ? 132 : 160, position: 'relative', direction: 'ltr' }}>
                <span style={{ position: 'absolute', top: 16, left: 20, fontSize: isNarrow ? 38 : 48, fontWeight: 800, color: 'rgba(26,111,212,0.12)', lineHeight: 1 }}>{n}</span>
                <div style={{ width: 80, height: 56, background: 'white', borderRadius: 10, border: '1px solid #bfdbfe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="48" height="36" viewBox="0 0 48 36" fill="none">
                    <rect x="2" y="2" width="44" height="32" rx="4" fill="#f3f4f6" stroke="#e5e7eb" strokeWidth="1" />
                    <rect x="8" y="8" width="20" height="4" rx="2" fill="#bfdbfe" />
                    <rect x="8" y="15" width="32" height="3" rx="1.5" fill="#dbeafe" />
                    <rect x="8" y="21" width="24" height="3" rx="1.5" fill="#dbeafe" />
                    <rect x="30" y="24" width="14" height="6" rx="3" fill="#1a6fd4" />
                    <text x="37" y="29" textAnchor="middle" fontSize="4" fill="white" fontFamily="Inter,sans-serif">Go</text>
                  </svg>
                </div>
              </div>
              <div style={{ padding: isNarrow ? '26px 22px 30px' : '36px 40px', display: 'flex', flexDirection: 'column', justifyContent: 'center', direction: 'ltr' }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{title}</h3>
                <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="better-data" style={{ padding: responsiveSectionPadding, background: '#fff' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: isNarrow ? 32 : 48 }}>
            <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px' }}>Better Data. <span style={{ color: '#1a6fd4' }}>Better Decisions.</span></h2>
            <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, lineHeight: 1.7, maxWidth: 520, margin: '10px auto 0' }}>
              When healthcare information is connected, everyone makes better calls.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
            {outcomes.map(({ title, desc }) => (
              <div key={title} style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: '22px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{ width: 24, height: 24, borderRadius: '50%', background: '#e8f1fc', color: '#1a6fd4', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.2l2.6 2.6L10 3.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  <h4 style={{ fontSize: 14, fontWeight: 700 }}>{title}</h4>
                </div>
                <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{desc}</p>
              </div>
            ))}
          </div>
          <p style={{ textAlign: 'center', fontSize: 13, color: '#9ca3af', lineHeight: 1.7, maxWidth: 600, margin: '28px auto 0' }}>
            Aggregated, privacy-protected insights can support public health planning and responsible research, an outcome of connected systems, never at the expense of patient trust.
          </p>
        </div>
      </section>

      <section id="security" style={{ padding: responsiveSectionPadding, background: '#f8f9fb' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: isNarrow ? 26 : 36, flexWrap: 'wrap', gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: isNarrow ? 24 : 28, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px', maxWidth: 420 }}>Security & Compliance</h2>
              <p style={{ fontSize: 14, color: '#6b7280', marginTop: 10, maxWidth: 400, lineHeight: 1.7 }}>
                From a single patient record to an entire hospital network, HID is built with enterprise-grade protection, strict consent controls, and healthcare compliance at every layer, keeping every record secure, encrypted, and under the patient&apos;s control.
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', width: isNarrow ? '100%' : 'auto' }}>
              <button onClick={() => navigate('/patient')} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#1a6fd4', background: 'none', border: 'none', cursor: 'pointer' }}>
                Patient Portal <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <a href={HOSPITAL_AUTH_HREF} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#1a6fd4' }}>
                Hospital / Provider Access <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8M7 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </a>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18 }}>
            {securityCards.map(({ icon, title, desc }) => (
              <div key={title} style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: '24px 20px', background: '#fff' }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: '#e8f1fc', color: '#1a6fd4', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                  <SecurityCardIcon kind={icon} />
                </div>
                <h4 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{title}</h4>
                <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ padding: responsiveSectionPadding, background: '#fff' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: '#e8f1fc', color: '#1a6fd4', fontSize: 12, fontWeight: 600, padding: '5px 14px', borderRadius: 999, marginBottom: 18 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#1a6fd4', display: 'inline-block' }} />
            Our Vision
          </span>
          <h2 style={{ fontSize: isNarrow ? 26 : 32, fontWeight: 800, color: '#111827', letterSpacing: isNarrow ? 0 : '-0.6px', lineHeight: 1.2, marginBottom: 16, maxWidth: 600, margin: '0 auto 16px' }}>
            Building the Future of <span style={{ color: '#1a6fd4' }}>Connected Healthcare</span>
          </h2>
          <p style={{ fontSize: 15, color: '#6b7280', maxWidth: 620, margin: '0 auto', lineHeight: 1.8 }}>
            Our vision is a healthcare ecosystem where patients, providers, laboratories, pharmacies, and health programs can access the information they need to deliver better care, make better decisions, and improve health outcomes across Africa.
          </p>
        </div>
      </section>

      <div style={{ background: 'linear-gradient(135deg, #1a6fd4 0%, #1254a8 100%)', padding: isNarrow ? '58px 18px' : '80px clamp(20px, 5vw, 48px)', textAlign: 'center' }}>
        <h2 style={{ fontSize: isNarrow ? 26 : 32, fontWeight: 800, color: 'white', letterSpacing: isNarrow ? 0 : '-0.6px', lineHeight: 1.2, marginBottom: 16, maxWidth: 560, margin: '0 auto 16px' }}>
          Get Your HID Today and Take Control of Your Health Records
        </h2>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.75)', marginBottom: 28, maxWidth: 460, margin: '0 auto 28px', lineHeight: 1.7 }}>
          Patients manage their profile and health records. Hospitals, labs, and pharmacies join the network to deliver connected care.
        </p>
        <div style={{ display: isNarrow ? 'grid' : 'inline-flex', gap: 12, justifyContent: 'center', width: isNarrow ? '100%' : 'auto' }}>
          <Cta
            variant="white"
            size="md"
            fullWidth={isNarrow}
            onClick={() => navigate('/patient')}
            onMouseEnter={() => preloadRoute('patientAuth')}
            onFocus={() => preloadRoute('patientAuth')}
          >
            Get Your HID
          </Cta>
          <Cta variant="outlineWhite" size="md" fullWidth={isNarrow} href={DEMO_HREF}>
            Book a Demo
          </Cta>
        </div>
      </div>

      <section id="faq" style={{ padding: responsiveSectionPadding, background: '#fff' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))', gap: isNarrow ? 20 : 32 }}>
          <div>
            <h2 style={{ fontSize: isNarrow ? 26 : 32, fontWeight: 800, letterSpacing: isNarrow ? 0 : '-0.5px', marginBottom: 12 }}>FAQ</h2>
            <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>Everything you need to know about HID, from setup and security to connecting providers and accessing health records anywhere.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {faqs.map(({ q, a }, index) => (
              <div key={index} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <button
                  onClick={() => setOpenFaq(openFaq === index ? null : index)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '20px 0',
                    cursor: 'pointer',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    gap: 16,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    fontWeight: 500,
                    color: '#111827',
                  }}
                >
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{q}</span>
                  <span style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#6b7280', transition: 'all 0.2s', background: openFaq === index ? '#1a6fd4' : 'transparent', borderColor: openFaq === index ? '#1a6fd4' : '#e5e7eb' }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: openFaq === index ? 'rotate(45deg)' : 'none', transition: 'transform 0.2s' }}>
                      <path d="M5 2v6M2 5h6" stroke={openFaq === index ? 'white' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </span>
                </button>
                {openFaq === index && <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.7, paddingBottom: 20 }}>{a}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer style={{ background: '#f8f9fb', padding: isNarrow ? '44px 18px 0' : '56px clamp(20px, 5vw, 48px) 0' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? '1fr' : 'repeat(auto-fit, minmax(180px, 1fr))', gap: isNarrow ? 24 : 32, paddingBottom: 40, borderBottom: '1px solid #e5e7eb' }}>
            <div>
              <HIDLogo size="sm" />
              <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.7, marginTop: 14, maxWidth: 260 }}>
                Connected healthcare infrastructure, built around a unified health identity that links patients, hospitals, labs, pharmacies, and outreach programs.
              </p>
              <div style={{ display: 'grid', gap: 6, marginTop: 14 }}>
                <a href={`mailto:${SUPPORT_EMAIL}`} style={{ fontSize: 13, color: '#6b7280' }}>{SUPPORT_EMAIL}</a>
                <a href="tel:+2347026717252" style={{ fontSize: 13, color: '#6b7280' }}>+2347026717252</a>
              </div>
            </div>
            {footerGroups.map(({ head, links }) => (
              <div key={head}>
                <h5 style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{head}</h5>
                {links.map(link => (
                  <FooterLinkItem key={link.label} link={link} />
                ))}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: isNarrow ? 'center' : 'space-between', padding: '20px 0', gap: 16, flexWrap: 'wrap', textAlign: isNarrow ? 'center' : 'left' }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <SocialIconLink href="https://www.instagram.com/hidirectoryhq" label="Instagram">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="12" cy="12" r="4.1" stroke="currentColor" strokeWidth="1.8" />
                  <circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" />
                </svg>
              </SocialIconLink>
              <SocialIconLink href="https://x.com/hidirectoryhq" label="X">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 4h4.2l4.1 5.6L17.1 4H20l-6.4 7.2L20 20h-4.2l-4.4-6L6.1 20H4l6.5-7.4L4 4z" fill="currentColor" />
                </svg>
              </SocialIconLink>
              <SocialIconLink href="https://www.linkedin.com/company/hid-health-ng/" label="LinkedIn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6.4 9.2V19" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  <path d="M11 19V9.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  <path d="M11 12.4c0-1.8 1.5-3.2 3.3-3.2 1.9 0 3.3 1.4 3.3 3.8V19" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="6.4" cy="5.8" r="1.4" fill="currentColor" />
                </svg>
              </SocialIconLink>
              <SocialIconLink href="https://vm.tiktok.com/ZS98v2n48uHRt-ua2WD/" label="TikTok">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M14.2 4.5c.8 1.8 2.1 3 3.8 3.4v2.8c-1.4 0-2.7-.4-3.8-1.2v4.7a4.8 4.8 0 1 1-4.8-4.8c.4 0 .8.1 1.2.2v3c-.4-.2-.8-.3-1.2-.3a1.9 1.9 0 1 0 1.9 1.9V4.5h2.9z" fill="currentColor" />
                </svg>
              </SocialIconLink>
              <SocialIconLink href="https://www.facebook.com/share/14ZGb6gZXUR/" label="Facebook">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M13.6 20v-7h2.4l.4-2.8h-2.8V8.4c0-.8.2-1.4 1.4-1.4H16V4.5c-.2 0-.9-.1-1.7-.1-2.6 0-4.2 1.5-4.2 4.4v1.4H7.8V13H10v7h3.6z" fill="currentColor" />
                </svg>
              </SocialIconLink>
            </div>
            <p style={{ fontSize: 12, color: '#9ca3af' }}>Copyright 2026 HID Technologies. All rights reserved.</p>
          </div>
        </div>
        <div style={{ textAlign: 'center', padding: '24px 0 32px', fontSize: 'clamp(28px, 6vw, 64px)', fontWeight: 800, color: 'rgba(26,111,212,0.08)', letterSpacing: '-1px', userSelect: 'none', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          HEALTH IDENTITY DIRECTORY
        </div>
      </footer>
      <LegalDocumentsModal open={legalOpen} onClose={() => setLegalOpen(false)} />
    </div>
  )
}
