import React, { useEffect, useMemo, useRef, useState } from 'react'

export type Facility = {
  facility_name: string
  state: string
  facility_type: string
}

const FACILITY_SOURCE = '/nigeria_health_facilities_deduped.json'
let facilitiesPromise: Promise<Facility[]> | null = null

function isFacility(value: unknown): value is Facility {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Record<keyof Facility, unknown>>
  return typeof candidate.facility_name === 'string'
    && typeof candidate.state === 'string'
    && typeof candidate.facility_type === 'string'
    && candidate.facility_name.trim().length > 0
}

async function loadFacilities() {
  if (!facilitiesPromise) {
    facilitiesPromise = fetch(FACILITY_SOURCE)
      .then(response => {
        if (!response.ok) throw new Error('Unable to load the hospital directory.')
        return response.json() as Promise<unknown>
      })
      .then(payload => {
        if (!Array.isArray(payload)) throw new Error('The hospital directory is invalid.')
        return payload.filter(isFacility)
      })
  }
  return facilitiesPromise
}

export function FacilityPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadFacilities().then(setFacilities).catch(() => setFacilities([]))
  }, [])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const suggestions = useMemo(() => {
    const query = value.trim().toLowerCase()
    if (!query) return []
    return facilities
      .filter(item => item.facility_name.toLowerCase().startsWith(query) || item.facility_name.toLowerCase().includes(query))
      .slice(0, 8)
  }, [facilities, value])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        aria-label="Current hospital (optional)"
        placeholder="Current Hospital (optional)"
        value={value}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={event => { onChange(event.target.value); setOpen(true) }}
        style={{ width: '100%', height: 'var(--control-height)', padding: '0 12px', border: '1.5px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-size-md)', boxSizing: 'border-box' }}
      />
      {open && value.trim() && suggestions.length > 0 && (
        <div role="listbox" style={{ position: 'absolute', zIndex: 20, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 240, overflowY: 'auto', background: '#fff', border: '1px solid var(--color-border)', borderRadius: 10, boxShadow: '0 10px 24px rgba(17,24,39,.12)' }}>
          {suggestions.map(item => (
            <button key={`${item.facility_name}-${item.state}`} type="button" role="option" onClick={() => { onChange(item.facility_name); setOpen(false) }} style={{ display: 'block', width: '100%', padding: '10px 12px', textAlign: 'left', border: 0, borderBottom: '1px solid #eef1f5', background: '#fff', cursor: 'pointer' }}>
              <span style={{ display: 'block', color: '#111827', fontSize: 13 }}>{item.facility_name}</span>
              <span style={{ display: 'block', marginTop: 3, color: '#7d8797', fontSize: 11 }}>{item.state} · {item.facility_type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
