export const BANNED_ACCOUNT_MESSAGE = 'This user is banned. Contact: support@healthidentitydirectory.com'

export function isBannedAuthMessage(message: string | null | undefined) {
  const lower = `${message ?? ''}`.toLowerCase()
  return (
    lower.includes('user is banned') ||
    lower.includes('banned until') ||
    lower.includes(BANNED_ACCOUNT_MESSAGE.toLowerCase())
  )
}
