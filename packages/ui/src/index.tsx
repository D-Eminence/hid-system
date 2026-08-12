import React, { useEffect, useRef, useState } from 'react'

// ── Button ──────────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline'
type BtnSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: BtnSize
  loading?: boolean
  icon?: React.ReactNode
  fullWidth?: boolean
}

const btnStyles: Record<BtnVariant, React.CSSProperties> = {
  primary: { background: 'var(--color-brand-primary)', color: 'var(--color-surface)', border: 'none' },
  secondary: { background: 'var(--color-brand-primary-soft)', color: 'var(--color-brand-primary)', border: 'none' },
  danger: { background: 'var(--color-error)', color: 'var(--color-surface)', border: 'none' },
  ghost: { background: 'transparent', color: 'var(--color-text-muted)', border: 'none' },
  outline: { background: 'transparent', color: 'var(--color-brand-primary)', border: '1.5px solid var(--color-brand-primary)' },
}
const sizeStyles: Record<BtnSize, React.CSSProperties> = {
  sm: { padding: 'var(--space-2) var(--space-3)', fontSize: 'var(--font-size-xs)', borderRadius: 'var(--radius-sm)', minHeight: 36 },
  md: { padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--font-size-sm)', borderRadius: 'var(--radius-md)', minHeight: 'var(--control-height)' },
  lg: { padding: 'var(--space-3) var(--space-6)', fontSize: 'var(--font-size-md)', borderRadius: 'var(--radius-md)', minHeight: 48 },
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  fullWidth,
  children,
  disabled,
  style,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onBlur,
  ...rest
}: ButtonProps) {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
    fontWeight: 600, cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.6 : 1,
    transition: 'transform var(--transition-fast), opacity var(--transition-fast), filter var(--transition-fast), box-shadow var(--transition-fast)',
    width: fullWidth ? '100%' : undefined, justifyContent: 'center',
    whiteSpace: 'nowrap',
    touchAction: 'manipulation',
    transform: 'scale(1)',
    filter: 'none',
  }
  return (
    <button
      disabled={disabled || loading}
      style={{ ...base, ...btnStyles[variant], ...sizeStyles[size], ...style }}
      onPointerDown={event => {
        if (!disabled && !loading) {
          event.currentTarget.style.transform = 'scale(0.985)'
          event.currentTarget.style.filter = 'brightness(0.97)'
        }
        onPointerDown?.(event)
      }}
      onPointerUp={event => {
        event.currentTarget.style.transform = 'scale(1)'
        event.currentTarget.style.filter = 'none'
        onPointerUp?.(event)
      }}
      onPointerLeave={event => {
        event.currentTarget.style.transform = 'scale(1)'
        event.currentTarget.style.filter = 'none'
        onPointerLeave?.(event)
      }}
      onBlur={event => {
        event.currentTarget.style.transform = 'scale(1)'
        event.currentTarget.style.filter = 'none'
        onBlur?.(event)
      }}
      {...rest}
    >
      {loading ? <Spinner size={14} color={variant === 'primary' || variant === 'danger' ? 'var(--color-surface)' : 'var(--color-brand-primary)'} /> : icon}
      {children}
    </button>
  )
}

// ── Input ───────────────────────────────────────────────────────────────────
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  icon?: React.ReactNode
  allowReveal?: boolean
}

