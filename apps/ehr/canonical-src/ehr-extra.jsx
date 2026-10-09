// ehr-extra.jsx - local administration and service modules
const { useState: useX } = React;

const X_TD = { padding: '12px 16px', color: 'var(--text-body)' };
const X_TR = { borderTop: '1px solid var(--border-subtle)' };

function XTable({ cols, children }) {
  return <Card asArticle padding="0"><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}><thead><tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 11, textTransform: 'uppercase' }}>{cols.map((col) => <th key={col} style={{ padding: '10px 16px', whiteSpace: 'nowrap' }}>{col}</th>)}</tr></thead><tbody>{children}</tbody></table></div></Card>;
}

function JourneyModule() {
  const rows = useLocalRecords('journeys');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'department', label: 'Department', required: true },
    { key: 'stage', label: 'Current stage', type: 'select', required: true, options: [['Registered', 'Registered'], ['Triage', 'Triage'], ['Consultation', 'Consultation'], ['Diagnostics', 'Diagnostics'], ['Discharge', 'Discharge']] },
  ];
  return <div><PageHead sub="Clinical" title="Patient Journey" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Add journey</Button>} />{rows.length === 0 ? <LocalEmpty icon="route" title="No active journeys" body="Patient flow appears after a journey is added." /> : <XTable cols={['Patient', 'HID', 'Department', 'Stage']}>
    {rows.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.patient}</td><td style={X_TD} className="mono">{row.hid}</td><td style={X_TD}>{row.department}</td><td style={X_TD}><Badge tone="info">{row.stage}</Badge></td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Add patient journey" fields={fields} submitLabel="Add journey" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('journeys', values, 'Patient journey added')} /></div>;
}

function ShiftsModule() {
  const rows = useLocalRecords('shifts');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'staffName', label: 'Staff member', required: true },
    { key: 'department', label: 'Department', required: true },
    { key: 'shift', label: 'Shift', type: 'select', required: true, options: [['Morning', 'Morning'], ['Afternoon', 'Afternoon'], ['Night', 'Night'], ['On call', 'On call']] },
  ];
  return <div><PageHead sub="Administration" title="Shifts & Roster" action={<Button variant="primary" icon="clock" onClick={() => setOpen(true)}>Clock in</Button>} />{rows.length === 0 ? <LocalEmpty icon="clock" title="No shift records" body="Clock in a staff member to start the local roster." /> : <XTable cols={['Staff', 'Department', 'Shift', 'Clocked in']}>
    {rows.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.staffName}</td><td style={X_TD}>{row.department}</td><td style={X_TD}>{row.shift}</td><td style={X_TD}>{formatLocalDate(row.createdAt)}</td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Clock in staff" fields={fields} submitLabel="Clock in" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('shifts', values, 'Staff clocked in')} /></div>;
}

function HRModule() {
  const staff = useLocalRecords('staff');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'name', label: 'Full name', required: true },
    { key: 'email', label: 'Work email', type: 'email', required: true },
    { key: 'role', label: 'Role', type: 'select', required: true, options: ROLES.map((role) => [role.label, role.label]) },
    { key: 'dept', label: 'Department', type: 'select', required: true, options: DEPARTMENTS.map((dept) => [dept.label, dept.label]) },
    { key: 'license', label: 'Professional licence' },
    { key: 'licenseExpiry', label: 'Licence expiry', type: 'date' },
  ];
  return <div><PageHead sub="Administration" title="HR & Credentials" action={<Button variant="primary" icon="user-plus" onClick={() => setOpen(true)}>Add staff</Button>} />{staff.length === 0 ? <LocalEmpty icon="badge" title="No staff credentials" body="Add a staff member to begin the facility credential register." /> : <XTable cols={['Staff', 'Role', 'Department', 'Licence', 'Expiry']}>
    {staff.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.name}</td><td style={X_TD}>{row.role}</td><td style={X_TD}>{row.dept}</td><td style={X_TD}>{row.license || 'Not entered'}</td><td style={X_TD}>{row.licenseExpiry || 'Not entered'}</td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Add staff and credentials" fields={fields} submitLabel="Add staff" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('staff', { ...values, status: 'active' }, 'Staff member added')} /></div>;
}

