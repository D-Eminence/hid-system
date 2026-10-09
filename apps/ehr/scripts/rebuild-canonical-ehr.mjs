import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ehrDir = path.resolve(scriptDir, '..');
const canonicalPath = path.join(ehrDir, 'ehr.html');
const standalonePath = path.join(ehrDir, 'HID EHR - Standalone.html');
const sourceDir = path.join(ehrDir, 'canonical-src');

const assetIds = {
  primitives: '4b688a88-814f-4e23-9ae1-b0c90e277ea3',
  hospitalData: '993cd6bb-9d3a-4deb-be29-b37d0af3e9b4',
  historyAudit: '3aa9a086-fd6b-427a-b2a3-bfb31a31f1d9',
  hospitalComponents: '9b73f004-605d-4eb1-b62d-f72efe0d69c2',
  auth: '6d23a48f-70e5-44d5-9239-4b42c1705d39',
  shell: 'e33410a0-4ab0-4cff-ac96-3bf44cb4c58a',
  clinical: '403abf73-092b-4c00-9b55-ad9fd2d81b7e',
  operations: '86767d89-418b-4ffe-b548-803d43d8ba66',
  extra: 'aa984828-e286-417f-badb-fcc1a5e94e66',
  dashboards: '0c6d54dd-807c-49a9-975f-a6c2ee0d3ab2',
  data: 'b68bafb0-64b1-4dd3-9865-49862fc01695',
  app: 'e9abeb64-ef31-477e-bdbe-8b5eee4f9b9c',
  setup: 'a4c915af-c804-40f4-afdd-063472d7413b',
};

const html = fs.readFileSync(canonicalPath, 'utf8');
const manifestMatch = html.match(/<script type="__bundler\/manifest">\s*([\s\S]*?)\s*<\/script>/);
if (!manifestMatch) throw new Error('Canonical EHR manifest was not found.');
const manifest = JSON.parse(manifestMatch[1]);

function decode(id) {
  const entry = manifest[id];
  if (!entry) throw new Error(`Missing canonical asset ${id}.`);
  const bytes = Buffer.from(entry.data, 'base64');
  return (entry.compressed ? zlib.gunzipSync(bytes) : bytes).toString('utf8');
}

function encode(id, source) {
  const entry = manifest[id];
  const bytes = Buffer.from(source, 'utf8');
  entry.data = (entry.compressed ? zlib.gzipSync(bytes, { level: 9 }) : bytes).toString('base64');
}

function replaceRequired(source, search, replacement, label) {
  if (typeof replacement === 'string' && source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`Could not update ${label}.`);
  }
  return source.replace(search, replacement);
}

function replaceRegexRequired(source, expression, replacement, label) {
  if (typeof replacement === 'string' && source.includes(replacement)) return source;
  if (!expression.test(source)) {
    throw new Error(`Could not update ${label}.`);
  }
  expression.lastIndex = 0;
  return source.replace(expression, replacement);
}

