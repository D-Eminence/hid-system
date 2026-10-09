import React, { useState } from 'react';

// ---------------------------------------------------------------------------
// IconName union - covers all SVG icons in the system
// ---------------------------------------------------------------------------

export type IconName =
  | 'home' | 'users' | 'user' | 'clipboard' | 'activity' | 'flask' | 'pill'
  | 'dollar' | 'barChart' | 'settings' | 'search' | 'bell' | 'plus' | 'x' | 'check'
  | 'arrowLeft' | 'arrowRight' | 'chevronDown' | 'chevronRight' | 'chevronLeft'
  | 'edit' | 'trash' | 'eye' | 'lock' | 'logOut' | 'calendar' | 'clock' | 'heart'
  | 'alertTriangle' | 'info' | 'fileText' | 'map' | 'truck' | 'shield' | 'phone'
  | 'package' | 'droplet' | 'zap' | 'star' | 'building' | 'grid' | 'list' | 'refresh'
  | 'download' | 'upload' | 'printer' | 'share' | 'more' | 'layers' | 'crosshair'
  | 'wind' | 'thermometer' | 'scissors' | 'syringe' | 'activity2' | 'stethoscope' | 'bed'
  | 'ambulance' | 'award' | 'trendUp' | 'trendDown';

const ICON_PATHS: Record<IconName, string> = {
  home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  flask: 'M10 2v7.31 M14 9.3V2 M8.5 2h7 M14 9.3a6.5 6.5 0 1 1-4 0',
  pill: 'M10.5 20.5 20.5 10.5a4.243 4.243 0 0 0-6-6L4.5 14.5a4.243 4.243 0 0 0 6 6z M8.5 8.5l7 7',
  dollar: 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  barChart: 'M12 20V10 M18 20V4 M6 20v-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  search: 'M11 17.25a6.25 6.25 0 1 1 0-12.5 6.25 6.25 0 0 1 0 12.5z M16 16l4.5 4.5',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0',
  plus: 'M12 5v14 M5 12h14',
  x: 'M18 6 6 18 M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  arrowLeft: 'M19 12H5 M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14 M12 5l7 7-7 7',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z M7 11V7a5 5 0 0 1 10 0v4',
  logOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  calendar: 'M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  alertTriangle: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 8h.01 M12 12v4',
  fileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
  map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z M8 2v16 M16 6v16',
  truck: 'M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M18.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.18 2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6A16 16 0 0 0 15.4 16.1l.96-.87a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 23 17.5v-.58z',
  package: 'M16.5 9.4 7.55 4.24 M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05 M12 22.08V12',
  droplet: 'M12 2L6.5 15.5a5.5 5.5 0 0 0 11 0L12 2z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  building: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  refresh: 'M23 4v6h-6 M1 20v-6h6 M3.51 9a9 9 0 0 1 14.85-3.36L23 10 M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12',
  printer: 'M6 9V2h12v7 M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2 M6 14h12v8H6z',
  share: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8 M16 6l-4-4-4 4 M12 2v13',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  layers: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  crosshair: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M22 12h-4 M6 12H2 M12 6V2 M12 22v-4',
  wind: 'M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2',
  thermometer: 'M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z',
  scissors: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M20 4L8.12 15.88 M14.47 14.48L20 20 M8.12 8.12L12 12',
  syringe: 'M18 2l4 4 M17 7l-1-1M5 20l-3 3 M10 10l-7 7M13.5 6.5l4 4-5.5 5.5-4-4',
  activity2: 'M22 12h-4l-3 9L9 3l-3 9H2',
  stethoscope: 'M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3 M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4',
  bed: 'M3 17v-3a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v3 M1 17h22 M3 21v-4 M21 21v-4 M7 10V7 M17 10V7',
  ambulance: 'M10 10v-4h4v4h4v4H6v-4h4z M3 14v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3 M1 14h22 M4 14V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8',
  award: 'M12 15a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M8.21 13.89L7 23l5-3 5 3-1.21-9.12',
  trendUp: 'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  trendDown: 'M23 18l-9.5-9.5-5 5L1 6 M17 18h6v-6',
};

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, className = '', style }) => {
  const d = ICON_PATHS[name] ?? ICON_PATHS.more;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
    >
      {d.split(' M').map((seg, i) => (
        <path key={i} d={(i === 0 ? '' : 'M') + seg} />
      ))}
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  className = '',
  style,
  type = 'button',
  ...rest
}) => {
  const cls = ['hid-btn', `hid-btn-${variant}`, `hid-btn-${size}`, fullWidth ? 'w-full' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      style={{ width: fullWidth ? '100%' : undefined, ...style }}
      {...rest}
    >
      {loading ? (
        <span className="ehr-spinner" style={{ width: 14, height: 14 }} />
      ) : (
        icon && <Icon name={icon} size={14} />
      )}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={14} />}
    </button>
  );
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  pad?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', style = {}, onClick, pad = true }) => (
  <div
    className={['hid-card', pad ? 'hid-card-pad' : '', className].filter(Boolean).join(' ')}
    style={{ cursor: onClick ? 'pointer' : undefined, ...style }}
    onClick={onClick}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

