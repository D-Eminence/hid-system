import React from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', rows = 4, ...props }, ref) => (
    <textarea ref={ref} rows={rows} className={['hid-textarea', className].filter(Boolean).join(' ')} {...props} />
  )
);
Textarea.displayName = 'Textarea';
