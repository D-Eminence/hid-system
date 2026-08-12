export const HID_INPUT_PREFIX = 'HID-'

export function normalizeHidInput(value: string) {
  const compact = value.toUpperCase().replace(/\s+/g, '')

  if (!compact || compact === 'HID' || compact === HID_INPUT_PREFIX) {
    return HID_INPUT_PREFIX
  }

  if (compact.startsWith(HID_INPUT_PREFIX)) {
    return compact
  }

  if (compact.startsWith('HID')) {
    return `${HID_INPUT_PREFIX}${compact.slice(3).replace(/^-+/, '')}`
  }

  return `${HID_INPUT_PREFIX}${compact.replace(/^-+/, '')}`
}

export function isCompleteHidInput(value: string) {
  return normalizeHidInput(value).length > HID_INPUT_PREFIX.length
}
