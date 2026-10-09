// hospital-history-audit.jsx - patient history and local activity log
const { useState: useHA } = React;

const HIST_FILTERS = [['all', 'All'], ['visit', 'Visits'], ['rx', 'Prescriptions'], ['lab', 'Labs'], ['vaccine', 'Vaccines']];
const AUDIT_FILTERS = [['all', 'All activity'], ['break_glass', 'Break glass'], ['access', 'Access'], ['clinical', 'Clinical'], ['operations', 'Operations']];

function FilterButtons({ rows, active, onChange }) {
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{rows.map(([id, label]) => <button key={id} onClick={() => onChange(id)} aria-pressed={active === id} style={{ padding: '6px 14px', minHeight: 36, borderRadius: 'var(--radius-pill)', border: `1px solid ${active === id ? 'var(--accent)' : 'var(--border-default)'}`, background: active === id ? 'var(--accent)' : 'var(--surface)', color: active === id ? 'var(--text-on-accent)' : 'var(--text-strong)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)' }}>{label}</button>)}</div>;
}

function PatientHistory({ expiresAt, onBack }) {
  const history = useLocalRecords('history');
  const [filter, setFilter] = useHA('all');
  const rows = history.filter((row) => filter === 'all' || row.kind === filter);
  return <div><PatientHeader expiresAt={expiresAt} /><div style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-500)' }}><button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', marginBottom: 'var(--space-400)' }}><Icon name="arrowLeft" size={16} /> Back to consultation</button><h1 style={{ fontSize: 'var(--fs-h-sm)', fontWeight: 'var(--fw-bold)', color: 'var(--text-heading)', marginBottom: 'var(--space-400)' }}>Clinical history</h1><FilterButtons rows={HIST_FILTERS} active={filter} onChange={setFilter} /><div style={{ marginTop: 'var(--space-400)' }}>{rows.length === 0 ? <LocalEmpty icon="history" title="No clinical history" body="No user-created history is available in this local workspace." /> : rows.map((row) => <Card key={row.id} asArticle padding="var(--space-400)" style={{ marginBottom: 8 }}><div style={{ fontWeight: 'var(--fw-semibold)' }}>{row.title}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>{row.detail}</div></Card>)}</div></div></div>;
}

function ActivityLog() {
  const audit = useLocalRecords('audit');
  const [filter, setFilter] = useHA('all');
  const rows = audit.filter((row) => filter === 'all' || row.kind === filter);
  return <div style={{ maxWidth: 900, margin: '0 auto' }}><PageHead sub="Administration" title="Activity Log" action={<Button variant="secondary" icon="download" onClick={() => downloadLocalRecords('activity-log', audit)}>Export</Button>} /><p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-400)' }}>This browser workspace records local actions. Connected environments must enforce immutable audit on the server.</p><FilterButtons rows={AUDIT_FILTERS} active={filter} onChange={setFilter} /><div style={{ marginTop: 'var(--space-400)', display: 'flex', flexDirection: 'column', gap: 'var(--space-200)' }}>{rows.length === 0 ? <LocalEmpty icon="history" title="No matching activity" body="Actions completed in this facility workspace will appear here." /> : rows.map((row) => <Card key={row.id} asArticle padding="var(--space-300) var(--space-400)"><div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-300)' }}><span style={{ width: 36, height: 36, borderRadius: 'var(--radius-pill)', background: row.tone === 'danger' ? 'var(--danger-50)' : 'var(--primary-50)', color: row.tone === 'danger' ? 'var(--danger-500)' : 'var(--accent)', display: 'grid', placeItems: 'center' }}><Icon name={row.icon || 'history'} size={17} /></span><div style={{ flex: 1 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{row.action}</span><span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{formatLocalDate(row.createdAt)}</span></div><div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-body)', marginTop: 3 }}>{row.target}</div>{row.reason && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{row.reason}</div>}</div></div></Card>)}</div></div>;
}

Object.assign(window, { PatientHistory, ActivityLog });