interface BadgeProps {
  children: React.ReactNode;
  variant?: string;
  icon?: IconName;
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'blue', icon }) => (
  <span className={`hid-badge hid-badge-${variant}`}>
    {icon && <Icon name={icon} size={10} />}
    {children}
  </span>
);

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

interface SpinnerProps { size?: number; }

export const Spinner: React.FC<SpinnerProps> = ({ size = 20 }) => (
  <span className="ehr-spinner" style={{ width: size, height: size }} />
);

// ---------------------------------------------------------------------------
// PageLoader
// ---------------------------------------------------------------------------

interface PageLoaderProps { label?: string; }

export const PageLoader: React.FC<PageLoaderProps> = ({ label = 'Loading...' }) => (
  <div className="ehr-page-loader">
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-400)' }}>
      <Spinner size={32} />
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  style?: React.CSSProperties;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width = '100%',
  height = 16,
  radius = 'var(--radius-md)',
  style = {},
}) => (
  <div
    style={{
      width,
      height,
      borderRadius: radius,
      background: 'var(--neutral-200)',
      animation: 'skeletonPulse 1.5s ease-in-out infinite',
      ...style,
    }}
  />
);

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  icon?: IconName;
  title?: string;
  sub?: string;
  action?: React.ReactNode;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon = 'list', title = 'Nothing here', sub = '', action }) => (
  <div className="ehr-empty">
    <div className="ehr-empty-icon">
      <Icon name={icon} size={24} />
    </div>
    <div>
      <div className="ehr-empty-title">{title}</div>
      {sub && <div className="ehr-empty-sub">{sub}</div>}
    </div>
    {action && <div>{action}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  title: string;
  action?: React.ReactNode;
  sub?: string;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({ title, action, sub }) => (
  <div className="hid-section-header">
    <div>
      <div className="hid-section-title">{title}</div>
      {sub && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>}
    </div>
    {action && <div>{action}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// ErrorState
// ---------------------------------------------------------------------------

interface ErrorStateProps {
  title?: string;
  message?: string;
  retry?: () => void;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ title = 'Something went wrong', message, retry }) => (
  <div className="ehr-empty">
    <div className="ehr-empty-icon" style={{ background: 'var(--danger-50)', color: 'var(--danger-badge-text)' }}>
      <Icon name="alertTriangle" size={24} />
    </div>
    <div>
      <div className="ehr-empty-title">{title}</div>
      {message && <div className="ehr-empty-sub">{message}</div>}
    </div>
    {retry && <Button variant="secondary" size="sm" onClick={retry} icon="refresh">Try again</Button>}
  </div>
);

// ---------------------------------------------------------------------------
// PageHead
// ---------------------------------------------------------------------------

interface PageHeadProps {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}

export const PageHead: React.FC<PageHeadProps> = ({ title, sub, actions }) => (
  <div className="ehr-page-head fade-in">
    <div>
      <h1 className="ehr-page-head-title">{title}</h1>
      {sub && <div className="ehr-page-head-sub">{sub}</div>}
    </div>
    {actions && <div className="ehr-page-head-actions">{actions}</div>}
  </div>
);

// ---------------------------------------------------------------------------
// KPICard
// ---------------------------------------------------------------------------

interface KPICardProps {
  label: string;
  value: string | number;
  icon?: IconName;
  footer?: string;
  trend?: number;
}

export const KPICard: React.FC<KPICardProps> = ({ label, value, icon, footer, trend }) => (
  <div className="ehr-kpi-card">
    <div className="ehr-kpi-header">
      <span className="ehr-kpi-label">{label}</span>
      <div className="ehr-kpi-icon">
        <Icon name={icon ?? 'barChart'} size={16} />
      </div>
    </div>
    <div className="ehr-kpi-value">{value}</div>
    {(footer || trend !== undefined) && (
      <div className="ehr-kpi-footer" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-200)' }}>
        {trend !== undefined && (
          <span style={{ color: trend > 0 ? 'var(--accent)' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 2, fontSize: 'var(--fs-caption)', fontWeight: 600 }}>
            <Icon name={trend > 0 ? 'trendUp' : 'trendDown'} size={12} />
            {Math.abs(trend)}%
          </span>
        )}
        {footer && <span>{footer}</span>}
      </div>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

interface StatusProps {
  status: string;
  label?: string;
}

export const Status: React.FC<StatusProps> = ({ status, label }) => {
  const map: Record<string, string> = {
    active: 'active', admitted: 'active', open: 'active', dispensed: 'active', paid: 'active',
    pending: 'pending', processing: 'pending', 'in-progress': 'pending', checked_in: 'pending',
    critical: 'critical', emergency: 'critical', overdue: 'critical', rejected: 'critical',
    inactive: 'inactive', discharged: 'inactive', closed: 'inactive', cancelled: 'inactive',
  };
  const cls = map[status] ?? 'inactive';
  return <span className={`ehr-status ehr-status-${cls}`}>{label ?? status}</span>;
};

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalProps {
  open: boolean;
  onClose?: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  danger?: boolean;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, title, children, footer, wide = false, danger = false }) => {
  if (!open) return null;

  const handleScrim = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <div className="hid-modal-scrim" onClick={handleScrim}>
      <div
        className={['hid-modal', danger ? 'hid-breakglass-modal' : ''].filter(Boolean).join(' ')}
        style={{ maxWidth: wide ? 760 : 560 }}
      >
        {title && (
          <div className={['hid-modal-head', danger ? 'hid-breakglass-head' : ''].filter(Boolean).join(' ')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-300)' }}>
              {danger && (
                <div className="hid-breakglass-icon">
                  <Icon name="alertTriangle" size={18} />
                </div>
              )}
              <span className="hid-modal-title">{title}</span>
            </div>
            <button
              className="hid-btn hid-btn-ghost hid-btn-sm hid-btn-icon"
              onClick={onClose}
              style={{ flexShrink: 0 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        <div className="hid-modal-body">{children}</div>
        {footer && <div className="hid-modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// TabBar
// ---------------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: string;
  icon?: IconName;
  count?: number;
}

interface TabBarProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

export const TabBar: React.FC<TabBarProps> = ({ tabs, active, onChange }) => (
  <div className="ehr-tabs">
    {tabs.map((t) => (
      <button
        key={t.id}
        className={['ehr-tab', active === t.id ? 'active' : ''].filter(Boolean).join(' ')}
        onClick={() => onChange(t.id)}
      >
        {t.icon && <Icon name={t.icon} size={14} style={{ marginRight: 4 }} />}
        {t.label}
        {t.count !== undefined && (
          <span style={{ marginLeft: 4, background: 'var(--neutral-200)', borderRadius: 'var(--radius-pill)', padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>
            {t.count}
          </span>
        )}
      </button>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

interface FieldProps {
  label?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
}

export const Field: React.FC<FieldProps> = ({ label, error, hint, children, required }) => (
  <div className="hid-field">
    {label && (
      <label className="hid-label">
        {label}
        {required && <span style={{ color: 'var(--danger-500)', marginLeft: 2 }}>*</span>}
      </label>
    )}
    {children}
    {error && <span className="hid-error">{error}</span>}
    {hint && !error && <span className="hid-hint">{hint}</span>}
  </div>
);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: React.HTMLInputTypeAttribute;
  error?: string;
  icon?: IconName;
}

export const Input: React.FC<InputProps> = ({ value, onChange, placeholder, type = 'text', error, disabled, icon, className = '', ...inputProps }) => (
  <div style={{ position: 'relative' }}>
    {icon && (
      <span style={{ position: 'absolute', left: 'var(--space-300)', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>
        <Icon name={icon} size={14} />
      </span>
    )}
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      className={['hid-input', error ? 'error' : '', icon ? 'ps-8' : '', className].filter(Boolean).join(' ')}
      style={icon ? { paddingLeft: 36 } : undefined}
      {...inputProps}
    />
  </div>
);

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({ value, onChange, options, placeholder, disabled }) => (
  <select className="hid-select" value={value} onChange={onChange} disabled={disabled}>
    {placeholder && <option value="">{placeholder}</option>}
    {options.map((o) => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
);

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  value: string;
}

export const Textarea: React.FC<TextareaProps> = ({ rows = 4, ...props }) => (
  <textarea
    className="hid-textarea"
    rows={rows}
    {...props}
  />
);

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

interface ToastItem {
  id: number;
  message: string;
  icon: string;
}

let _toastSetFn: React.Dispatch<React.SetStateAction<ToastItem[]>> | null = null;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  _toastSetFn = setToasts;

  return (
    <>
      {children}
      <div style={{ position: 'fixed', top: 'var(--space-600)', right: 'var(--space-600)', zIndex: 'var(--z-toast)' as unknown as number, display: 'flex', flexDirection: 'column', gap: 'var(--space-300)' }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: 'var(--neutral-900)',
              color: 'var(--neutral-0)',
              padding: 'var(--space-400) var(--space-500)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-lg)',
              fontSize: 'var(--fs-sm)',
              fontWeight: 500,
              maxWidth: 320,
              animation: 'fadeIn var(--dur-base) var(--ease-decelerate)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-300)',
            }}
          >
            {t.icon && <Icon name={t.icon as IconName} size={14} />}
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
};

export const showToast = (message: string, icon: IconName = 'check'): void => {
  if (!_toastSetFn) return;
  const id = Date.now();
  _toastSetFn((p) => [...p, { id, message, icon }]);
  setTimeout(() => _toastSetFn?.((p) => p.filter((t) => t.id !== id)), 3000);
};
