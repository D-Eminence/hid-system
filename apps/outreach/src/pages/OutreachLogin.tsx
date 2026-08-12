import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Layout } from '@hid/ui/Layout'
import { Button, Card, Input } from '@hid/ui'
import { loginOutreachWorker } from '../lib/outreachApi'
import { OUTREACH_PATH } from '../lib/outreachRoutes'
import { Turnstile } from '@hid/ui/Turnstile'

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 14px' }}>
      <span style={{ fontSize: 15, lineHeight: 1, marginTop: 1, flexShrink: 0 }}>⚠</span>
      <p style={{ margin: 0, color: '#b91c1c', fontSize: 13, lineHeight: 1.55 }}>{message}</p>
    </div>
  )
}

export default function OutreachLogin() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) { setError('Please enter your email address.'); return }
    if (!password) { setError('Please enter your password.'); return }
    setError(null)
    setSubmitting(true)

    try {
      await loginOutreachWorker(email.trim().toLowerCase(), password, turnstileToken ?? undefined)
      navigate(OUTREACH_PATH, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please check your details and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Layout title="Outreach" subtitle="Sign in to your workspace">
      <div style={{ maxWidth: 420, margin: '0 auto' }}>
        <Card style={{ padding: 32 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>Sign in</h2>
          <p style={{ margin: '0 0 24px', color: '#6b7280', fontSize: 14 }}>
            Use the Identity account provisioned by your facility administrator.
          </p>

          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 16 }}>
            <Input
              label="Email address"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(null) }}
            />
            <Input
              label="Password"
              type="password"
              placeholder="Your password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(null) }}
            />

            {error && <ErrorBox message={error} />}

            <Turnstile action="outreach-login" onTokenChange={setTurnstileToken} />

            <Button type="submit" variant="primary" loading={submitting}>Sign in</Button>
          </form>
        </Card>

        <p style={{ marginTop: 16, textAlign: 'center', fontSize: 13, color: '#6b7280' }}>
          Self-signup and public invite codes are not supported.
        </p>
      </div>
    </Layout>
  )
}