export function Input({
  label,
  error,
  hint,
  icon,
  style,
  type,
  onFocus,
  onBlur,
  allowReveal = true,
  disabled,
  ...rest
}: InputProps) {
  const [revealed, setRevealed] = useState(false)
  const isPasswordField = type === 'password' && allowReveal
  const resolvedType = isPasswordField ? (revealed ? 'text' : 'password') : type
  const leftPadding = icon ? 38 : 12
  const rightPadding = isPasswordField ? 44 : 12

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {label && (
        <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)' }}>{label}</label>
      )}
      <div style={{ position: 'relative' }}>
        {icon && (
          <span style={{
            position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--color-text-disabled)', display: 'flex', alignItems: 'center', pointerEvents: 'none'
          }}>{icon}</span>
        )}
        <input
          type={resolvedType}
          disabled={disabled}
          style={{
            width: '100%',
            height: 'var(--control-height)',
            padding: `0 ${rightPadding}px 0 ${leftPadding}px`,
            border: `1.5px solid ${error ? 'var(--color-error)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-size-md)',
            color: 'var(--color-text-primary)',
            background: 'var(--color-surface)',
            outline: 'none',
            transition: 'border-color var(--transition-fast)',
            boxSizing: 'border-box',
            ...style
          }}
          onFocus={e => {
            e.currentTarget.style.borderColor = error ? 'var(--color-error)' : 'var(--color-brand-primary)'
            onFocus?.(e)
          }}
          onBlur={e => {
            e.currentTarget.style.borderColor = error ? 'var(--color-error)' : 'var(--color-border)'
            onBlur?.(e)
          }}
          {...rest}
        />
        {isPasswordField && (
          <button
            type="button"
            disabled={disabled}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            onClick={() => setRevealed((value: boolean) => !value)}
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              padding: 0,
            }}
          >
            {revealed ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M10.7 10.9a2.1 2.1 0 0 0 2.4 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 8.9 4 10 7c-.5 1.5-1.6 3.2-3.3 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6.2 6.2C4.2 7.7 2.8 9.8 2 12c1.1 3 4.8 7 10 7c1 0 1.9-.1 2.8-.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M2 12c1.1-3 4.8-7 10-7s8.9 4 10 7c-1.1 3-4.8 7-10 7s-8.9-4-10-7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            )}
          </button>
        )}
      </div>
      {error && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error)' }}>{error}</p>}
      {hint && !error && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-disabled)' }}>{hint}</p>}
    </div>
  )
}

// ── Select ──────────────────────────────────────────────────────────────────
interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: { value: string; label: string }[]
  placeholder?: string
}

export function Select({ label, error, options, placeholder = 'Select...', style, ...rest }: SelectProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {label && <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)' }}>{label}</label>}
      <div style={{ position: 'relative' }}>
        <select style={{
          width: '100%', height: 'var(--control-height)', padding: '0 36px 0 var(--space-3)',
          border: `1.5px solid ${error ? 'var(--color-error)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-md)', fontSize: 'var(--font-size-md)', color: 'var(--color-text-primary)', background: 'var(--color-surface)',
          appearance: 'none', outline: 'none', cursor: 'pointer', boxSizing: 'border-box', ...style
        }}
          onFocus={e => e.currentTarget.style.borderColor = 'var(--color-brand-primary)'}
          onBlur={e => e.currentTarget.style.borderColor = error ? 'var(--color-error)' : 'var(--color-border)'}
          {...rest}
        >
          <option value="">{placeholder}</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span style={{
          position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
          pointerEvents: 'none', color: 'var(--color-text-disabled)'
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </div>
      {error && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error)' }}>{error}</p>}
    </div>
  )
}

// ── Textarea ─────────────────────────────────────────────────────────────────
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}
export function Textarea({ label, error, style, ...rest }: TextareaProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {label && <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)' }}>{label}</label>}
      <textarea style={{
        width: '100%', padding: '10px 12px', minHeight: 96,
        border: `1.5px solid ${error ? 'var(--color-error)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-md)', fontSize: 'var(--font-size-md)', color: 'var(--color-text-primary)', background: 'var(--color-surface)',
        outline: 'none', resize: 'vertical', lineHeight: 'var(--line-height-longform)', boxSizing: 'border-box', ...style
      }}
        onFocus={e => e.currentTarget.style.borderColor = 'var(--color-brand-primary)'}
        onBlur={e => e.currentTarget.style.borderColor = error ? 'var(--color-error)' : 'var(--color-border)'}
        {...rest}
      />
      {error && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error)' }}>{error}</p>}
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────
interface CardProps {
  children: React.ReactNode
  style?: React.CSSProperties
  padding?: number | string
  onClick?: () => void
}
export function Card({ children, style, padding = 24, onClick }: CardProps) {
  const resolvedPadding = typeof padding === 'number' ? `clamp(12px, 3.5vw, ${padding}px)` : padding
  return (
    <div onClick={onClick} style={{
      background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)',
      padding: resolvedPadding, boxShadow: 'var(--elevation-subtle)',
      cursor: onClick ? 'pointer' : undefined,
      transition: onClick ? 'box-shadow var(--transition-fast)' : undefined,
      minWidth: 0,
      ...style
    }}>
      {children}
    </div>
  )
}

// ── Badge ─────────────────────────────────────────────────────────────────────
export type BadgeColor = 'blue' | 'green' | 'red' | 'amber' | 'gray'
export const badgeMap: Record<BadgeColor, { bg: string; text: string }> = {
  blue:  { bg: 'var(--color-info-soft)', text: 'var(--color-brand-primary-strong)' },
  green: { bg: 'var(--color-success-soft)', text: 'var(--color-success)' },
  red:   { bg: 'var(--color-error-soft)', text: 'var(--color-error)' },
  amber: { bg: 'var(--color-warning-soft)', text: 'var(--color-warning)' },
  gray:  { bg: 'var(--color-background)', text: 'var(--color-text-secondary)' },
}
export function Badge({ children, color = 'gray' }: { children: React.ReactNode; color?: BadgeColor }) {
  const { bg, text } = badgeMap[color]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: bg, color: text, fontSize: 11, fontWeight: 600,
      padding: '3px 9px', borderRadius: 'var(--radius-full)'
    }}>{children}</span>
  )
}

// ── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 20, color = 'var(--color-brand-primary)' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }}
    >
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="2.5" strokeDasharray="40" strokeDashoffset="10" strokeLinecap="round" opacity="0.25"/>
      <path d="M12 2a10 10 0 0110 10" stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  )
}

export function PageLoader({ label = 'Loading your page...' }: { label?: string }) {
  return (
    <div style={{ minHeight: '42vh', padding: 32, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-5)', borderRadius: 'var(--radius-full)', background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', fontWeight: 600, boxShadow: 'var(--elevation-subtle)' }}>
        <Spinner size={16} />
        {label}
      </div>
    </div>
  )
}

// ── Empty State ───────────────────────────────────────────────────────────────
export function EmptyState({ icon, title, description, action }: {
  icon: React.ReactNode; title: string; description?: string; action?: React.ReactNode
}) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div style={{ color: 'var(--color-border)', marginBottom: 'var(--space-1)' }}>{icon}</div>
      <p style={{ fontWeight: 600, fontSize: 'var(--font-size-md)', color: 'var(--color-text-secondary)' }}>{title}</p>
      {description && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-disabled)', maxWidth: 320 }}>{description}</p>}
      {action}
    </div>
  )
}

// ── Section Header ────────────────────────────────────────────────────────────
export function SectionHeader({ title, subtitle, action }: {
  title: string; subtitle?: string; action?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'clamp(14px, 4vw, 20px)', gap: 16, flexWrap: 'wrap', rowGap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 'clamp(var(--font-size-md), 3.5vw, var(--font-size-lg))', fontWeight: 600, letterSpacing: 'var(--tracking-heading)' }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 480 }: {
  open: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: number
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--color-overlay)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 'var(--z-modal)', padding: 'clamp(10px, 4vw, 24px)'
    }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', width: '100%', maxWidth: width,
        boxShadow: 'var(--elevation-modal)', animation: 'modalIn var(--transition-standard)', maxHeight: 'calc(100vh - 48px)', overflow: 'hidden'
      }}>
        <style>{`@keyframes modalIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}`}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', padding: 'clamp(var(--space-3), 4vw, var(--space-5)) clamp(var(--space-4), 4vw, var(--space-6))', borderBottom: '1px solid var(--color-border)' }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-disabled)', minWidth: 'var(--touch-target)', minHeight: 'var(--touch-target)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div style={{ padding: 'clamp(16px, 4vw, 24px)', overflowY: 'auto', overflowX: 'hidden', maxHeight: 'calc(100vh - 132px)' }}>{children}</div>
      </div>
    </div>
  )
}

// ── Bottom Sheet ──────────────────────────────────────────────────────────────
export function BottomSheet({ open, onClose, title, onBack, step, totalSteps, footer, children }: {
  open: boolean; onClose: () => void; title: string; onBack?: () => void
  step?: number; totalSteps?: number; footer?: React.ReactNode; children: React.ReactNode
}) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number } | null>(null)
  const [isCompact, setIsCompact] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 720 : true))

  useEffect(() => {
    const handleResize = () => setIsCompact(window.innerWidth < 720)
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  if (!open) return null

  function handlePointerDown(event: React.PointerEvent) {
    dragRef.current = { startY: event.clientY }
    if (sheetRef.current) sheetRef.current.style.transition = 'none'
  }
  function handlePointerMove(event: React.PointerEvent) {
    if (!dragRef.current || !sheetRef.current) return
    const delta = Math.max(0, event.clientY - dragRef.current.startY)
    sheetRef.current.style.transform = `translateY(${delta}px)`
  }
  function handlePointerUp(event: React.PointerEvent) {
    if (!dragRef.current || !sheetRef.current) return
    const delta = event.clientY - dragRef.current.startY
    dragRef.current = null
    if (delta > 80) {
      onClose()
    } else {
      sheetRef.current.style.transition = 'transform 0.2s ease'
      sheetRef.current.style.transform = ''
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 'var(--z-modal)',
        display: 'flex',
        alignItems: isCompact ? 'flex-end' : 'stretch',
        justifyContent: isCompact ? 'center' : 'flex-end',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={sheetRef}
        style={isCompact ? {
          background: 'var(--color-surface)', width: '100%', maxWidth: 560,
          borderRadius: '20px 20px 0 0', height: '65vh', maxHeight: '65vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--elevation-sheet)',
          animation: 'sheetIn 0.25s ease', transition: 'transform 0.2s ease',
        } : {
          background: 'var(--color-surface)', width: 'min(420px, 100%)', height: '100vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--elevation-drawer)',
          animation: 'drawerIn 0.25s ease',
        }}
      >
        <style>{`@keyframes sheetIn{from{transform:translateY(100%)}to{transform:translateY(0)}}@keyframes drawerIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
        {isCompact ? (
          <div
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ padding: 'clamp(10px, 3vw, 14px) clamp(16px, 4vw, 24px) 14px', cursor: 'grab', touchAction: 'none', flexShrink: 0 }}
          >
            <div style={{ width: 40, height: 4, borderRadius: 'var(--radius-full)', background: 'var(--color-border)', margin: '0 auto var(--space-3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {onBack && (
                <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', minWidth: 'var(--touch-target)', minHeight: 'var(--touch-target)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              )}
              <h3 style={{ fontSize: 16, fontWeight: 700, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</h3>
              <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--color-text-disabled)', minWidth: 'var(--touch-target)', minHeight: 'var(--touch-target)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </button>
            </div>
            {step !== undefined && totalSteps !== undefined && totalSteps > 1 && (
              <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
                {Array.from({ length: totalSteps }).map((_, index) => (
                  <span key={index} style={{ flex: 1, height: 3, borderRadius: 'var(--radius-full)', background: index <= step ? 'var(--color-brand-primary)' : 'var(--color-border)' }} />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 'var(--space-5) var(--space-6)', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {onBack && (
                <button onClick={onBack} aria-label="Back" style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', minWidth: 'var(--touch-target)', minHeight: 'var(--touch-target)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12 4l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              )}
              <h3 style={{ fontSize: 16, fontWeight: 700, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{title}</h3>
              <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--color-text-disabled)', minWidth: 'var(--touch-target)', minHeight: 'var(--touch-target)', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
              </button>
            </div>
            {step !== undefined && totalSteps !== undefined && totalSteps > 1 && (
              <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
                {Array.from({ length: totalSteps }).map((_, index) => (
                  <span key={index} style={{ flex: 1, height: 3, borderRadius: 'var(--radius-full)', background: index <= step ? 'var(--color-brand-primary)' : 'var(--color-border)' }} />
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ padding: isCompact ? '0 clamp(16px, 4vw, 24px) clamp(16px, 4vw, 24px)' : '0 24px 24px', overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <div style={{ borderTop: '1px solid var(--color-border)', padding: 'clamp(var(--space-3), 4vw, var(--space-5)) clamp(var(--space-4), 4vw, var(--space-6))', display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', flexShrink: 0 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Chips ─────────────────────────────────────────────────────────────────────
export function Chip({ active, onClick, children, disabled }: {
  active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${active ? 'var(--color-brand-primary)' : 'var(--color-border)'}`,
        borderRadius: 999,
        padding: '6px 14px',
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? 'var(--color-brand-primary-soft)' : 'var(--color-surface)',
        color: active ? 'var(--color-brand-primary)' : 'var(--color-text-secondary)',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

export function ChipGroup({ options, value, onChange }: {
  options: { value: string; label: string }[]; value: string; onChange: (value: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {options.map(option => (
        <Chip key={option.value} active={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </Chip>
      ))}
    </div>
  )
}

// ── Selection Cards ───────────────────────────────────────────────────────────
export function SelectionCard({ label, description, icon, active, onClick }: {
  label: string; description?: string; icon?: React.ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        border: `1.5px solid ${active ? 'var(--color-brand-primary)' : 'var(--color-border)'}`,
        background: active ? 'var(--color-brand-primary-soft)' : 'var(--color-surface)',
        borderRadius: 12,
        padding: 14,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      {icon && <span style={{ color: active ? 'var(--color-brand-primary)' : 'var(--color-text-muted)' }}>{icon}</span>}
      <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-primary)' }}>{label}</span>
      {description && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>{description}</span>}
    </button>
  )
}

export function SelectionCardGrid({ options, value, onChange }: {
  options: { value: string; label: string; description?: string; icon?: React.ReactNode }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
      {options.map(option => (
        <SelectionCard
          key={option.value}
          label={option.label}
          description={option.description}
          icon={option.icon}
          active={value === option.value}
          onClick={() => onChange(option.value)}
        />
      ))}
    </div>
  )
}
