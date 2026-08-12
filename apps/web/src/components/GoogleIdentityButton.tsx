import React, { useEffect, useRef, useState } from 'react'
import {
  renderGoogleIdentityButton,
  type GoogleIdentityButtonText,
  type GoogleIdentitySelection,
} from '../lib/googleIdentity'

type GoogleIdentityButtonProps = {
  disabled?: boolean
  onIdentity: (selection: GoogleIdentitySelection) => void | Promise<void>
  text: GoogleIdentityButtonText
}

export function GoogleIdentityButton({ disabled = false, onIdentity, text }: GoogleIdentityButtonProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onIdentityRef = useRef(onIdentity)
  const [errorMessage, setErrorMessage] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    onIdentityRef.current = onIdentity
  }, [onIdentity])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let active = true
    let lastWidth = 0
    let resizeTimer = 0

    const render = async () => {
      const width = Math.max(100, Math.min(400, Math.floor(host.getBoundingClientRect().width)))
      lastWidth = width
      try {
        await renderGoogleIdentityButton(host, {
          onError: error => {
            if (active) setErrorMessage(error.message)
          },
          onIdentity: identity => {
            if (active) void onIdentityRef.current(identity)
          },
          text,
          width,
        })
        if (active) setErrorMessage('')
      } catch (error) {
        if (active) {
          setErrorMessage(error instanceof Error ? error.message : 'Unable to load Google sign-in right now.')
        }
      }
    }

    void render()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          const nextWidth = Math.max(100, Math.min(400, Math.floor(host.getBoundingClientRect().width)))
          if (Math.abs(nextWidth - lastWidth) < 2) return
          window.clearTimeout(resizeTimer)
          resizeTimer = window.setTimeout(() => { void render() }, 100)
        })
    observer?.observe(host)

    return () => {
      active = false
      observer?.disconnect()
      window.clearTimeout(resizeTimer)
      host.replaceChildren()
    }
  }, [retryKey, text])

  return (
    <div style={{ marginTop: 12 }}>
      <div
        aria-disabled={disabled}
        ref={hostRef}
        style={{
          margin: '0 auto',
          minHeight: 44,
          maxWidth: 400,
          opacity: disabled ? 0.62 : 1,
          overflow: 'hidden',
          pointerEvents: disabled ? 'none' : 'auto',
          width: '100%',
        }}
      />
      {errorMessage ? (
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <div role="alert" style={{ color: '#b42318', fontSize: 11, lineHeight: 1.5 }}>{errorMessage}</div>
          <button
            type="button"
            onClick={() => {
              setErrorMessage('')
              setRetryKey(current => current + 1)
            }}
            style={{ marginTop: 6, border: 'none', background: 'none', color: '#1f8cff', fontSize: 11, fontWeight: 600 }}
          >
            Retry Google sign-in
          </button>
        </div>
      ) : null}
    </div>
  )
}
