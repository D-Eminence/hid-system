// ehr-dashboards.jsx - role-aware dashboards derived from local records

function Hello({ who, sub, action }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-400)', flexWrap: 'wrap', marginBottom: 'var(--space-600)' }}><div style={{ minWidth: 0 }}><h1 style={{ fontSize: 'var(--fs-h-md)', fontWeight: 'var(--fw-bold)', color: 'var(--text-heading)', lineHeight: 1.15 }}>{who}</h1><p style={{ fontSize: 'var(--fs-md)', color: 'var(--text-secondary)', marginTop: 'var(--space-200)' }}>{sub}</p></div>{action}</div>;
}

function StatCards({ items }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(212px,1fr))', gap: 'var(--space-400)', marginBottom: 'var(--space-600)' }}>{items.map((item) => <Card key={item.label} padding="var(--space-500)"><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{item.label}</span><Icon name={item.icon} size={18} style={{ color: 'var(--accent)' }} /></div><div style={{ fontSize: 'var(--fs-h-md)', fontWeight: 'var(--fw-bold)', color: 'var(--text-heading)', marginTop: 'var(--space-300)' }}>{item.value}</div><div style={{ marginTop: 'var(--space-300)', padding: '8px 10px', background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{item.foot}</div></Card>)}</div>;
}

function DashboardAction({ icon, title, sub, onClick }) {
  return <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)', width: '100%', padding: 'var(--space-300) var(--space-400)', textAlign: 'left', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--surface)' }}><span style={{ width: 36, height: 36, borderRadius: 'var(--radius-md)', background: 'var(--primary-50)', color: 'var(--accent-hover)', display: 'grid', placeItems: 'center' }}><Icon name={icon} size={18} /></span><span style={{ flex: 1, minWidth: 0 }}><span style={{ display: 'block', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{title}</span><span style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</span></span><Icon name="chevron" size={16} style={{ color: 'var(--text-secondary)' }} /></button>;
}

const ROLE_ACTIONS = {
  platform_admin: [['building', 'Configure facility', 'setup', 'configure'], ['users', 'Manage staff', 'staff'], ['download', 'Export reports', 'reports', 'export'], ['history', 'Review audit', 'audit']],
  owner: [['receipt', 'Open billing', 'billing'], ['users', 'Review staff', 'staff'], ['download', 'Export reports', 'reports', 'export'], ['building', 'Facility setup', 'setup', 'configure']],
  medical_director: [['alert', 'Review incidents', 'quality'], ['history', 'Review audit', 'audit'], ['users', 'Review staff', 'staff'], ['route', 'Patient journeys', 'journey']],
  administrator: [['user-plus', 'Add staff', 'staff', 'create'], ['alert', 'Report incident', 'quality', 'create'], ['clock', 'Manage shifts', 'shifts'], ['download', 'Export reports', 'reports', 'export']],
  receptionist: [['user-plus', 'Add existing HID patient', 'patients', 'create'], ['calendar', 'Book appointment', 'appointments', 'create'], ['route', 'Patient journeys', 'journey']],
  records: [['search', 'Find patient', 'patients'], ['history', 'Review audit', 'audit'], ['download', 'Export reports', 'reports', 'export']],
  consultant: [['search', 'Find patient', 'patients'], ['stethoscope', 'Start consultation', 'consult'], ['flask', 'Laboratory', 'lab'], ['share', 'Create referral', 'referrals', 'create']],
  doctor: [['search', 'Find patient', 'patients'], ['stethoscope', 'Start consultation', 'consult'], ['flask', 'Laboratory', 'lab'], ['share', 'Create referral', 'referrals', 'create']],
  nurse: [['activity', 'Open triage', 'triage'], ['bed', 'Open wards', 'inpatient'], ['heart', 'Maternity', 'maternity']],
  lab_manager: [['flask', 'Log sample', 'lab', 'create'], ['scan', 'Radiology', 'radiology'], ['download', 'Export reports', 'reports', 'export']],
  lab: [['flask', 'Log sample', 'lab', 'create'], ['scan', 'Radiology', 'radiology']],
  pharmacy_manager: [['pill', 'Open pharmacy', 'pharmacy'], ['box', 'Inventory', 'inventory'], ['download', 'Export reports', 'reports', 'export']],
  pharmacist: [['pill', 'Open pharmacy', 'pharmacy'], ['box', 'Inventory', 'inventory']],
  billing: [['receipt', 'Create invoice', 'billing', 'create'], ['shield', 'Insurance claims', 'insurance'], ['download', 'Export reports', 'reports', 'export']],
  cashier: [['receipt', 'Open invoices', 'billing'], ['download', 'Export reports', 'reports', 'export']],
};

function RoleDashboard({ role, onNav, config }) {
  const patients = useLocalRecords('patients');
  const appointments = useLocalRecords('appointments');
  const staff = useLocalRecords('staff');
  const incidents = useLocalRecords('incidents');
  const audit = useLocalRecords('audit');
  const actions = ROLE_ACTIONS[role?.key] || ROLE_ACTIONS.administrator;
  const facilityName = config?.name || 'Facility workspace';
  const openIncidents = incidents.filter((row) => row.status !== 'closed').length;
  const items = [
    { label: 'Patients', value: patients.length, icon: 'user', foot: 'User-created local records' },
    { label: 'Appointments', value: appointments.length, icon: 'calendar', foot: 'Current local workspace' },
    { label: 'Staff', value: staff.length, icon: 'users', foot: 'Facility-scoped records' },
    { label: 'Open incidents', value: openIncidents, icon: 'alert', foot: 'Quality review queue' },
  ];
  return <div><Hello who={role?.label || 'EHR workspace'} sub={facilityName} action={<Button variant="primary" icon={actions[0][0]} onClick={() => onNav(actions[0][2], actions[0][3])}>{actions[0][1]}</Button>} /><StatCards items={items} />
    <div className="ehr-cols" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 'var(--space-500)', alignItems: 'start' }}>
      <Card asArticle padding="var(--space-500)"><SectionHeader title="Quick actions" /><div style={{ marginTop: 'var(--space-300)', display: 'flex', flexDirection: 'column', gap: 'var(--space-200)' }}>{actions.map(([icon, label, target, action]) => <DashboardAction key={label} icon={icon} title={label} sub={action === 'export' ? 'Download facility workspace data' : action === 'create' ? `Open ${label.toLowerCase()} form` : `Open ${label.toLowerCase()}`} onClick={() => onNav(target, action)} />)}</div></Card>
      <Card asArticle padding="var(--space-500)"><SectionHeader title="Recent local activity" hint={`${audit.length} events`} />{audit.length === 0 ? <LocalEmpty icon="history" title="No activity yet" body="Actions completed in this local workspace will appear here." /> : <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'var(--space-300)' }}>{audit.slice(0, 5).map((row) => <div key={row.id} style={{ padding: 'var(--space-300)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}><div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{row.action}</div><div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 3 }}>{row.target} | {formatLocalDate(row.createdAt)}</div></div>)}</div>}</Card>
    </div>
  </div>;
}

Object.assign(window, { RoleDashboard });
