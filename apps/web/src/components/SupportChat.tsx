import { useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { canonicalRequest } from '../lib/identityClient'

type Reply = { sessionId: string; messages: string[] }
type Message = { from: 'you' | 'support'; text: string }

export function SupportChat() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [sessionId, setSessionId] = useState<string>()
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const supportContact = import.meta.env.VITE_SUPPORT_CONTACT as string | undefined

  if (/^\/(patient\/(profile|biodata|records|history|notifications)|hospital\/(dashboard|access|history|emergency|patient-records)|migrate|eminence|ehr|admin)(\/|$)/.test(pathname)) return null

  async function send(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    setDraft('')
    setMessages(previous => [...previous.slice(-39), { from: 'you', text }])
    try {
      const reply = await canonicalRequest<Reply>('/api/v1/support/chat', {
        method: 'POST', body: JSON.stringify({ text, sessionId }),
      })
      setSessionId(reply.sessionId)
      setMessages(previous => [...previous.slice(-39), ...reply.messages.map(message => ({ from: 'support' as const, text: message }))])
    } catch {
      setError('Support chat is unavailable. Please try again later.')
    } finally {
      setBusy(false)
    }
  }

  return <aside style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 50, maxWidth: 'calc(100vw - 40px)' }}>
    {open && <section aria-label="Health Identity support chat" style={{ width: 340, maxWidth: '100%', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 12, padding: 16, boxShadow: '0 12px 32px #0f172a33', marginBottom: 8 }}>
      <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>Support chat</h2>
      <p style={{ fontSize: 13, margin: '0 0 12px' }}>For help using Health Identity. Do not share medical details here.</p>
      <div role="log" aria-live="polite" style={{ maxHeight: 240, overflowY: 'auto' }}>
        {messages.map((message, index) => <p key={index} style={{ fontSize: 14 }}><strong>{message.from === 'you' ? 'You' : 'Support'}:</strong> {message.text}</p>)}
      </div>
      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}{supportContact && <> <a href={supportContact}>Contact support</a>.</>}</p>}
      <form onSubmit={event => void send(event)}>
        <label htmlFor="support-chat-message">Your question</label>
        <input id="support-chat-message" value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} required style={{ width: '100%', margin: '8px 0', padding: 8 }} />
        <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
    </section>}
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} style={{ borderRadius: 24, padding: '10px 16px', background: '#1458a8', color: '#fff', border: 0 }}>
      {open ? 'Close support' : 'Support chat'}
    </button>
  </aside>
}
