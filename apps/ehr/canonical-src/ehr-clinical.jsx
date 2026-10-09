// ehr-clinical.jsx - local clinical workflow shells without fixture patients
const { useState: useClin } = React;

const EHR_INPUT = { width: '100%', padding: '10px 12px', fontSize: 'var(--fs-md)', border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)', color: 'var(--text-strong)', background: 'var(--surface)' };
const C_TD = { padding: '12px 16px', color: 'var(--text-body)' };
const C_TR = { borderTop: '1px solid var(--border-subtle)' };

function ClinField({ label, children }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{label}{children}</label>;
}

function ClinicalTable({ cols, children }) {
  return <Card asArticle padding="0"><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}><thead><tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 11, textTransform: 'uppercase' }}>{cols.map((col) => <th key={col} style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>{col}</th>)}</tr></thead><tbody>{children}</tbody></table></div></Card>;
}

function PatientsModule({ onOpenPatient, autoOpen = false }) {
  const rows = useLocalRecords('patients');
  const [open, setOpen] = useClin(Boolean(autoOpen));
  const [query, setQuery] = useClin('');
  const fields = [
    { key: 'hid', label: 'Existing patient HID', required: true, placeholder: 'Issued by HID Identity' },
    { key: 'name', label: 'Patient display name', required: true },
    { key: 'phone', label: 'Phone number' },
    { key: 'sex', label: 'Sex', type: 'select', options: [['', 'Not entered'], ['Female', 'Female'], ['Male', 'Male'], ['Other', 'Other']] },
    { key: 'status', label: 'Status', type: 'select', required: true, options: [['Outpatient', 'Outpatient'], ['Admitted', 'Admitted'], ['Discharged', 'Discharged']] },
  ];
  const matches = rows.filter((row) => `${row.hid} ${row.name} ${row.phone || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <div><PageHead sub="Clinical" title="Patients" action={<Button variant="primary" icon="user-plus" onClick={() => setOpen(true)}>Add existing HID patient</Button>} />
    <Card asArticle padding="var(--space-400)" style={{ marginBottom: 'var(--space-400)' }}><div style={{ position: 'relative' }}><Icon name="search" size={17} style={{ position: 'absolute', left: 12, top: 12, color: 'var(--text-secondary)' }} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by HID, name or phone" style={{ ...EHR_INPUT, paddingLeft: 38 }} /></div><div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 8 }}>This EHR does not issue HIDs. Enter an identity already issued by HID Identity.</div></Card>
    {matches.length === 0 ? <LocalEmpty icon="user" title={rows.length ? 'No matching patients' : 'No patient records'} body={rows.length ? 'Change the search terms.' : 'Add an existing HID patient to this local facility workspace.'} /> : <ClinicalTable cols={['Patient', 'HID', 'Phone', 'Status', 'Action']}>
      {matches.map((row) => <tr key={row.id} style={C_TR}><td style={{ ...C_TD, fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{row.name}</td><td style={C_TD} className="mono">{row.hid}</td><td style={C_TD}>{row.phone || 'Not entered'}</td><td style={C_TD}><Badge tone="info">{row.status}</Badge></td><td style={C_TD}><Button size="sm" variant="secondary" onClick={() => onOpenPatient ? onOpenPatient(row) : showLocalNotice('Select a clinical workspace to open this patient.')}>Open</Button></td></tr>)}
    </ClinicalTable>}
    <LocalRecordModal open={open} title="Add existing HID patient" fields={fields} submitLabel="Add patient" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('patients', values, 'Existing HID patient added')} />
  </div>;
}

function RegisterPatient({ onDone, onCancel }) {
  return <Card asArticle padding="var(--space-500)"><LocalEmpty icon="user-plus" title="Use HID Identity for registration" body="The EHR can link an existing HID but cannot issue a patient identity." action={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Button variant="secondary" onClick={onCancel || onDone}>Back</Button><Button variant="primary" onClick={() => showLocalNotice('Open HID Identity to create or resolve a patient identity.')}>Open Identity guidance</Button></div>} /></Card>;
}

function TriageModule() {
  const rows = useLocalRecords('triage');
  const [open, setOpen] = useClin(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'complaint', label: 'Presenting complaint', type: 'textarea', required: true },
    { key: 'priority', label: 'Priority', type: 'select', required: true, options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['emergency', 'Emergency']] },
    { key: 'bloodPressure', label: 'Blood pressure' },
    { key: 'temperature', label: 'Temperature' },
  ];
  return <div><PageHead sub="Clinical" title="Triage & Vitals" action={<Button variant="primary" icon="activity" onClick={() => setOpen(true)}>Record triage</Button>} />{rows.length === 0 ? <LocalEmpty icon="activity" title="No triage records" /> : <ClinicalTable cols={['Patient', 'HID', 'Complaint', 'Priority', 'Recorded']}>
    {rows.map((row) => <tr key={row.id} style={C_TR}><td style={C_TD}>{row.patient}</td><td style={C_TD}>{row.hid}</td><td style={C_TD}>{row.complaint}</td><td style={C_TD}><Badge tone={row.priority === 'routine' ? 'gray' : 'danger'}>{row.priority}</Badge></td><td style={C_TD}>{formatLocalDate(row.createdAt)}</td></tr>)}
  </ClinicalTable>}<LocalRecordModal open={open} title="Record triage" fields={fields} submitLabel="Save triage" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('triage', values, 'Triage recorded')} /></div>;
}

function InpatientModule() {
  const rows = useLocalRecords('admissions');
  const [open, setOpen] = useClin(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'ward', label: 'Ward', required: true },
    { key: 'bed', label: 'Bed', required: true },
  ];
  return <div><PageHead sub="Clinical" title="Inpatient / Wards" action={<Button variant="primary" icon="bed" onClick={() => setOpen(true)}>Admit patient</Button>} />{rows.length === 0 ? <LocalEmpty icon="bed" title="No current admissions" /> : <ClinicalTable cols={['Patient', 'HID', 'Ward', 'Bed', 'Admitted']}>
    {rows.map((row) => <tr key={row.id} style={C_TR}><td style={C_TD}>{row.patient}</td><td style={C_TD}>{row.hid}</td><td style={C_TD}>{row.ward}</td><td style={C_TD}>{row.bed}</td><td style={C_TD}>{formatLocalDate(row.createdAt)}</td></tr>)}
  </ClinicalTable>}<LocalRecordModal open={open} title="Admit patient" fields={fields} submitLabel="Admit patient" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('admissions', { ...values, status: 'admitted' }, 'Patient admitted')} /></div>;
}

function AppointmentsModule({ autoOpen = false }) {
  const rows = useLocalRecords('appointments');
  const [open, setOpen] = useClin(Boolean(autoOpen));
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'scheduledAt', label: 'Date and time', type: 'datetime-local', required: true },
    { key: 'department', label: 'Department', required: true },
    { key: 'provider', label: 'Provider' },
    { key: 'type', label: 'Appointment type', required: true },
  ];
  return <div><PageHead sub="Clinical" title="Appointments" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New booking</Button>} />{rows.length === 0 ? <LocalEmpty icon="calendar" title="No appointments" body="Create a booking to add it to this facility workspace." /> : <ClinicalTable cols={['Patient', 'HID', 'Scheduled', 'Department', 'Status', 'Action']}>
    {rows.map((row) => <tr key={row.id} style={C_TR}><td style={C_TD}>{row.patient}</td><td style={C_TD}>{row.hid}</td><td style={C_TD}>{formatLocalDate(row.scheduledAt)}</td><td style={C_TD}>{row.department}</td><td style={C_TD}><Badge tone={row.status === 'checked-in' ? 'success' : 'gray'}>{row.status}</Badge></td><td style={C_TD}>{row.status === 'booked' ? <Button size="sm" variant="primary" onClick={() => updateLocalRecord('appointments', row.id, { status: 'checked-in' }, 'Appointment checked in')}>Check in</Button> : <Button size="sm" variant="secondary" onClick={() => showLocalNotice('Reminder delivery requires a connected messaging service.')}>Remind</Button>}</td></tr>)}
  </ClinicalTable>}<LocalRecordModal open={open} title="Create appointment" fields={fields} submitLabel="Create booking" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('appointments', { ...values, status: 'booked' }, 'Appointment booked')} /></div>;
}

function EmergencyModule({ onBreakGlass }) {
  const rows = useLocalRecords('emergencyCases');
  const [open, setOpen] = useClin(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', placeholder: 'Enter when known' },
    { key: 'patient', label: 'Patient display name or temporary reference', required: true },
    { key: 'complaint', label: 'Emergency presentation', type: 'textarea', required: true },
    { key: 'priority', label: 'Priority', type: 'select', required: true, options: [['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']] },
  ];
  return <div><PageHead sub="Clinical" title="Emergency" action={<Button variant="primary" icon="user-plus" onClick={() => setOpen(true)}>Fast registration</Button>} />{rows.length === 0 ? <LocalEmpty icon="alert" title="No emergency cases" /> : rows.map((row) => <Card key={row.id} asArticle padding="var(--space-400)" style={{ marginBottom: 8 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><div style={{ flex: 1 }}><div style={{ fontWeight: 'var(--fw-semibold)' }}>{row.patient}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{row.complaint}</div></div><Badge tone="danger">{row.priority}</Badge><Button size="sm" variant="outline" icon="alert" onClick={onBreakGlass}>Break glass</Button></div></Card>)}<LocalRecordModal open={open} title="Fast emergency registration" fields={fields} submitLabel="Create emergency case" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('emergencyCases', { ...values, status: 'open' }, 'Emergency case created')} /></div>;
}

function MaternityModule() {
  const rows = useLocalRecords('maternity');
  const [open, setOpen] = useClin(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'gestationalAge', label: 'Gestational age', required: true },
    { key: 'expectedDeliveryDate', label: 'Expected delivery date', type: 'date', required: true },
    { key: 'risk', label: 'Risk level', type: 'select', required: true, options: [['routine', 'Routine'], ['high', 'High risk']] },
  ];
  return <div><PageHead sub="Clinical" title="Maternity - Antenatal" action={<Button variant="primary" icon="user-plus" onClick={() => setOpen(true)}>New ANC registration</Button>} />{rows.length === 0 ? <LocalEmpty icon="heart" title="No ANC records" /> : <ClinicalTable cols={['Patient', 'HID', 'Gestational age', 'Expected delivery', 'Risk']}>
    {rows.map((row) => <tr key={row.id} style={C_TR}><td style={C_TD}>{row.patient}</td><td style={C_TD}>{row.hid}</td><td style={C_TD}>{row.gestationalAge}</td><td style={C_TD}>{row.expectedDeliveryDate}</td><td style={C_TD}><Badge tone={row.risk === 'high' ? 'danger' : 'gray'}>{row.risk}</Badge></td></tr>)}
  </ClinicalTable>}<LocalRecordModal open={open} title="New ANC registration" fields={fields} submitLabel="Create ANC record" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('maternity', values, 'ANC record created')} /></div>;
}

function SurgeryModule() {
  const rows = useLocalRecords('surgeries');
  const [open, setOpen] = useClin(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'procedure', label: 'Procedure', required: true },
    { key: 'scheduledAt', label: 'Date and time', type: 'datetime-local', required: true },
    { key: 'theatre', label: 'Theatre', required: true },
    { key: 'surgeon', label: 'Surgeon', required: true },
  ];
  return <div><PageHead sub="Clinical" title="Theatre" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Schedule surgery</Button>} />{rows.length === 0 ? <LocalEmpty icon="scissors" title="No surgeries scheduled" /> : <ClinicalTable cols={['Patient', 'Procedure', 'Scheduled', 'Theatre', 'Surgeon']}>
    {rows.map((row) => <tr key={row.id} style={C_TR}><td style={C_TD}>{row.patient}</td><td style={C_TD}>{row.procedure}</td><td style={C_TD}>{formatLocalDate(row.scheduledAt)}</td><td style={C_TD}>{row.theatre}</td><td style={C_TD}>{row.surgeon}</td></tr>)}
  </ClinicalTable>}<LocalRecordModal open={open} title="Schedule surgery" fields={fields} submitLabel="Schedule surgery" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('surgeries', { ...values, status: 'scheduled' }, 'Surgery scheduled')} /></div>;
}

Object.assign(window, { PatientsModule, RegisterPatient, TriageModule, InpatientModule, AppointmentsModule, EmergencyModule, MaternityModule, SurgeryModule, EHR_INPUT, ClinField });
