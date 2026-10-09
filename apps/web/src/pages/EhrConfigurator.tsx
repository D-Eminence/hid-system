import React, { useMemo, useState } from 'react'
import { CommercialLayout } from '../features/commercial/CommercialLayout'
import { departments, ehrAddons, facilityTypes } from '../features/commercial/catalog'

export default function EhrConfigurator() {
  const [facility, setFacility] = useState('Hospital')
  const [selectedDepartments, setDepartments] = useState<string[]>(['General OPD'])
  const [addons, setAddons] = useState<string[]>([])
  const toggle = (value: string, values: string[], setter: (next: string[]) => void) => setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value])
  const mailto = useMemo(() => `mailto:hello@healthidentitydirectory.com?subject=HID EHR Configuration&body=${encodeURIComponent(`Facility: ${facility}\nDepartments: ${selectedDepartments.join(', ')}\nAdd-ons: ${addons.join(', ') || 'None'}\nPricing: Custom quote`)}`, [facility, selectedDepartments, addons])
  return <CommercialLayout><main><section className="commercial-hero"><div className="commercial-shell"><div className="commercial-eyebrow">HID EHR configurator</div><h1>Build the system your facility actually needs.</h1><p>Select your facility, operating departments, and optional connected products. Your choices are passed into the demo and pricing request.</p></div></section><section className="commercial-section"><div className="commercial-shell commercial-form">
    <div><h2>1. What type of healthcare facility do you operate?</h2><div className="commercial-options">{facilityTypes.map(item => <button className={`commercial-option ${facility === item ? 'selected' : ''}`} onClick={() => setFacility(item)} key={item}>{item}</button>)}</div></div>
    <div><h2>2. Which departments and services do you operate?</h2><div className="commercial-options">{departments.map(item => <button className={`commercial-option ${selectedDepartments.includes(item) ? 'selected' : ''}`} onClick={() => toggle(item, selectedDepartments, setDepartments)} key={item}>{item}</button>)}</div></div>
    <div><h2>3. HID EHR Core</h2><div className="commercial-card"><span className="commercial-badge">Included</span><h3>Core hospital operations</h3><p>Patient registration, HID identity, records, appointments, triage, consultation, admissions, billing, staff and roles, reports, and audit.</p></div></div>
    <div><h2>4. Extend your HID EHR</h2><div className="commercial-options">{ehrAddons.map(item => <button className={`commercial-option ${addons.includes(item.name) ? 'selected' : ''}`} onClick={() => toggle(item.name, addons, setAddons)} key={item.slug}><strong>{item.name}</strong><p>{item.description}</p><span className="commercial-badge">{item.availability === 'available' ? 'Add-on' : 'Coming soon'}</span></button>)}</div></div>
    <div className="commercial-summary"><h2>Your HID Configuration</h2><p><strong>Facility:</strong> {facility}</p><p><strong>Departments:</strong> {selectedDepartments.join(', ') || 'None selected'}</p><p><strong>Core:</strong> HID EHR Core - Included</p><p><strong>Add-ons:</strong> {addons.join(', ') || 'None selected'}</p><p><strong>Pricing:</strong> Custom quote</p><a className="commercial-button primary" href={mailto}>Request Demo & Pricing</a></div>
  </div></section></main></CommercialLayout>
}
