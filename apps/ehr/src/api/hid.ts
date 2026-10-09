const HID_PATTERN = /^HID-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const MAX_HID_LENGTH = 64;

export const normalizeHid = (value: string): string => value.trim().toUpperCase();

export const isValidHid = (value: string): boolean =>
  value.length <= MAX_HID_LENGTH && HID_PATTERN.test(value);
