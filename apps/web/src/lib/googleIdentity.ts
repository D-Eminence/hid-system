type GoogleCredentialResponse = { credential?: string }

export type GoogleIdentitySelection = {
  credential: string
}

export type GoogleIdentityButtonText = 'signin_with' | 'signup_with' | 'continue_with'

type GoogleIdentityButtonConfiguration = {
  type: 'standard'
  theme: 'outline'
  size: 'large'
  text: GoogleIdentityButtonText
  shape: 'rectangular'
  logo_alignment: 'left'
  width: string
}

type GoogleIdentityApi = {
  accounts: {
    id: {
      initialize: (options: {
        auto_select: false
        button_auto_select: false
        client_id: string
        nonce: string
        callback: (response: GoogleCredentialResponse) => void
        ux_mode: 'popup'
      }) => void
      renderButton: (parent: HTMLElement, options: GoogleIdentityButtonConfiguration) => void
    }
  }
}

declare global {
  interface Window { google?: GoogleIdentityApi }
}

let googleScriptPromise: Promise<void> | null = null
let initializedClientId = ''
let initializedNonce = ''
let currentCredentialHandler: ((selection: GoogleIdentitySelection) => void) | null = null
let currentCredentialErrorHandler: ((error: Error) => void) | null = null

function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Google sign-in is only available in a browser.'))
  if (window.google?.accounts?.id) return Promise.resolve()
  if (googleScriptPromise) return googleScriptPromise

  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-hid-google-identity]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Unable to load the Google account chooser right now.')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.hidGoogleIdentity = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Unable to load the Google account chooser right now.'))
    document.head.appendChild(script)
  }).catch(error => {
    googleScriptPromise = null
    throw error
  })
  return googleScriptPromise
}

export async function renderGoogleIdentityButton(
  parent: HTMLElement,
  options: {
    onError: (error: Error) => void
    onIdentity: (selection: GoogleIdentitySelection) => void
    nonce: string
    text: GoogleIdentityButtonText
    width: number
  },
) {
  const clientId = `${import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''}`.trim()
  if (!clientId) throw new Error('Google sign-in is not configured yet. Add the Google Web Client ID to the production app settings.')
  const nonce = options.nonce.trim()
  if (nonce.length < 32 || nonce.length > 256) throw new Error('Google sign-in could not be initialized.')
  await loadGoogleIdentityScript()
  if (!window.google?.accounts?.id) throw new Error('The Google account chooser is unavailable right now.')
  const googleIdentity = window.google
  currentCredentialHandler = options.onIdentity
  currentCredentialErrorHandler = options.onError

  if (initializedClientId !== clientId || initializedNonce !== nonce) {
    googleIdentity.accounts.id.initialize({
      auto_select: false,
      button_auto_select: false,
      client_id: clientId,
      nonce,
      callback: response => {
        if (!response.credential) {
          currentCredentialErrorHandler?.(new Error('Google did not return an identity. Please try again.'))
          return
        }
        currentCredentialHandler?.({ credential: response.credential })
      },
      ux_mode: 'popup',
    })
    initializedClientId = clientId
    initializedNonce = nonce
  }

  parent.replaceChildren()
  googleIdentity.accounts.id.renderButton(parent, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: options.text,
    shape: 'rectangular',
    logo_alignment: 'left',
    width: `${Math.max(100, Math.min(400, Math.floor(options.width)))}`,
  })
}
