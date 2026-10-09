import React from 'react'
import { Link } from 'react-router-dom'
import { signOutAndClearSessions } from '../lib/auth'
import type { ReleasedRecords } from '../lib/carePortalApi'

export function CarePortal({ title, children, patient = false }: { title: string; children: React.ReactNode; patient?: boolean }) {
  return <main style={{ maxWidth: 960, margin: '0 auto', padding: 24, lineHeight: 1.6 }}>
    <header><Link to="/">Health Identity Directory</Link><h1>{title}</h1>
      <nav aria-label={patient ? 'Patient portal' : 'Clinical portal'} style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {patient ? <><Link to="/patient/profile">Profile and HID</Link><Link to="/patient/biodata">Bio data</Link><Link to="/patient/records">My records</Link><Link to="/patient/history">Access history</Link><Link to="/patient/notifications">Access notifications</Link></>
          : <><Link to="/hospital/emergency">Emergency access</Link><Link to="/hospital/registration">Patient registration</Link></>}
        <button onClick={() => { void signOutAndClearSessions().then(() => { window.location.assign(patient ? '/patient' : '/hospital/auth') }).catch(() => { window.location.assign(patient ? '/patient' : '/hospital/auth') }) }}>Sign out</button>
      </nav>
    </header>
    <section style={{ marginTop: 24 }}>{children}</section>
  </main>
}
function NoteContent({ value }: { value: unknown }): React.ReactElement {
  if (value === null || value === undefined) return <span>Not recorded</span>
  if (Array.isArray(value)) return <ul>{value.map((item, index) => <li key={index}><NoteContent value={item} /></li>)}</ul>
  if (typeof value === 'object') return <dl>{Object.entries(value).map(([key, item]) => <React.Fragment key={key}>
    <dt style={{ fontWeight: 600 }}>{key.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd><NoteContent value={item} /></dd>
  </React.Fragment>)}</dl>
  return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(value)}</span>
}
export function RecordSummary({ records }: { records: ReleasedRecords }) {
  return <section aria-label="Released medical records">
    <p>Completed encounters and signed or amended notes. Up to {records.limit} of each are shown.</p>
    {records.encounters.length === 0 && records.notes.length === 0 && <p>No released records are available.</p>}
    {records.encounters.map(encounter => <article key={encounter.id} style={{ borderTop: '1px solid #dbe3ef', padding: '12px 0' }}>
      <h3>{encounter.encounterType}</h3><p>{new Date(encounter.startedAt).toLocaleString()} · {encounter.status}</p>
    </article>)}
    {records.notes.map(note => <article key={note.id} style={{ borderTop: '1px solid #dbe3ef', padding: '12px 0' }}>
      <h3>{note.title || note.noteType}</h3><p>{note.status} · Revision {note.revisionNo}{note.signedAt ? ` · ${new Date(note.signedAt).toLocaleString()}` : ''}</p>
      <NoteContent value={note.content} />
    </article>)}
  </section>
}
