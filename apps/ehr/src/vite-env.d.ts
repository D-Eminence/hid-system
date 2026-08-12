/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HID_API_URL?: string;
  readonly VITE_HID_AUTH_COOKIE_NAME?: string;
  readonly VITE_HID_IDENTITY_PORTAL_URL?: string;
  readonly VITE_HID_DEMO_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
