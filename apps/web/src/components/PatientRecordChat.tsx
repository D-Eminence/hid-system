import { useState, type FormEvent } from 'react'
import { canonicalRequest } from '../lib/identityClient'

type Source = { number: number; noteId: string; revisionNo: number; title: string; signedAt: string }
type Reply = { status: 'ready' | 'preparing'; answer: string; sources: Source[] }
type Exchange = { question: string; reply: Reply }

export function PatientRecordChat() {
  const [draft, setDraft] = useState('')
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function ask(event: FormEvent) {
    event.preventDefault()
    const question = draft.trim()
    if (!question || busy) return
    setBusy(true)
    setError('')
    try {
      const reply = await canonicalRequest<Reply>('/api/v1/ehr/me/chat', {
        method: 'POST', body: JSON.stringify({ question }),
      }, { timeoutMs: 40_000 })
      setExchanges(previous => [...previous.slice(-19), { question, reply }])
      if (reply.status === 'ready') setDraft('')
    } catch {
      setError('Your records could not be checked right now. Please try again later.')
    } finally {
      setBusy(false)
    }
  }

  return <section aria-label="Ask about your records" style={{ borderTop: '1px solid #dbe3ef', marginTop: 24, paddingTop: 20 }}>
    <h2>Ask about your records</h2>
    <p>Answers use your released clinical notes and show their sources. This does not replace medical advice from your care team.</p>
    <div role="log" aria-live="polite">
      {exchanges.map((exchange, index) => <article key={index} style={{ border: '1px solid #dbe3ef', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <p><strong>You:</strong> {exchange.question}</p>
        <p><strong>Answer:</strong> {exchange.reply.answer}</p>
        {exchange.reply.sources.length > 0 && <details><summary>Source records</summary><ol>
          {exchange.reply.sources.map(source => <li key={source.noteId}>
            {source.title} · revision {source.revisionNo} · {new Date(source.signedAt).toLocaleDateString()} · record {source.noteId}
          </li>)}
        </ol></details>}
      </article>)}
    </div>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => void ask(event)}>
      <label htmlFor="patient-record-question">Your question</label>
      <textarea id="patient-record-question" value={draft} onChange={event => setDraft(event.target.value)} maxLength={500} required rows={3} style={{ display: 'block', width: '100%', margin: '8px 0' }} />
      <button type="submit" disabled={busy}>{busy ? 'Checking records…' : 'Ask about my records'}</button>
    </form>
  </section>
}
