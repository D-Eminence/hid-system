import type { AccessLog } from '../types/database'

/**
 * Generates a candidate HID code with an 80-bit random suffix.
 * Persistence must still reserve it through a unique database constraint.
 */
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0,O,1,I

function randomSegment(len: number): string {
  const entropy = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(entropy, byte => CHARS[byte & 31]).join('')
}

export function generateHID(): string {
  return `HID-${randomSegment(16)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isDateOnlyValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  if (isDateOnlyValue(iso)) {
    const [year, month, day] = iso.split('-')
    return `${day}-${month}-${year}`
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${formatDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return ''
  if (isDateOnlyValue(iso)) return iso
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toLocalDateKey(value: Date | string | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Calculate relative time (e.g. "2 hours ago")
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const
export const GENOTYPES = ['AA', 'AS', 'AC', 'SS', 'SC'] as const
export const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia',
  'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin',
  'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi',
  'Cabo Verde', 'Cambodia', 'Cameroon', 'Canada', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia',
  'Comoros', 'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czech Republic', 'Democratic Republic of the Congo',
  'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea',
  'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany',
  'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan',
  'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho',
  'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives',
  'Mali', 'Malta', 'Marshall Islands', 'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco',
  'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands',
  'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan',
  'Palau', 'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar',
  'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia', 'Saint Vincent and the Grenadines', 'Samoa',
  'San Marino', 'Sao Tome and Principe', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore',
  'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain',
  'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand',
  'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda',
  'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu',
  'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
] as const
export const STATES_BY_COUNTRY: Record<string, string[]> = {
  Nigeria: ['Abia', 'Abuja FCT', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'],
  Ghana: ['Ashanti', 'Bono', 'Central', 'Eastern', 'Greater Accra', 'Northern', 'Volta', 'Western'],
  Kenya: ['Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Kiambu', 'Machakos'],
  'South Africa': ['Eastern Cape', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'Western Cape'],
  'United States': ['California', 'Florida', 'New York', 'Texas', 'Washington'],
  'United Kingdom': ['England', 'Northern Ireland', 'Scotland', 'Wales'],
}

export function parseDisplayDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/)
  if (!match) return null
  const [, dd, mm, yyyy] = match
  return `${yyyy}-${mm}-${dd}`
}

export function fromDateInputValue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return trimmed
}

export function calculateAge(iso: string | null | undefined): string {
  if (!iso) return '-'
  const dob = isDateOnlyValue(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso)
  if (Number.isNaN(dob.getTime())) return '-'
  const now = new Date()
  let age = now.getFullYear() - dob.getFullYear()
  const m = now.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1
  return `${age}`
}

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 20
export const PASSWORD_REQUIREMENTS_TEXT = '8 to 20 characters. Include one uppercase letter, one lowercase letter, one number, and one special character.'

export function isStrongPassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH &&
    value.length <= PASSWORD_MAX_LENGTH &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
}

export function getPersonInitials(fullName: string | null | undefined): string {
  const tokens = `${fullName ?? ''}`.trim().split(/\s+/).filter(Boolean)
  if (tokens.length >= 2) return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase()
  const fallback = tokens[0]?.slice(0, 2).toUpperCase()
  return fallback || 'PT'
}

export function getHospitalInitials(name: string | null | undefined): string {
  const letters = `${name ?? ''}`.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()
  return letters || 'HO'
}

export function maskEmailAddress(value: string | null | undefined): string {
  const trimmed = `${value ?? ''}`.trim().toLowerCase()
  if (!trimmed) return ''

  const [localPart, domainPart] = trimmed.split('@')
  if (!localPart || !domainPart) return trimmed
  if (localPart.length <= 2) return `${localPart[0] ?? '*'}***@${domainPart}`
  return `${localPart.slice(0, 2)}***@${domainPart}`
}

export function getAccessLogLabel(log: Pick<AccessLog, 'access_type' | 'reason'>): string {
  const reason = `${log.reason ?? ''}`.toLowerCase()
  if (reason.includes('revoked')) return 'Revoked'
  if (reason.includes('closed')) return 'Closed'
  if (reason.includes('denied')) return 'Denied'
  return log.access_type === 'emergency' ? 'Emergency' : 'Standard'
}
