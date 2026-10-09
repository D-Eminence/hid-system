import React from 'react';
import { Icon, Button, Card, Badge, SectionHeader, Status, Modal, Field, Input, Select, Textarea } from './primitives';
import { PATIENT, ALLERGIES, MEDICATIONS, VITALS_HISTORY, PROBLEM_LIST, BREAK_GLASS_CONTRACT } from './hospital-data';

/* hospital-components.jsx - reusable clinical components & break-glass modal */

// ---- PATIENT HEADER STRIP ----
const PatientHeader = ({ patient = PATIENT, allergies = ALLERGIES, onBack }) => {
  const severe = allergies.filter(a => a.severity === 'Severe');
  const patientName = patient.fullName || [patient.firstName, patient.lastName].filter(Boolean).join(' ') || 'Patient record';
  const initials = patientName.split(/\s+/).filter(Boolean).map(part => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="hid-card hid-card-pad fade-in" style={{ marginBottom: 'var(--space-600)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-400)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-400)' }}>
          {onBack && (
            <Button variant="ghost" size="sm" icon="arrowLeft" onClick={onBack} />
          )}
          <div className="ehr-patient-avatar" style={{ width: 56, height: 56, fontSize: 'var(--fs-lg)' }}>
            {initials}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)' }}>
              <h2 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)' }}>{patientName}</h2>
              {(patient.sex || patient.age) && <Badge variant="blue">{[patient.sex, patient.age ? `${patient.age} yrs` : ''].filter(Boolean).join(', ')}</Badge>}
              {patient.bloodGroup && <Badge variant="neutral">Blood: {patient.bloodGroup}</Badge>}
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-400)', marginTop: 4, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              {patient.hid && <span>HID: <strong className="mono" style={{ color: 'var(--text-strong)' }}>{patient.hid}</strong></span>}
              {patient.mrn && <span>MRN: <strong className="mono" style={{ color: 'var(--text-strong)' }}>{patient.mrn}</strong></span>}
              {patient.phone && <span>Phone: <strong style={{ color: 'var(--text-strong)' }}>{patient.phone}</strong></span>}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)' }}>
          {severe.length > 0 && (
            <div style={{ background: 'var(--danger-50)', border: '1px solid var(--danger-100)', padding: '6px 12px', borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="alertTriangle" size={14} style={{ color: 'var(--danger-badge-text)' }} />
              <span style={{ fontSize: 'var(--fs-caption)', fontWeight: 700, color: 'var(--danger-badge-text)' }}>
                ALLERGY: {severe.map(s => s.substance).join(', ')}
              </span>
            </div>
          )}
          {patient.status && <Status status={patient.status} label={patient.status.toUpperCase()} />}
        </div>
      </div>
    </div>
  );
};

// ---- ALLERGY ALERT ----
const AllergyAlert = ({ allergies = ALLERGIES }) => {
  const severe = allergies.filter(a => a.severity === 'Severe');
  if (!severe.length) return null;

  return (
    <div style={{
      background: 'var(--danger-50)', border: '1.5px solid var(--danger-300)',
      borderRadius: 'var(--radius-xl)', padding: 'var(--space-400) var(--space-500)',
      marginBottom: 'var(--space-500)', display: 'flex', alignItems: 'center', gap: 'var(--space-400)'
    }}>
      <div style={{ width: 36, height: 36, borderRadius: 'var(--radius-lg)', background: 'var(--danger-300)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="alertTriangle" size={20} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--danger-badge-text)' }}>
          CRITICAL DRUG ALLERGY WARNING
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-body)' }}>
          Patient has documented severe reaction ({severe.map(a => `${a.substance} → ${a.reaction}`).join('; ')}). Verify before prescribing.
        </div>
      </div>
    </div>
  );
};