function QualityModule({ autoOpen = false }) {
  const incidents = useLocalRecords('incidents');
  const [open, setOpen] = useX(Boolean(autoOpen));
  const fields = [
    { key: 'type', label: 'Incident type', required: true },
    { key: 'department', label: 'Department', required: true },
    { key: 'severity', label: 'Severity', type: 'select', required: true, options: [['low', 'Low'], ['moderate', 'Moderate'], ['high', 'High'], ['critical', 'Critical']] },
    { key: 'description', label: 'What happened', type: 'textarea', required: true },
    { key: 'occurredAt', label: 'Date and time', type: 'datetime-local', required: true },
  ];
  const severityTone = { low: 'gray', moderate: 'warning', high: 'danger', critical: 'danger' };
  return <div><PageHead sub="Administration" title="Quality & Safety" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Report incident</Button>} />
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--space-300)', marginBottom: 'var(--space-400)' }}>
      <Card padding="var(--space-400)"><div style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)' }}>{incidents.length}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Reported incidents</div></Card>
      <Card padding="var(--space-400)"><div style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)' }}>{incidents.filter((row) => row.status !== 'closed').length}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Open reviews</div></Card>
    </div>
    {incidents.length === 0 ? <LocalEmpty icon="shield-check" title="No incidents reported" body="Use Report incident to create the first local safety record." action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Report incident</Button>} /> : <XTable cols={['Incident', 'Department', 'Severity', 'Status', 'Occurred', 'Action']}>
      {incidents.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.type}</td><td style={X_TD}>{row.department}</td><td style={X_TD}><Badge tone={severityTone[row.severity] || 'gray'}>{row.severity}</Badge></td><td style={X_TD}><Badge tone={row.status === 'closed' ? 'success' : 'warning'}>{row.status}</Badge></td><td style={X_TD}>{formatLocalDate(row.occurredAt)}</td><td style={X_TD}>{row.status === 'closed' ? <Button size="sm" variant="secondary" icon="download" onClick={() => downloadLocalRecords('incident', [row])}>Export</Button> : <Button size="sm" variant="primary" onClick={() => updateLocalRecord('incidents', row.id, { status: 'closed', closedAt: new Date().toISOString() }, 'Incident closed')}>Close</Button>}</td></tr>)}
    </XTable>}
    <LocalRecordModal open={open} title="Report safety incident" fields={fields} submitLabel="Report incident" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('incidents', { ...values, status: 'open' }, 'Safety incident reported')} />
  </div>;
}

function InsuranceModule() {
  const claims = useLocalRecords('claims');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'insurer', label: 'Insurer', required: true },
    { key: 'service', label: 'Service', required: true },
    { key: 'amount', label: 'Claim amount', type: 'number', required: true },
  ];
  return <div><PageHead sub="Operations" title="Insurance & Claims" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New claim</Button>} />{claims.length === 0 ? <LocalEmpty icon="shield" title="No insurance claims" body="Create a claim to add it to this local workspace." /> : <XTable cols={['Patient', 'HID', 'Insurer', 'Service', 'Amount', 'Status', 'Action']}>
    {claims.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.patient}</td><td style={X_TD}>{row.hid}</td><td style={X_TD}>{row.insurer}</td><td style={X_TD}>{row.service}</td><td style={X_TD}>{formatLocalMoney(row.amount)}</td><td style={X_TD}><Badge tone={row.status === 'approved' ? 'success' : 'warning'}>{row.status}</Badge></td><td style={X_TD}>{row.status === 'submitted' && <Button size="sm" variant="primary" onClick={() => updateLocalRecord('claims', row.id, { status: 'approved' }, 'Claim approved locally')}>Authorize</Button>}</td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Create insurance claim" fields={fields} submitLabel="Create claim" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('claims', { ...values, status: 'submitted' }, 'Insurance claim created')} /></div>;
}

function InventoryModule() {
  const orders = useLocalRecords('purchaseOrders');
  const stock = useLocalRecords('stockItems');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'vendor', label: 'Vendor', required: true },
    { key: 'items', label: 'Items requested', type: 'textarea', required: true },
    { key: 'value', label: 'Estimated value', type: 'number', required: true },
  ];
  return <div><PageHead sub="Operations" title="Inventory & Procurement" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Purchase request</Button>} />
    <div className="ehr-cols" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 'var(--space-400)' }}>
      <Card asArticle padding="var(--space-500)"><SectionHeader title="Stock levels" />{stock.length === 0 ? <LocalEmpty icon="box" title="No stock records" body="Stock data must be entered or loaded through an authorized integration." /> : stock.map((row) => <div key={row.id}>{row.item}</div>)}</Card>
      <Card asArticle padding="var(--space-500)"><SectionHeader title="Purchase requests" />{orders.length === 0 ? <LocalEmpty icon="receipt" title="No purchase requests" /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'var(--space-300)' }}>{orders.map((row) => <div key={row.id} style={{ padding: 'var(--space-300)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}><div style={{ fontWeight: 'var(--fw-semibold)' }}>{row.vendor}</div><div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', marginTop: 3 }}>{row.items}</div><Badge tone="warning">{row.status}</Badge></div>)}</div>}</Card>
    </div><LocalRecordModal open={open} title="New purchase request" fields={fields} submitLabel="Create request" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('purchaseOrders', { ...values, category: 'general', status: 'pending' }, 'Purchase request created')} /></div>;
}

