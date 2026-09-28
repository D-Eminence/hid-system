import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'

type RouteMeta = {
  canonical: string
  description: string
  robots: string
  title: string
}

const SITE_ORIGIN = 'https://healthidentitydirectory.com'
const SITE_IMAGE = `${SITE_ORIGIN}/hid-logo.png`
const DEFAULT_DESCRIPTION = 'HID gives every patient a secure, unified health identity so complete medical history is available at any hospital, anywhere, anytime.'
const INDEX_ROBOTS = 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1'

function resolveRouteMeta(pathname: string): RouteMeta {
  if (pathname === '/') {
    return {
      canonical: `${SITE_ORIGIN}/`,
      description: DEFAULT_DESCRIPTION,
      robots: INDEX_ROBOTS,
      title: 'HID | Health Identity Directory',
    }
  }

  if (pathname === '/patient') {
    return {
      canonical: `${SITE_ORIGIN}/patient`,
      description: 'Secure patient access portal for HID - Africa’s digital health identity infrastructure enabling connected medical record access and continuity of care.',
      robots: INDEX_ROBOTS,
      title: 'Patient Access | HID - Health Identity Directory',
    }
  }

  if (pathname === '/hospital' || pathname === '/hospital/auth') {
    return {
      canonical: `${SITE_ORIGIN}/hospital`,
      description: 'Secure hospital access portal for HID - Africa’s digital health identity infrastructure enabling connected medical record access and continuity of care.',
      robots: INDEX_ROBOTS,
      title: 'Hospital Access | HID - Health Identity Directory',
    }
  }

  if (pathname.startsWith('/eminence') || pathname.startsWith('/admin')) {
    return {
      canonical: `${SITE_ORIGIN}${pathname}`,
      description: 'The Health Identity Directory.',
      robots: 'noindex,nofollow',
      title: 'Admin Access | HID - Health Identity Directory',
    }
  }

  if (pathname.startsWith('/patient/') || pathname.startsWith('/hospital/') || pathname.startsWith('/doctor/')) {
    return {
      canonical: `${SITE_ORIGIN}${pathname}`,
      description: DEFAULT_DESCRIPTION,
      robots: 'noindex,nofollow',
      title: 'HID | Health Identity Directory',
    }
  }

  return {
    canonical: `${SITE_ORIGIN}/`,
    description: DEFAULT_DESCRIPTION,
    robots: 'noindex,nofollow',
    title: 'HID | Health Identity Directory',
  }
}

function ensureMeta(selector: string, attribute: 'name' | 'property', value: string, content: string) {
  if (typeof document === 'undefined') return

  let element = document.head.querySelector(selector) as HTMLMetaElement | null
  if (!element) {
    element = document.createElement('meta')
    element.setAttribute(attribute, value)
    document.head.appendChild(element)
  }
  if (element.content === content) return
  element.content = content
}

function ensureCanonical(href: string) {
  if (typeof document === 'undefined') return

  let canonical = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
  if (!canonical) {
    canonical = document.createElement('link')
    canonical.rel = 'canonical'
    document.head.appendChild(canonical)
  }
  if (canonical.href === href) return
  canonical.href = href
}

export function RouteSeo() {
  const location = useLocation()
  const meta = useMemo(() => resolveRouteMeta(location.pathname), [location.pathname])

  useEffect(() => {
    if (document.title !== meta.title) {
      document.title = meta.title
    }
    ensureCanonical(meta.canonical)
    ensureMeta('meta[name="description"]', 'name', 'description', meta.description)
    ensureMeta('meta[name="robots"]', 'name', 'robots', meta.robots)
    ensureMeta('meta[property="og:title"]', 'property', 'og:title', meta.title)
    ensureMeta('meta[property="og:description"]', 'property', 'og:description', meta.description)
    ensureMeta('meta[property="og:url"]', 'property', 'og:url', meta.canonical)
    ensureMeta('meta[property="og:image"]', 'property', 'og:image', SITE_IMAGE)
    ensureMeta('meta[property="og:image:alt"]', 'property', 'og:image:alt', 'HID Health Identity Directory logo')
    ensureMeta('meta[name="twitter:title"]', 'name', 'twitter:title', meta.title)
    ensureMeta('meta[name="twitter:description"]', 'name', 'twitter:description', meta.description)
    ensureMeta('meta[name="twitter:image"]', 'name', 'twitter:image', SITE_IMAGE)
    ensureMeta('meta[name="twitter:image:alt"]', 'name', 'twitter:image:alt', 'HID Health Identity Directory logo')
  }, [meta])

  return null
}