const localRuntime = String.raw`

// Local reference state. This is facility-scoped browser storage, not production persistence.
const LOCAL_STATE_KEY = 'hid:ehr:local-workspaces:v2';
const LOCAL_SCOPE_KEY = 'hid:ehr:local-facility-scope';
const LOCAL_EVENT = 'hid-ehr-local-state';
const LOCAL_COLLECTIONS = [
  'patients', 'appointments', 'triage', 'admissions', 'emergencyCases', 'maternity', 'surgeries',
  'labSamples', 'radiologyStudies', 'invoices', 'staff', 'shifts', 'incidents', 'claims',
  'purchaseOrders', 'stockItems', 'ambulanceDispatches', 'bloodDonations', 'telemedicineSessions',
  'referrals', 'journeys', 'history', 'notifications', 'audit',
];
let localMemoryRoot = { facilities: {} };

function localScope() {
  try { return localStorage.getItem(LOCAL_SCOPE_KEY) || 'unconfigured-facility'; }
  catch { return 'unconfigured-facility'; }
}

function emptyLocalWorkspace() {
  return LOCAL_COLLECTIONS.reduce((workspace, collection) => { workspace[collection] = []; return workspace; }, {});
}

function readLocalRoot() {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    if (!raw) return localMemoryRoot;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.facilities || typeof parsed.facilities !== 'object') return localMemoryRoot;
    return parsed;
  } catch { return localMemoryRoot; }
}

function readLocalWorkspace() {
  const root = readLocalRoot();
  const stored = root.facilities[localScope()];
  const workspace = emptyLocalWorkspace();
  if (!stored || typeof stored !== 'object') return workspace;
  LOCAL_COLLECTIONS.forEach((collection) => { workspace[collection] = Array.isArray(stored[collection]) ? stored[collection] : []; });
  return workspace;
}

function writeLocalWorkspace(workspace) {
  const root = readLocalRoot();
  root.facilities[localScope()] = workspace;
  localMemoryRoot = root;
  try { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(root)); } catch {}
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT));
}

function setLocalFacilityScope(value) {
  const normalized = String(value || 'unconfigured-facility').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unconfigured-facility';
  try { localStorage.setItem(LOCAL_SCOPE_KEY, normalized); } catch {}
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT));
}

function localId(prefix) {
  const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  return prefix + '-' + id;
}

function auditKind(collection) {
  return ['patients', 'triage', 'admissions', 'emergencyCases', 'maternity', 'surgeries', 'labSamples', 'radiologyStudies', 'history'].includes(collection) ? 'clinical' : 'operations';
}

function addLocalRecord(collection, values, auditAction) {
  const workspace = readLocalWorkspace();
  const record = { ...values, id: values.id || localId(collection), createdAt: values.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  workspace[collection] = [record, ...(workspace[collection] || [])];
  if (collection !== 'audit' && auditAction) workspace.audit = [{ id: localId('audit'), kind: auditKind(collection), action: auditAction, target: values.name || values.patient || values.type || values.vendor || collection, reason: '', icon: auditKind(collection) === 'clinical' ? 'stethoscope' : 'history', tone: 'info', createdAt: new Date().toISOString() }, ...(workspace.audit || [])];
  writeLocalWorkspace(workspace);
  showLocalNotice(auditAction || 'Record saved locally.');
  return record;
}

function updateLocalRecord(collection, id, changes, auditAction) {
  const workspace = readLocalWorkspace();
  workspace[collection] = (workspace[collection] || []).map((record) => record.id === id ? { ...record, ...changes, updatedAt: new Date().toISOString() } : record);
  if (collection !== 'audit' && auditAction) workspace.audit = [{ id: localId('audit'), kind: auditKind(collection), action: auditAction, target: id, reason: '', icon: auditKind(collection) === 'clinical' ? 'stethoscope' : 'history', tone: 'info', createdAt: new Date().toISOString() }, ...(workspace.audit || [])];
  writeLocalWorkspace(workspace);
  showLocalNotice(auditAction || 'Record updated locally.');
}

function addLocalAudit(action, target) {
  const workspace = readLocalWorkspace();
  workspace.audit = [{ id: localId('audit'), kind: 'operations', action, target, reason: '', icon: 'download', tone: 'info', createdAt: new Date().toISOString() }, ...(workspace.audit || [])];
  writeLocalWorkspace(workspace);
}

function useLocalRecords(collection) {
  const [rows, setRows] = React.useState(() => readLocalWorkspace()[collection] || []);
  React.useEffect(() => {
    const refresh = () => setRows(readLocalWorkspace()[collection] || []);
    window.addEventListener(LOCAL_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(LOCAL_EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, [collection]);
  return rows;
}

function downloadLocalRecords(name, rows) {
  try {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name + '-' + new Date().toISOString().slice(0, 10) + '.json';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    addLocalAudit('Data exported', name);
    showLocalNotice('Export downloaded.');
    return true;
  } catch (error) {
    showLocalNotice('Export could not be created in this browser.');
    return false;
  }
}

function exportLocalWorkspace() { downloadLocalRecords('hid-ehr-local-workspace', readLocalWorkspace()); }
function formatLocalDate(value) { if (!value) return 'Not entered'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(); }
function formatLocalMoney(value) { const amount = Number(value || 0); return amount.toLocaleString(); }

function showLocalNotice(message) {
  const existing = document.getElementById('hid-local-notice');
  if (existing) existing.remove();
  const notice = document.createElement('div');
  notice.id = 'hid-local-notice';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  notice.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:min(360px,calc(100vw - 32px));padding:12px 14px;border-radius:8px;background:#17324d;color:#fff;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.22)';
  document.body.appendChild(notice);
  window.setTimeout(() => notice.remove(), 3200);
}

function LocalEmpty({ icon, title, body, action }) { return <EmptyState icon={icon} title={title} body={body} action={action} />; }

function LocalRecordModal({ open, title, fields, initialValues, submitLabel, onClose, onSave }) {
  const blankValues = () => fields.reduce((values, field) => { values[field.key] = initialValues && initialValues[field.key] !== undefined ? initialValues[field.key] : ''; return values; }, {});
  const [values, setValues] = React.useState(blankValues);
  const [error, setError] = React.useState('');
  React.useEffect(() => { if (open) { setValues(blankValues()); setError(''); } }, [open]);
  if (!open) return null;
  function submit() {
    const missing = fields.find((field) => field.required && !String(values[field.key] || '').trim());
    if (missing) { setError(missing.label + ' is required.'); return; }
    onSave(values);
    onClose();
  }
  return <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(15,32,48,.58)', display: 'grid', placeItems: 'center', padding: 16 }}><Card asArticle padding="var(--space-500)" style={{ maxWidth: 560, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 'var(--space-400)' }}><h2 style={{ fontSize: 'var(--fs-h-sm)', color: 'var(--text-heading)' }}>{title}</h2><button type="button" aria-label="Close" onClick={onClose} style={{ width: 40, height: 40, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="x" size={18} /></button></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 'var(--space-300)' }}>{fields.map((field) => <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, gridColumn: field.type === 'textarea' || field.type === 'file' ? '1 / -1' : undefined }}><span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text-strong)' }}>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'select' ? <select value={values[field.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} style={{ padding: '10px 12px', minHeight: 44, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text-strong)' }}><option value="">Select</option>{(field.options || []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === 'textarea' ? <textarea value={values[field.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} rows={4} style={{ padding: '10px 12px', border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)', resize: 'vertical' }} /> : field.type === 'file' ? <input type="file" onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.files && event.target.files[0] ? event.target.files[0].name : '' }))} style={{ padding: 10, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)' }} /> : <input type={field.type || 'text'} value={values[field.key] || ''} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} style={{ padding: '10px 12px', minHeight: 44, border: '1px solid var(--border-control)', borderRadius: 'var(--radius-md)', color: 'var(--text-strong)' }} />}</label>)}</div>{error && <div role="alert" style={{ marginTop: 'var(--space-300)', color: 'var(--danger-500)', fontSize: 'var(--fs-sm)' }}>{error}</div>}<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 'var(--space-500)' }}><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" icon="check" onClick={submit}>{submitLabel || 'Save'}</Button></div></Card></div>;
}
`;

