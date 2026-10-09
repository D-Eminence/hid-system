// ehr-ops.jsx - local operational modules for the canonical EHR reference
const { useState: useOps } = React;

const OPS_TD = { padding: '12px 16px', color: 'var(--text-body)' };
const OPS_TR = { borderTop: '1px solid var(--border-subtle)' };

function OpsTable({ cols, children }) {
  return (
    <Card asArticle padding="0">
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-secondary)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{cols.map((col) => <th key={col} style={{ padding: '10px 16px', fontWeight: 'var(--fw-bold)', whiteSpace: 'nowrap' }}>{col}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </Card>
  );
}

function QueueRow({ left, title, sub, right }) {
  return (
    <Card asArticle padding="var(--space-300) var(--space-400)">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)', flexWrap: 'wrap' }}>
        {left}
        <div style={{ flex: 1, minWidth: 180 }}><div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{title}</div><div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>{sub}</div></div>
        {right}
      </div>
    </Card>
  );
}

const STAGE_LABEL = { collected: 'Collected', processing: 'Processing', verify: 'To verify', completed: 'Completed', requested: 'Requested', acquired: 'Acquired', reporting: 'Reporting' };
const NEXT_LAB_STAGE = { collected: 'processing', processing: 'verify', verify: 'completed', completed: 'completed' };

function LabModule({ autoOpen = false }) {
  const rows = useLocalRecords('labSamples');
  const [tab, setTab] = useOps('all');
  const [open, setOpen] = useOps(Boolean(autoOpen));
  const filtered = rows.filter((row) => tab === 'all' || row.stage === tab);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true, placeholder: 'Existing HID from HID Identity' },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'test', label: 'Test requested', required: true },
    { key: 'urgency', label: 'Urgency', type: 'select', required: true, options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['stat', 'STAT']] },
  ];
  return (
    <div>
      <PageHead sub="Diagnostics" title="Laboratory" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>Log sample</Button>} />
      <Tabs tabs={Object.entries({ all: 'All', collected: 'Collected', processing: 'Processing', verify: 'To verify', completed: 'Completed' })} active={tab} onTab={setTab} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-200)', marginTop: 'var(--space-400)' }}>
        {filtered.map((row) => (
          <QueueRow key={row.id}
            left={<div style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--primary-50)', color: 'var(--accent-hover)', display: 'grid', placeItems: 'center' }}><Icon name="flask" size={18} /></div>}
            title={`${row.test} | ${row.patient}`} sub={`${row.hid} | ${row.urgency}`}
            right={<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><Badge tone={row.stage === 'completed' ? 'success' : row.stage === 'verify' ? 'warning' : 'info'}>{STAGE_LABEL[row.stage] || row.stage}</Badge>{row.stage === 'completed' ? <Button size="sm" variant="secondary" icon="download" onClick={() => downloadLocalRecords('lab-report', [row])}>Report</Button> : <Button size="sm" variant="primary" onClick={() => updateLocalRecord('labSamples', row.id, { stage: NEXT_LAB_STAGE[row.stage] || 'processing' }, 'Lab sample advanced')}>Advance</Button>}</div>}
          />
        ))}
        {filtered.length === 0 && <LocalEmpty icon="flask" title="No laboratory samples" body="Log a sample to begin the local workflow." />}
      </div>
      <LocalRecordModal open={open} title="Log laboratory sample" fields={fields} submitLabel="Log sample" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('labSamples', { ...values, stage: 'collected' }, 'Laboratory sample logged')} />
    </div>
  );
}

function RadiologyModule() {
  const rows = useLocalRecords('radiologyStudies');
  const [open, setOpen] = useOps(false);
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'study', label: 'Study', required: true },
    { key: 'fileName', label: 'Study file', type: 'file', required: true },
    { key: 'urgency', label: 'Urgency', type: 'select', required: true, options: [['routine', 'Routine'], ['urgent', 'Urgent'], ['stat', 'STAT']] },
  ];
  return (
    <div>
      <PageHead sub="Diagnostics" title="Radiology" action={<Button variant="primary" icon="upload" onClick={() => setOpen(true)}>Upload study</Button>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-200)' }}>
        {rows.map((row) => <QueueRow key={row.id} left={<Icon name="scan" size={20} style={{ color: 'var(--accent)' }} />} title={`${row.study} | ${row.patient}`} sub={`${row.hid} | ${row.fileName}`} right={<Button size="sm" variant="primary" onClick={() => updateLocalRecord('radiologyStudies', row.id, { status: row.status === 'requested' ? 'reporting' : 'completed' }, 'Radiology study updated')}>{row.status === 'requested' ? 'Write report' : 'Complete'}</Button>} />)}
        {rows.length === 0 && <LocalEmpty icon="scan" title="No radiology studies" body="Uploaded study metadata will appear here." />}
      </div>
      <LocalRecordModal open={open} title="Upload radiology study" fields={fields} submitLabel="Add study" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('radiologyStudies', { ...values, status: 'requested' }, 'Radiology study added')} />
    </div>
  );
}