// ---- PATIENT SUMMARY CARD ----
const PatientSummaryCard = ({ patient = PATIENT }) => (
  <Card pad>
    <SectionHeader title="Patient Demographics & Identity" />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-400)', marginTop: 'var(--space-400)' }}>
      <div>
        <div className="ehr-record-label">Full Name</div>
        <div className="ehr-record-value">{patient.fullName || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Health Identity (HID)</div>
        <div className="ehr-record-value mono">{patient.hid || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Hospital MRN</div>
        <div className="ehr-record-value mono">{patient.mrn || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">NIN (Tokenized)</div>
        <div className="ehr-record-value mono">{patient.nin || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Date of Birth / Age</div>
        <div className="ehr-record-value">{patient.dob || 'Not entered'}{patient.age ? ` (${patient.age} yrs)` : ''}</div>
      </div>
      <div>
        <div className="ehr-record-label">Gender & Blood Group</div>
        <div className="ehr-record-value">{[patient.sex, patient.bloodGroup].filter(Boolean).join(' / ') || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Primary Phone</div>
        <div className="ehr-record-value">{patient.phone || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Residential Address</div>
        <div className="ehr-record-value">{patient.address || 'Not entered'}</div>
      </div>
      <div>
        <div className="ehr-record-label">Emergency Contact</div>
        <div className="ehr-record-value">{patient.emergencyContact ? [patient.emergencyContact.name, patient.emergencyContact.rel, patient.emergencyContact.phone].filter(Boolean).join(' / ') : 'Not entered'}</div>
      </div>
    </div>
  </Card>
);

// ---- PROBLEM LIST PANEL ----
const ProblemListPanel = ({ problems = PROBLEM_LIST, onAddDiagnosis }) => (
  <div className="ehr-table-wrap">
    <div style={{ padding: 'var(--space-400) var(--space-500)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Active Problem List / Diagnoses</span>
      <Button variant="ghost" size="sm" icon="plus" onClick={onAddDiagnosis} disabled={!onAddDiagnosis}>Add Diagnosis</Button>
    </div>
    <table className="ehr-table">
      <thead>
        <tr>
          <th>ICD-10</th>
          <th>Description</th>
          <th>Onset</th>
          <th>Severity</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {problems.map(p => (
          <tr key={p.id}>
            <td className="mono" style={{ fontWeight: 600 }}>{p.icd}</td>
            <td>{p.desc}</td>
            <td>{p.onset}</td>
            <td><Badge variant={p.severity === 'Severe' ? 'danger' : 'neutral'}>{p.severity}</Badge></td>
            <td><Status status={p.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ---- ALLERGIES PANEL ----
const AllergiesPanel = ({ allergies = ALLERGIES, onLogAllergy }) => (
  <div className="ehr-table-wrap">
    <div style={{ padding: 'var(--space-400) var(--space-500)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Allergies & Adverse Reactions</span>
      <Button variant="ghost" size="sm" icon="plus" onClick={onLogAllergy} disabled={!onLogAllergy}>Log Allergy</Button>
    </div>
    <table className="ehr-table">
      <thead>
        <tr>
          <th>Substance</th>
          <th>Category</th>
          <th>Severity</th>
          <th>Reaction</th>
          <th>Recorded Date</th>
        </tr>
      </thead>
      <tbody>
        {allergies.map(a => (
          <tr key={a.id}>
            <td style={{ fontWeight: 700, color: 'var(--text-heading)' }}>{a.substance}</td>
            <td>{a.type}</td>
            <td><Badge variant={a.severity === 'Severe' ? 'danger' : a.severity === 'Moderate' ? 'warning' : 'neutral'}>{a.severity}</Badge></td>
            <td>{a.reaction}</td>
            <td>{a.recorded}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ---- MEDICATIONS PANEL ----
const MedicationsPanel = ({ medications = MEDICATIONS, onNewPrescription }) => (
  <div>
    <SectionHeader title="Active & Past Prescriptions" action={<Button variant="ghost" size="sm" icon="plus" onClick={onNewPrescription} disabled={!onNewPrescription}>New Prescription</Button>} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-300)', marginTop: 'var(--space-300)' }}>
      {medications.map(m => (
        <div key={m.id} className="ehr-rx-card">
          <div className="ehr-rx-icon"><Icon name="pill" size={16} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-heading)' }}>{m.name}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Status status={m.status} />
                {m.dispensed ? <Badge variant="blue">Dispensed</Badge> : <Badge variant="neutral">Pending POS</Badge>}
              </div>
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-body)', marginTop: 4 }}>
              <strong>{m.dosage}</strong> - {m.frequency} ({m.route}) for <em>{m.indication}</em>
            </div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 4, display: 'flex', gap: 12 }}>
              <span>Prescribed: {m.prescribed} by {m.prescribedBy}</span>
              <span>ID: <strong className="mono">{m.id}</strong></span>
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ---- VITALS PANEL ----
const VitalsPanel = ({ vitalsHistory = VITALS_HISTORY, onRecordVitals }) => {
  const latest = vitalsHistory[0] || {};

  return (
    <Card pad>
      <SectionHeader title="Clinical Vitals & Measurements" action={<Button variant="ghost" size="sm" icon="plus" onClick={onRecordVitals} disabled={!onRecordVitals}>Record Vitals</Button>} />
      
      {/* Latest Vitals Strip */}
      <div className="ehr-vitals-row" style={{ marginTop: 'var(--space-400)', marginBottom: 'var(--space-600)' }}>
        <div className="ehr-vital">
          <div className="ehr-vital-value">{latest.bp || '-'}</div>
          <div className="ehr-vital-unit">mmHg</div>
          <div className="ehr-vital-label">Blood Pressure</div>
        </div>
        <div className="ehr-vital">
          <div className="ehr-vital-value">{latest.pulse || '-'}</div>
          <div className="ehr-vital-unit">bpm</div>
          <div className="ehr-vital-label">Pulse Rate</div>
        </div>
        <div className="ehr-vital">
          <div className="ehr-vital-value">{latest.temp || '-'}°C</div>
          <div className="ehr-vital-unit">Celsius</div>
          <div className="ehr-vital-label">Temperature</div>
        </div>
        <div className="ehr-vital">
          <div className="ehr-vital-value">{latest.spo2 || '-'}%</div>
          <div className="ehr-vital-unit">SpO2</div>
          <div className="ehr-vital-label">Oxygen Sat.</div>
        </div>
        <div className="ehr-vital">
          <div className="ehr-vital-value">{latest.weight || '-'}</div>
          <div className="ehr-vital-unit">kg</div>
          <div className="ehr-vital-label">Weight (BMI {latest.bmi})</div>
        </div>
      </div>

      {/* History table */}
      <div className="ehr-table-wrap">
        <table className="ehr-table">
          <thead>
            <tr>
              <th>Date & Time</th>
              <th>BP</th>
              <th>Pulse</th>
              <th>Temp</th>
              <th>RR</th>
              <th>SpO2</th>
              <th>Weight</th>
              <th>Recorded By</th>
            </tr>
          </thead>
          <tbody>
            {vitalsHistory.map(v => (
              <tr key={v.id}>
                <td style={{ fontSize: 'var(--fs-caption)' }}>{new Date(v.date).toLocaleString()}</td>
                <td className="mono" style={{ fontWeight: 600 }}>{v.bp}</td>
                <td>{v.pulse} bpm</td>
                <td>{v.temp} °C</td>
                <td>{v.rr} /min</td>
                <td>{v.spo2} %</td>
                <td>{v.weight} kg</td>
                <td>{v.recordedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};

// ---- BREAK-GLASS MODAL ----
const BreakGlassModal = ({ open, onClose, onConfirm, patient = PATIENT }) => {
  const [reason, setReason] = React.useState('');
  const [staffName, setStaffName] = React.useState('');
  const [duration, setDuration] = React.useState('');

  const handleConfirm = () => {
    if (!reason.trim() || !staffName.trim() || !duration) return;
    onConfirm && onConfirm({
      reason,
      staffName,
      durationMinutes: parseInt(duration),
      ts: new Date().toISOString(),
      patientHid: patient.hid,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Emergency Break-Glass Access"
      danger={true}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim() || !staffName.trim() || !duration} onClick={handleConfirm} icon="shield">
            Confirm Break-Glass Access
          </Button>
        </>
      }
    >
      <div style={{ background: 'var(--danger-50)', padding: 'var(--space-400)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--danger-100)', marginBottom: 'var(--space-400)' }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, color: 'var(--danger-badge-text)', marginBottom: 4 }}>
          MANDATORY GOVERNANCE CONTRACT (DECISIONS.md §3)
        </div>
        <ul style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-body)', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {BREAK_GLASS_CONTRACT.fourPartContract.map((rule, idx) => (
            <li key={idx}><strong>Rule {idx + 1}:</strong> {rule}</li>
          ))}
        </ul>
      </div>

      <Field label="Target Patient" required>
        <div style={{ padding: 'var(--space-300)', background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)' }}>
          <strong>{patient.fullName || 'Patient record'}</strong>{patient.hid ? <> | HID: <span className="mono">{patient.hid}</span></> : null}
        </div>
      </Field>

      <Field label="Clinical Reason for Break-Glass" required hint="Provide detailed justification (e.g. Unconscious patient in A&E requiring immediate allergy/history check)">
        <Textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="State exact medical emergency reason..."
          rows={3}
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-400)' }}>
        <Field label="Requesting Clinician">
          <Input value={staffName} onChange={e => setStaffName(e.target.value)} required />
        </Field>

        <Field label="Access Grant Duration">
          <Select
            value={duration}
            onChange={e => setDuration(e.target.value)}
            options={[
              { value: '30', label: '30 Minutes' },
              { value: '60', label: '1 Hour' },
              { value: '120', label: '2 Hours' },
              { value: '240', label: '4 Hours (Max)' },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
};

// ---- BREAK-GLASS ACTIVE BANNER ----
const BreakGlassView = ({ session, onExit }) => {
  if (!session) return null;

  return (
    <div style={{
      background: 'var(--danger-700)', color: 'var(--neutral-0)',
      padding: 'var(--space-300) var(--space-600)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 56, zIndex: 190
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)' }}>
        <Icon name="alertTriangle" size={16} />
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700 }}>
          EMERGENCY BREAK-GLASS ACCESS ACTIVE
        </span>
        <span style={{ fontSize: 'var(--fs-caption)', opacity: 0.9 }}>
          Reason: "{session.reason}" ({session.staffName})
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-400)' }}>
        <span style={{ fontSize: 'var(--fs-caption)', background: 'rgba(255,255,255,0.2)', padding: '2px 8px', borderRadius: 'var(--radius-pill)' }}>
          Auto-expires in {session.durationMinutes || 60}m
        </span>
        <Button variant="secondary" size="sm" onClick={onExit} style={{ background: '#fff', color: 'var(--danger-700)', border: 'none' }}>
          End Emergency Session
        </Button>
      </div>
    </div>
  );
};

// ---- ACCESS GATE (DIRECT LOGGED BYPASS) ----
const AccessGate = ({ patient, onProceed }) => (
  <Card pad style={{ textAlign: 'center', maxWidth: 480, margin: '40px auto' }}>
    <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--surface-info)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
      <Icon name="shield" size={24} />
    </div>
    <h3 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 700, color: 'var(--text-heading)', marginBottom: 8 }}>Patient-ID Direct Access</h3>
    <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>
      Accessing record for <strong>{patient.fullName || 'the selected patient'}</strong>{patient.hid ? ` (${patient.hid})` : ''}. Every clinical view must be logged to the audit trail.
    </p>
    <Button variant="primary" size="lg" fullWidth onClick={onProceed} icon="check">
      Open Patient Chart
    </Button>
  </Card>
);



export { PatientHeader, AllergyAlert, PatientSummaryCard, ProblemListPanel, AllergiesPanel, MedicationsPanel, VitalsPanel, BreakGlassModal, BreakGlassView, AccessGate };
