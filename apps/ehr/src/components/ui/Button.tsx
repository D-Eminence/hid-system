import React from 'react';
import { Icon, IconName } from './Icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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
  ...props
}) => {
  const cls = [
    'hid-btn',
    `hid-btn-${variant}`,
    `hid-btn-${size}`,
    fullWidth ? 'w-full' : '',
    className
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled || loading}
      style={{ width: fullWidth ? '100%' : undefined, ...style }}
      {...props}
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