function PharmacyModule() {
  const orders = useLocalRecords('purchaseOrders');
  const [open, setOpen] = useOps(false);
  const fields = [
    { key: 'vendor', label: 'Vendor', required: true },
    { key: 'items', label: 'Items requested', type: 'textarea', required: true },
    { key: 'value', label: 'Estimated value', type: 'number', required: true },
  ];
  return (
    <div>
      <PageHead sub="Diagnostics" title="Pharmacy" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New purchase order</Button>} />
      {orders.length === 0 ? <LocalEmpty icon="pill" title="No pharmacy purchase orders" body="Create an order to add it to this local workspace." /> : <OpsTable cols={['Vendor', 'Items', 'Value', 'Status']}>
        {orders.map((row) => <tr key={row.id} style={OPS_TR}><td style={OPS_TD}>{row.vendor}</td><td style={OPS_TD}>{row.items}</td><td style={OPS_TD}>{formatLocalMoney(row.value)}</td><td style={OPS_TD}><Badge tone="warning">{row.status}</Badge></td></tr>)}
      </OpsTable>}
      <LocalRecordModal open={open} title="New pharmacy purchase order" fields={fields} submitLabel="Create order" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('purchaseOrders', { ...values, category: 'pharmacy', status: 'pending' }, 'Pharmacy purchase order created')} />
    </div>
  );
}

function BillingModule({ autoOpen = false }) {
  const rows = useLocalRecords('invoices');
  const [open, setOpen] = useOps(Boolean(autoOpen));
  const fields = [
    { key: 'hid', label: 'Patient HID', required: true },
    { key: 'patient', label: 'Patient display name', required: true },
    { key: 'description', label: 'Invoice items', type: 'textarea', required: true },
    { key: 'amount', label: 'Amount', type: 'number', required: true },
  ];
  const recorded = rows.filter((row) => row.status === 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const outstanding = rows.filter((row) => row.status !== 'paid').reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return (
    <div>
      <PageHead sub="Operations" title="Billing & Revenue" action={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>New invoice</Button>} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--space-300)', marginBottom: 'var(--space-400)' }}>
        <Card padding="var(--space-400)"><div style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)' }}>{formatLocalMoney(recorded)}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Recorded</div></Card>
        <Card padding="var(--space-400)"><div style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)' }}>{formatLocalMoney(outstanding)}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Outstanding</div></Card>
        <Card padding="var(--space-400)"><div style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)' }}>{rows.length}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Invoices</div></Card>
      </div>
      {rows.length === 0 ? <LocalEmpty icon="receipt" title="No invoices" body="Create an invoice to start recording local billing activity." /> : <OpsTable cols={['Patient', 'HID', 'Amount', 'Status', 'Action']}>
        {rows.map((row) => <tr key={row.id} style={OPS_TR}><td style={OPS_TD}>{row.patient}</td><td style={OPS_TD} className="mono">{row.hid}</td><td style={OPS_TD}>{formatLocalMoney(row.amount)}</td><td style={OPS_TD}><Badge tone={row.status === 'paid' ? 'success' : 'warning'}>{row.status}</Badge></td><td style={OPS_TD}>{row.status === 'paid' ? <Button size="sm" variant="secondary" icon="download" onClick={() => downloadLocalRecords('receipt', [row])}>Receipt</Button> : <Button size="sm" variant="primary" onClick={() => updateLocalRecord('invoices', row.id, { status: 'paid', paidAt: new Date().toISOString() }, 'Payment recorded')}>Record payment</Button>}</td></tr>)}
      </OpsTable>}
      <LocalRecordModal open={open} title="Create invoice" fields={fields} submitLabel="Create invoice" onClose={() => setOpen(false)} onSave={(values) => addLocalRecord('invoices', { ...values, status: 'unpaid' }, 'Invoice created')} />
    </div>
  );
}

function ReportsModule() {
  const patients = useLocalRecords('patients');
  const appointments = useLocalRecords('appointments');
  const invoices = useLocalRecords('invoices');
  const staff = useLocalRecords('staff');
  const incidents = useLocalRecords('incidents');
  const reportRows = [
    ['Patients', patients.length, 'user'],
    ['Appointments', appointments.length, 'calendar'],
    ['Invoices', invoices.length, 'receipt'],
    ['Staff', staff.length, 'users'],
    ['Incidents', incidents.length, 'alert'],
  ];
  return (
    <div>
      <PageHead sub="Operations" title="Reports & Analytics" action={<Button variant="secondary" icon="download" onClick={exportLocalWorkspace}>Export</Button>} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 'var(--space-300)' }}>
        {reportRows.map(([label, count, icon]) => <Card key={label} padding="var(--space-500)"><div style={{ display: 'flex', justifyContent: 'space-between' }}><Icon name={icon} size={20} style={{ color: 'var(--accent)' }} /><span style={{ fontSize: 'var(--fs-h-md)', fontWeight: 'var(--fw-bold)' }}>{count}</span></div><div style={{ marginTop: 'var(--space-300)', color: 'var(--text-strong)', fontWeight: 'var(--fw-semibold)' }}>{label}</div><div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>User-created local records</div></Card>)}
      </div>
      <div style={{ marginTop: 'var(--space-400)', padding: 'var(--space-300)', background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Export downloads the current facility workspace as JSON. Connected environments must authorize and audit exports on the server.</div>
    </div>
  );
}

