import React from 'react';
import { Icon, IconName } from './Icon';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  icon?: IconName;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error, icon, style, ...props }, ref) => (
    <div style={{ position: 'relative', width: '100%' }}>
      {icon && (
        <span style={{ position: 'absolute', left: 'var(--space-300)', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }}>
          <Icon name={icon} size={14} />
        </span>
      )}
      <input
        ref={ref}
        className={['hid-input', error ? 'error' : '', className].filter(Boolean).join(' ')}
        style={{ paddingLeft: icon ? 36 : undefined, ...style }}
        {...props}
      />
    </div>
  )
);
Input.displayName = 'Input';
