/* Compatibility stub retained for imports in downstream branches. Local simulated authentication is disabled. */

const unavailable = (): never => {
  throw new Error('Local simulated authentication is disabled. Use the connected HID Identity service.');
};

export const demoAuth = {
  enabled: false,
  email: '',
  password: '',
  signup: unavailable,
  signin: unavailable,
  restore: () => null,
  clear: () => undefined,
};