function SetupModule({ config, onConfigure }) {
  const cfg = config || HOSPITAL_CONFIG;
  const enabledDepts = DEPARTMENTS.filter((dept) => (cfg.departments || []).includes(dept.id));
  return (
    <div>
      <PageHead sub="Administration" title="Hospital Setup" action={<Button variant="primary" icon="building" onClick={onConfigure}>Configure facility</Button>} />
      <Card asArticle padding="var(--space-500)">
        {cfg.name ? <React.Fragment><div style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-bold)', color: 'var(--text-heading)' }}>{cfg.name}</div><div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>{enabledDepts.length} enabled departments</div><div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'var(--space-400)' }}>{enabledDepts.map((dept) => <Badge key={dept.id} tone="info">{dept.label}</Badge>)}</div></React.Fragment> : <LocalEmpty icon="building" title="Facility setup is incomplete" body="Run onboarding to enter facility information." action={<Button variant="primary" onClick={onConfigure}>Start setup</Button>} />}
      </Card>
    </div>
  );
}

function StaffModule({ autoOpen = false }) {
  const rows = useLocalRecords('staff');
  const [open, setOpen] = useOps(Boolean(autoOpen));
  const [editing, setEditing] = useOps(null);
  const fields = [
    { key: 'name', label: 'Full name', required: true },
    { key: 'email', label: 'Work email', type: 'email', required: true },
    { key: 'role', label: 'Role', type: 'select', required: true, options: ROLES.map((role) => [role.label, role.label]) },
    { key: 'dept', label: 'Department', type: 'select', required: true, options: DEPARTMENTS.map((dept) => [dept.label, dept.label]) },
    { key: 'license', label: 'Professional licence', placeholder: 'Optional' },
    { key: 'status', label: 'Status', type: 'select', required: true, options: [['active', 'Active'], ['on-leave', 'On leave'], ['inactive', 'Inactive']] },
  ];
  function save(values) {
    if (editing) updateLocalRecord('staff', editing.id, values, 'Staff record updated');
    else addLocalRecord('staff', values, 'Staff member added');
    setEditing(null);
  }
  return (
    <div>
      <PageHead sub="Administration" title="Staff & Roles" action={<Button variant="primary" icon="user-plus" onClick={() => { setEditing(null); setOpen(true); }}>Add staff</Button>} />
      {rows.length === 0 ? <LocalEmpty icon="users" title="No staff records" body="Add the first staff member for this facility." action={<Button variant="primary" icon="user-plus" onClick={() => setOpen(true)}>Add staff</Button>} /> : <OpsTable cols={['Staff', 'Email', 'Role', 'Department', 'Status', 'Action']}>
        {rows.map((row) => <tr key={row.id} style={OPS_TR}><td style={{ ...OPS_TD, fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{row.name}</td><td style={OPS_TD}>{row.email}</td><td style={OPS_TD}>{row.role}</td><td style={OPS_TD}>{row.dept}</td><td style={OPS_TD}><Badge tone={row.status === 'active' ? 'success' : 'gray'}>{row.status}</Badge></td><td style={OPS_TD}><Button size="sm" variant="secondary" icon="edit" onClick={() => { setEditing(row); setOpen(true); }}>Edit</Button></td></tr>)}
      </OpsTable>}
      <LocalRecordModal open={open} title={editing ? 'Edit staff member' : 'Add staff member'} fields={fields} initialValues={editing || null} submitLabel={editing ? 'Save changes' : 'Add staff'} onClose={() => { setOpen(false); setEditing(null); }} onSave={save} />
    </div>
  );
}

function Tabs({ tabs, active, onTab }) {
  return <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', width: 'fit-content', maxWidth: '100%', overflowX: 'auto' }}>{tabs.map(([id, label]) => <button key={id} onClick={() => onTab(id)} aria-pressed={active === id} style={{ padding: '7px 14px', minHeight: 36, border: 'none', borderRadius: 'var(--radius-sm)', background: active === id ? 'var(--surface)' : 'transparent', color: active === id ? 'var(--text-strong)' : 'var(--text-secondary)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>{label}</button>)}</div>;
}

Object.assign(window, { LabModule, RadiologyModule, PharmacyModule, BillingModule, ReportsModule, SetupModule, StaffModule, Tabs, QueueRow });