let dataSource = decode(assetIds.data);
dataSource = dataSource.replace('enterprise fixtures + module information architecture', 'module information architecture and empty local state');
dataSource = dataSource.replace('so the demo shows everything until reconfigured', 'so navigation remains available until the facility is configured');
dataSource = replaceRegexRequired(dataSource, /const BRANCHES = \[[\s\S]*?\];/, "const BRANCHES = [{ id: 'main', name: '', city: '' }];", 'default branches');
dataSource = replaceRegexRequired(dataSource, /const STAFF_USER = \{[^\n]*\};/, "const STAFF_USER = { name: '', reg: '', role: 'Hospital Admin', roleKey: 'administrator', initials: 'HA' };", 'default staff user');
dataSource = dataSource.replace(/who: '[^']*', initials: '[^']*'/g, "who: '', initials: ''");
dataSource = replaceRequired(dataSource, "\n];\n\n// ---- module information architecture", "\n];\nROLES.forEach((role) => { role.who = role.label; role.initials = role.label.split(/\\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); });\n\n// ---- module information architecture", 'role display identities');
dataSource = replaceRegexRequired(dataSource, /const HOSPITAL_CONFIG = \{[\s\S]*?\n\};/, "const HOSPITAL_CONFIG = { name: '', type: '', multiBranch: false, departments: [] };", 'hospital config defaults');
const emptyArrays = ['KPIS', 'DASH_QUEUES', 'DEPT_LOAD', 'DASH_NOTICES', 'PATIENTS', 'TRIAGE_QUEUE', 'WARDS', 'APPTS', 'INVOICES', 'REVENUE_SPLIT', 'LAB_QUEUE', 'PHARM_QUEUE', 'INVENTORY_ALERTS', 'REPORTS', 'RAD_REQUESTS', 'SURGERIES', 'ANC', 'EMERGENCY_CASES', 'NOTIFS', 'JOURNEY_PATIENTS', 'SHIFTS', 'ROSTER', 'HR_STAFF', 'QUALITY_KPIS', 'INCIDENTS', 'CLAIMS', 'STOCK_ITEMS', 'PROCUREMENT', 'AMBULANCES', 'BLOOD_STOCK', 'TELE_SESSIONS', 'REFERRALS_OUT'];
for (const name of emptyArrays) dataSource = replaceRegexRequired(dataSource, new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`), `const ${name} = [];`, name);
dataSource = replaceRegexRequired(dataSource, /const INSURANCE_KPIS = \[[^\n]*\];/, 'const INSURANCE_KPIS = [];', 'insurance KPI fixtures');
if (dataSource.includes('const LOCAL_STATE_KEY')) {
  dataSource = replaceRegexRequired(dataSource, /\n\/\/ Local reference state\.[\s\S]*?\n(?=Object\.assign\(window, \{)/, localRuntime + '\n', 'local runtime refresh');
} else {
  dataSource = replaceRequired(dataSource, '\nObject.assign(window, {', localRuntime + '\nObject.assign(window, {', 'local runtime insertion');
}
dataSource = dataSource.replace('URL.revokeObjectURL(url);', 'window.setTimeout(() => URL.revokeObjectURL(url), 1000);');
dataSource = dataSource.replace('function LocalEmpty({ icon, title, body, action }) {\n  return <Card asArticle padding="var(--space-400)"><EmptyState icon={icon} title={title} body={body} action={action} /></Card>;\n}', 'function LocalEmpty({ icon, title, body, action }) { return <EmptyState icon={icon} title={title} body={body} action={action} />; }');
dataSource = dataSource.replace('}, [open, initialValues]);', '}, [open]);');
dataSource = replaceRequired(dataSource, '  FACILITY_TYPES, DEPARTMENTS, CORE_MODULES, CORE_ROLES, TYPE_PRESETS, HOSPITAL_CONFIG, enabledModules, enabledRoleKeys,\n});', '  FACILITY_TYPES, DEPARTMENTS, CORE_MODULES, CORE_ROLES, TYPE_PRESETS, HOSPITAL_CONFIG, enabledModules, enabledRoleKeys,\n  readLocalWorkspace, setLocalFacilityScope, addLocalRecord, updateLocalRecord, useLocalRecords,\n  downloadLocalRecords, exportLocalWorkspace, formatLocalDate, formatLocalMoney, showLocalNotice, LocalEmpty, LocalRecordModal,\n});', 'local runtime exports');
encode(assetIds.data, dataSource);

let hospitalData = decode(assetIds.hospitalData);
hospitalData = hospitalData.replace('Hospital clinical workflow fixtures', 'Hospital clinical workflow contracts without fixture records');
hospitalData = replaceRegexRequired(hospitalData, /const HOSP_NODE = \{[^\n]*\};/, "const HOSP_NODE = { name: '', type: 'HOSPITAL', dept: '' };", 'hospital node fixture');
hospitalData = replaceRegexRequired(hospitalData, /const CLINICIAN = \{[^\n]*\};/, "const CLINICIAN = { name: '', reg: '', role: '' };", 'clinician fixture');
hospitalData = replaceRegexRequired(hospitalData, /const INSTITUTIONS = \[[\s\S]*?\n\];/, 'const INSTITUTIONS = [];', 'institution fixtures');
hospitalData = replaceRegexRequired(hospitalData, /const PATIENT = \{[\s\S]*?\n\};/, "const PATIENT = { name: '', hid: '', age: '', sex: '', allergies: [], medications: [], vitals: {}, recentResults: [] };", 'patient fixture');
for (const name of ['DRUGS', 'LAB_TESTS', 'QUEUE', 'PENDING_RESULTS', 'ALERTS', 'DASH_STATS', 'HISTORY', 'AUDIT']) hospitalData = replaceRegexRequired(hospitalData, new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`), `const ${name} = [];`, name);
encode(assetIds.hospitalData, hospitalData);

