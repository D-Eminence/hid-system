/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly HID?: string
  readonly HID_TURNSTILE_SITE_KEY?: string
  readonly TURNSTILE_SITE_KEY?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
  readonly VITE_GOOGLE_CLIENT_ID?: string
  readonly VITE_EHR_APP_URL?: string
  readonly VITE_HID_API_URL?: string
  readonly VITE_HID_IDENTITY_API_URL?: string
  readonly VITE_HID_FUNCTIONS_PATH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
