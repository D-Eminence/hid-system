import React from 'react';

interface FieldProps {
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export const Field: React.FC<FieldProps> = ({ label, error, hint, required, children, style }) => (
  <div className="hid-field" style={style}>
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
