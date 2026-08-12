const configuredIdentityPortalUrl = import.meta.env.VITE_HID_IDENTITY_PORTAL_URL?.trim();

export const IDENTITY_PORTAL_URL = configuredIdentityPortalUrl?.startsWith('https://')
  ? configuredIdentityPortalUrl
  : import.meta.env.DEV
    ? '/'
    : undefined;
