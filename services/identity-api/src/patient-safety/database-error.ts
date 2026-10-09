export interface DatabaseError {
  code: string;
  message?: string;
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}

export function databaseMessage(error: DatabaseError): string {
  return typeof error.message === 'string' ? error.message : '';
}