function AmbulanceModule() {
  const rows = useLocalRecords('ambulanceDispatches');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'destination', label: 'Destination', required: true },
    { key: 'reason', label: 'Dispatch reason', type: 'textarea', required: true },
    { key: 'contact', label: 'Contact number', required: true },
  ];
  return <div><PageHead sub="Network & Services" title="Ambulance" action={<Button variant="primary" icon="truck" onClick={() => setOpen(true)}>Dispatch</Button>} />{rows.length === 0 ? <LocalEmpty icon="truck" title="No ambulance dispatches" /> : rows.map((row) => <Card key={row.id} asArticle padding="var(--space-400)" style={{ marginBottom: 8 }}><div style={{ fontWeight: 'var(--fw-semibold)' }}>{row.destination}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{row.reason}</div><Badge tone="danger">Dispatched</Badge></Card>)}<LocalRecordModal open={open} title="Dispatch ambulance" fields={fields} submitLabel="Dispatch" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('ambulanceDispatches', { ...values, status: 'dispatched' }, 'Ambulance dispatched')} /></div>;
}

function BloodBankModule() {
  const rows = useLocalRecords('bloodDonations');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'donorCode', label: 'Donor reference', required: true },
    { key: 'bloodGroup', label: 'Blood group', type: 'select', required: true, options: ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map((value) => [value, value]) },
    { key: 'units', label: 'Units', type: 'number', required: true },
  ];
  return <div><PageHead sub="Network & Services" title="Blood Bank" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Log donation</Button>} />{rows.length === 0 ? <LocalEmpty icon="droplet" title="No blood donations" /> : <XTable cols={['Donor reference', 'Blood group', 'Units', 'Logged']}>
    {rows.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.donorCode}</td><td style={X_TD}>{row.bloodGroup}</td><td style={X_TD}>{row.units}</td><td style={X_TD}>{formatLocalDate(row.createdAt)}</td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Log blood donation" fields={fields} submitLabel="Log donation" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('bloodDonations', values, 'Blood donation logged')} /></div>;
}

function TelemedicineModule() {
  const rows = useLocalRecords('telemedicineSessions');
  const [open, setOpen] = useX(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'scheduledAt', label: 'Scheduled time', type: 'datetime-local', required: true },
    { key: 'purpose', label: 'Purpose', required: true },
  ];
  return <div><PageHead sub="Network & Services" title="Telemedicine" action={<Button variant="primary" icon="video" onClick={() => setOpen(true)}>Start session</Button>} />{rows.length === 0 ? <LocalEmpty icon="video" title="No telemedicine sessions" /> : rows.map((row) => <Card key={row.id} asArticle padding="var(--space-400)" style={{ marginBottom: 8 }}><div style={{ fontWeight: 'var(--fw-semibold)' }}>{row.patient}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{formatLocalDate(row.scheduledAt)} | {row.purpose}</div><Button size="sm" variant="primary" icon="video" onClick={() => showLocalNotice('Video transport requires a connected telemedicine service.')}>Join</Button></Card>)}<LocalRecordModal open={open} title="Create telemedicine session" fields={fields} submitLabel="Create session" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('telemedicineSessions', { ...values, status: 'scheduled' }, 'Telemedicine session created')} /></div>;
}

function ReferralsModule({ autoOpen = false }) {
  const rows = useLocalRecords('referrals');
  const [open, setOpen] = useX(Boolean(autoOpen));
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'destination', label: 'Receiving facility', required: true },
    { key: 'reason', label: 'Referral reason', type: 'textarea', required: true },
    { key: 'urgency', label: 'Urgency', type: 'select', required: true, options: [['routine', 'Routine'], ['urgent', 'Urgent']] },
  ];
  return <div><PageHead sub="Network & Services" title="Referral Network" action={<Button variant="primary" icon="share" onClick={() => setOpen(true)}>New referral</Button>} />{rows.length === 0 ? <LocalEmpty icon="share" title="No referrals" /> : <XTable cols={['Patient', 'HID', 'Receiving facility', 'Urgency', 'Status']}>
    {rows.map((row) => <tr key={row.id} style={X_TR}><td style={X_TD}>{row.patient}</td><td style={X_TD}>{row.hid}</td><td style={X_TD}>{row.destination}</td><td style={X_TD}>{row.urgency}</td><td style={X_TD}><Badge tone="info">{row.status}</Badge></td></tr>)}
  </XTable>}<LocalRecordModal open={open} title="Create referral" fields={fields} submitLabel="Create referral" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('referrals', { ...values, status: 'draft' }, 'Referral created')} /></div>;
}

Object.assign(window, { JourneyModule, ShiftsModule, HRModule, QualityModule, InsuranceModule, InventoryModule, AmbulanceModule, BloodBankModule, TelemedicineModule, ReferralsModule });