let hospitalComponents = decode(assetIds.hospitalComponents);
hospitalComponents = replaceRegexRequired(hospitalComponents, /  const \[hid, setHid\] = useHospState\('[^']+'\);/, "  const [hid, setHid] = useHospState('');", 'access gate HID default');
hospitalComponents = hospitalComponents.replace(/placeholder="HID-[^"]+"/g, 'placeholder="Enter patient HID"');
hospitalComponents = replaceRequired(hospitalComponents, '>AE</div>', '>{(CLINICIAN.name || \'CL\').split(/\\s+/).filter(Boolean).map((part) => part[0]).join(\'\').slice(0, 2).toUpperCase()}</div>', 'clinician initials');
hospitalComponents = hospitalComponents.replace('>NB</div>', '>{(PATIENT.name || \'PT\').split(/\\s+/).filter(Boolean).map((part) => part[0]).join(\'\').slice(0, 2).toUpperCase()}</div>');
hospitalComponents = hospitalComponents.replace('<button style={{ marginLeft: \'auto\'', '<button onClick={() => showLocalNotice(\'Open Activity Log to review access events.\')} style={{ marginLeft: \'auto\'');
encode(assetIds.hospitalComponents, hospitalComponents);

let setup = decode(assetIds.setup);
setup = setup.replace(/placeholder="e\.g\. [^"]+(?:Hospital|Clinic|Facility)[^"]*"/gi, 'placeholder="Enter facility name"');
setup = setup.replace(/placeholder="[^"@]+@(?:hospital|facility)[^"]*"/gi, 'placeholder="name@facility.org"');
setup = replaceRequired(setup, "  const [type, setType] = useWiz(initial.type || 'community');", "  const [type, setType] = useWiz(initial.type || '');", 'facility type default');
setup = replaceRequired(setup, "  const canNext = step !== 0 || (name.trim().length > 1 && phone.trim().length > 5 && email.includes('@'));", "  const canNext = step === 0 ? (name.trim().length > 1 && phone.trim().length > 5 && email.includes('@')) : step === 1 ? Boolean(type) : step === 2 ? depts.length > 0 : true;", 'onboarding step validation');
setup = replaceRegexRequired(setup, /        \{\/\* STEP 7 - Billing \*\/\}[\s\S]*?\n        \)}\n\n        \{\/\* STEP 8 - Review \*\/\}/, "        {/* STEP 7 - Billing */}\n        {step === 6 && (\n          <div>\n            <SectionHeader title=\"Billing & services\" hint=\"Pricing is entered only after an authorized billing service is connected\" />\n            <div style={{ marginTop: 'var(--space-400)' }}><LocalEmpty icon=\"receipt\" title=\"No pricing configured\" body=\"This facility setup does not prefill charges, markups, or procedure prices.\" /></div>\n          </div>\n        )}\n\n        {/* STEP 8 - Review */}", 'billing fixture inputs');
setup = replaceRequired(setup, "onClick={() => onLaunch({ ...initial, name: name || 'New Hospital', phone, email, address, type, multiBranch, departments: depts })}", "onClick={() => onLaunch({ ...initial, name: name.trim(), phone: phone.trim(), email: email.trim(), address: address.trim(), type, multiBranch, departments: depts })}", 'onboarding launch values');
encode(assetIds.setup, setup);

let auth = decode(assetIds.auth);
auth = auth.replace(/const \[email, setEmail\] = useAuthX\('[^']+'\);/, "const [email, setEmail] = useAuthX('');");
auth = auth.replace(/placeholder="[^"@]+@(?:hospital|facility)[^"]*"/gi, 'placeholder="name@facility.org"');
auth = replaceRequired(auth, "<form onSubmit={(e) => { e.preventDefault(); onNext(); }} style={{ marginTop: 'var(--space-600)', display: 'flex', flexDirection: 'column', gap: 'var(--space-300)' }}>", "<form onSubmit={(e) => { e.preventDefault(); if (!email.trim() || !pw) { showLocalNotice('Enter your staff email and password.'); return; } onNext(); }} style={{ marginTop: 'var(--space-600)', display: 'flex', flexDirection: 'column', gap: 'var(--space-300)' }}>", 'login validation');
auth = replaceRequired(auth, '<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@facility.org" style={AUTH_INPUT_X} />', '<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@facility.org" autoComplete="username" required style={AUTH_INPUT_X} />', 'login email input');
auth = replaceRequired(auth, '<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" style={AUTH_INPUT_X} />', '<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" autoComplete="current-password" required style={AUTH_INPUT_X} />', 'login password input');
auth = replaceRequired(auth, '<Button variant="primary" size="lg" fullWidth type="submit" onClick={onNext} style={{ marginTop: \'var(--space-200)\' }}>Sign in</Button>', '<Button variant="primary" size="lg" fullWidth type="submit" style={{ marginTop: \'var(--space-200)\' }}>Sign in</Button>', 'login submit button');
auth = replaceRequired(auth, "<form onSubmit={(e) => { e.preventDefault(); onSent(); }} style={{ marginTop: 'var(--space-600)', display: 'flex', flexDirection: 'column', gap: 'var(--space-300)' }}>", "<form onSubmit={(e) => { e.preventDefault(); if (!email.trim()) { showLocalNotice('Enter the staff email linked to HID Identity.'); return; } onSent(email.trim()); }} style={{ marginTop: 'var(--space-600)', display: 'flex', flexDirection: 'column', gap: 'var(--space-300)' }}>", 'password reset validation');
auth = replaceRequired(auth, '<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" style={AUTH_INPUT_X} />', '<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email address" autoComplete="email" required style={AUTH_INPUT_X} />', 'password reset email input');
auth = replaceRequired(auth, '<Button variant="primary" size="lg" fullWidth type="submit" onClick={onSent} style={{ marginTop: \'var(--space-200)\' }}>Send OTP</Button>', '<Button variant="primary" size="lg" fullWidth type="submit" style={{ marginTop: \'var(--space-200)\' }}>Send OTP</Button>', 'password reset submit button');
encode(assetIds.auth, auth);

let primitives = decode(assetIds.primitives);
if (primitives.includes("disabled = false, type, title, style")) {
  primitives = primitives.replace("disabled = false, type, title, style", "disabled = false, type = 'button', title, style");
} else {
  primitives = replaceRequired(primitives, "const Button = ({ variant = 'primary', size = 'md', icon, children, fullWidth, loading, onClick, ariaLabel, style }) => {", "const Button = ({ variant = 'primary', size = 'md', icon, children, fullWidth, loading, onClick, ariaLabel, disabled = false, type = 'button', title, style }) => {", 'button properties');
}
primitives = replaceRequired(primitives, '      onClick={onClick}\n      aria-label={ariaLabel}\n      aria-busy={loading || undefined}', "      type={type}\n      onClick={onClick || ((event) => { if (!event.currentTarget.form) showLocalNotice('This action requires a connected service.'); })}\n      disabled={disabled || loading}\n      title={title}\n      aria-label={ariaLabel}\n      aria-busy={loading || undefined}", 'button fallback action');
primitives = replaceRequired(primitives, "        width: fullWidth ? '100%' : undefined, whiteSpace: 'nowrap', transition: 'background var(--dur-fast) var(--ease-standard)',", "        width: fullWidth ? '100%' : undefined, whiteSpace: 'nowrap', transition: 'background var(--dur-fast) var(--ease-standard)',\n        cursor: disabled || loading ? 'not-allowed' : 'pointer', opacity: disabled || loading ? 0.55 : 1,", 'button disabled styling');
encode(assetIds.primitives, primitives);

let shell = decode(assetIds.shell);
shell = replaceRequired(shell, "  const [openRole, setOpenRole] = useShell(false);", "  const [openRole, setOpenRole] = useShell(false);\n  const patients = useLocalRecords('patients');\n  const notifications = useLocalRecords('notifications');", 'shell local collections');
shell = replaceRequired(shell, "  const who = role ? role.who : STAFF_USER.name;\n  const initials = role ? role.initials : STAFF_USER.initials;", "  const who = role ? role.label : STAFF_USER.role;\n  const initials = who.split(/\\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();", 'shell user display');
shell = replaceRequired(shell, "  const matches = q ? PATIENTS.filter((p) => (p.name + p.hid + p.phone).toLowerCase().includes(q.toLowerCase())) : PATIENTS.slice(0, 4);", "  const matches = q ? patients.filter((p) => (p.name + p.hid + (p.phone || '')).toLowerCase().includes(q.toLowerCase())) : patients.slice(0, 4);", 'shell patient search');
shell = shell.replace(/\{branch\.name\.replace\([^}]+\)\}/g, '{branch.name}');
shell = replaceRequired(shell, '{BRANCHES.map((b) =>', '{[branch].map((b) =>', 'shell branches');
shell = replaceRequired(shell, '<Icon name="bell" size={18} /><span style={{ position: \'absolute\', top: 6, right: 7, width: 8, height: 8, borderRadius: \'50%\', background: \'var(--danger-500)\', border: \'1.5px solid var(--surface)\' }} />', '<Icon name="bell" size={18} />{notifications.length > 0 && <span style={{ position: \'absolute\', top: 6, right: 7, width: 8, height: 8, borderRadius: \'50%\', background: \'var(--danger-500)\', border: \'1.5px solid var(--surface)\' }} />}', 'notification indicator');
shell = replaceRequired(shell, '<span style={{ fontSize: 11, color: \'var(--text-link)\', fontWeight: \'var(--fw-semibold)\' }}>Mark all read</span>', '<span style={{ fontSize: 11, color: \'var(--text-secondary)\' }}>{notifications.length} unread</span>', 'notification summary');
shell = shell.replace('{NOTIFS.map((n, i) =>', '{notifications.map((n, i) =>');
shell = replaceRegexRequired(shell, /\n      \{\/\* shift indicator \*\/\}[\s\S]*?\n      \{\/\* role switcher/, '\n      {/* role switcher', 'hardcoded shift indicator');
shell = replaceRequired(shell, '{r.who} · {r.focus}', '{r.focus}', 'role fixture identity');
shell = replaceRequired(shell, '<DropItem onClick={() => {}}>Profile &amp; security</DropItem>', "<DropItem onClick={() => { setOpenMenu(false); showLocalNotice('Profile and security require the connected Identity service.'); }}>Profile &amp; security</DropItem>", 'profile action');
shell = replaceRegexRequired(shell, /function EhrDashboard\([\s\S]*?\n\}\n\nObject\.assign/, "function EhrDashboard({ onNav }) {\n  const patients = useLocalRecords('patients');\n  const appointments = useLocalRecords('appointments');\n  return <div><PageHead sub=\"Workspace\" title=\"EHR Dashboard\" action={<Button variant=\"primary\" icon=\"user-plus\" onClick={() => onNav('patients')}>Add existing HID patient</Button>} /><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 'var(--space-400)' }}><Card padding=\"var(--space-500)\"><div style={{ fontSize: 'var(--fs-h-md)', fontWeight: 'var(--fw-bold)' }}>{patients.length}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Patients</div></Card><Card padding=\"var(--space-500)\"><div style={{ fontSize: 'var(--fs-h-md)', fontWeight: 'var(--fw-bold)' }}>{appointments.length}</div><div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Appointments</div></Card></div></div>;\n}\n\nObject.assign", 'fallback dashboard fixtures');
encode(assetIds.shell, shell);

let app = decode(assetIds.app);
if (!app.includes("setLocalFacilityScope(config.name || 'unconfigured-facility')")) {
  app = replaceRequired(app, "  const [role, setRole] = useEhr(ROLES.find((r) => r.key === 'consultant'));", "  const [role, setRole] = useEhr(ROLES.find((r) => r.key === 'administrator'));", 'default role');
  app = replaceRequired(app, '  const [cPatient, setCPatient] = useEhr(PATIENTS[0]);', '  const [cPatient, setCPatient] = useEhr(null);', 'default consultation patient');
  app = replaceRequired(app, "  // dynamic generation: which modules & roles exist for THIS facility", "  useEhrFx(() => { setLocalFacilityScope(config.name || 'unconfigured-facility'); }, [config.name]);\n\n  // dynamic generation: which modules & roles exist for THIS facility", 'facility local scope');
  app = app.replaceAll("BRANCHES[0].city", "(BRANCHES[0] && BRANCHES[0].city) || ''");
  app = app.replaceAll("{ ...BRANCHES[0],", "{ ...(BRANCHES[0] || { id: 'main', name: 'Facility', city: '' }),");
  app = replaceRequired(app, "    case 'consult': content = <ConsultModule", "    case 'consult': if (!cPatient) { content = <LocalEmpty icon=\"user\" title=\"Select a patient first\" body=\"Open Patients and choose an existing HID patient before starting a consultation.\" />; break; } content = <ConsultModule", 'empty consultation state');
}
app = replaceRegexRequired(app, /function PatientPortalView\(\) \{[\s\S]*?\n\}\n\nfunction GenericDept/, "function PatientPortalView() {\n  return <LocalEmpty icon=\"user\" title=\"Patient portal is not stored in the EHR\" body=\"Open HID Identity for patient-controlled profile, sharing, and access requests.\" />;\n}\n\nfunction GenericDept", 'patient portal fixture removal');
app = replaceRequired(app, "  const [setupMode, setSetupMode] = useEhr(false); // true = run the wizard", "  const [setupMode, setSetupMode] = useEhr(false); // true = run the wizard\n  const [moduleAction, setModuleAction] = useEhr(null);", 'dashboard action state');
app = replaceRequired(app, "  function goNav(id) { setNav(id); setSetupMode(false); if (id === 'consult') setCStage('pick'); }", "  function goNav(id, action = null) {\n    if (action === 'export') { exportLocalWorkspace(); return; }\n    setModuleAction(action);\n    setNav(id);\n    setSetupMode(action === 'configure');\n    if (id === 'consult') setCStage('pick');\n  }", 'dashboard action routing');
app = replaceRequired(app, "    setConfig(cfg); setBranch({ ...(BRANCHES[0] || { id: 'main', name: 'Facility', city: '' }), name: `${cfg.name || 'Hospital'} - Main`, city: cfg.address || (BRANCHES[0] && BRANCHES[0].city) || '' }); setSetupMode(false);", "    const primaryBranch = (cfg.branches && cfg.branches[0]) || {};\n    setConfig(cfg); setBranch({ ...(BRANCHES[0] || { id: 'main', name: '', city: '' }), ...primaryBranch, name: primaryBranch.name || cfg.name || '', city: primaryBranch.city || primaryBranch.address || cfg.address || '' }); setSetupMode(false);", 'configured branch context');
app = replaceRequired(app, "    setConfig({ ...HOSPITAL_CONFIG, name: profile.facilityName, phone: profile.phone, email: profile.email, administrator: profile.adminName, type: 'community', multiBranch: false, departments: (TYPE_PRESETS.community || []).slice() });", "    setConfig({ ...HOSPITAL_CONFIG, name: profile.facilityName, phone: profile.phone, email: profile.email, administrator: profile.adminName, type: '', multiBranch: false, departments: [] });", 'signup configuration defaults');
app = replaceRequired(app, "    setBranch({ ...(BRANCHES[0] || { id: 'main', name: 'Facility', city: '' }), name: `${cfg.name || 'Hospital'} - Main`, city: cfg.address || (BRANCHES[0] && BRANCHES[0].city) || '' });", "    const primaryBranch = (cfg.branches && cfg.branches[0]) || {};\n    setBranch({ ...(BRANCHES[0] || { id: 'main', name: '', city: '' }), ...primaryBranch, name: primaryBranch.name || cfg.name || '', city: primaryBranch.city || primaryBranch.address || cfg.address || '' });", 'onboarded branch context');
app = replaceRequired(app, "  if (phase === 'forgot') return <EhrForgot onBack={() => setPhase('login')} onSent={() => setPhase('login')} onSignup={() => setPhase('signup')} />;", "  if (phase === 'forgot') return <EhrForgot onBack={() => setPhase('login')} onSent={() => showLocalNotice('Password reset requires the connected HID Identity service.')} onSignup={() => setPhase('signup')} />;", 'password reset feedback');
app = replaceRequired(app, "    case 'patients': content = <PatientsModule onOpenPatient={openPatientFromSearch} />; break;", "    case 'patients': content = <PatientsModule onOpenPatient={openPatientFromSearch} autoOpen={moduleAction === 'create'} />; break;", 'patient quick action');
app = replaceRequired(app, "    case 'appointments': content = <AppointmentsModule />; break;", "    case 'appointments': content = <AppointmentsModule autoOpen={moduleAction === 'create'} />; break;", 'appointment quick action');
app = replaceRequired(app, "    case 'lab': content = <LabModule />; break;", "    case 'lab': content = <LabModule autoOpen={moduleAction === 'create'} />; break;", 'laboratory quick action');
app = replaceRequired(app, "    case 'billing': content = <BillingModule />; break;", "    case 'billing': content = <BillingModule autoOpen={moduleAction === 'create'} />; break;", 'billing quick action');
app = replaceRequired(app, "    case 'referrals': content = <ReferralsModule />; break;", "    case 'referrals': content = <ReferralsModule autoOpen={moduleAction === 'create'} />; break;", 'referral quick action');
app = replaceRequired(app, "    case 'staff': content = <StaffModule />; break;", "    case 'staff': content = <StaffModule autoOpen={moduleAction === 'create'} />; break;", 'staff quick action');
app = replaceRequired(app, "    case 'quality': content = <QualityModule />; break;", "    case 'quality': content = <QualityModule autoOpen={moduleAction === 'create'} />; break;", 'incident quick action');
encode(assetIds.app, app);

for (const [id, file] of [
  [assetIds.operations, 'ehr-ops.jsx'],
  [assetIds.extra, 'ehr-extra.jsx'],
  [assetIds.dashboards, 'ehr-dashboards.jsx'],
  [assetIds.clinical, 'ehr-clinical.jsx'],
  [assetIds.historyAudit, 'hospital-history-audit.jsx'],
]) encode(id, fs.readFileSync(path.join(sourceDir, file), 'utf8'));

const manifestJson = JSON.stringify(manifest);
const updatedHtml = html.slice(0, manifestMatch.index) + manifestMatch[0].replace(manifestMatch[1], manifestJson) + html.slice(manifestMatch.index + manifestMatch[0].length);
fs.writeFileSync(canonicalPath, updatedHtml);
fs.writeFileSync(standalonePath, updatedHtml);
console.log('Canonical EHR bundle rebuilt with empty facility-scoped local state.');
