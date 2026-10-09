const portDefinitions = Object.freeze({
  gateway: { environment: 'HID_GATEWAY_PORT', defaultPort: 3000 },
  identityApi: { environment: 'HID_IDENTITY_API_PORT', defaultPort: 3001 },
  ehrApi: {
    environment: 'HID_EHR_API_PORT',
    legacyEnvironment: 'HID_API_PORT',
    defaultPort: 3002,
  },
  labApi: { environment: 'HID_LAB_API_PORT', defaultPort: 3003 },
  pharmacyApi: { environment: 'HID_PHARMACY_API_PORT', defaultPort: 3004 },
  ocrApi: { environment: 'HID_OCR_API_PORT', defaultPort: 3005 },
  outreachApi: { environment: 'HID_OUTREACH_API_PORT', defaultPort: 3006 },
  notificationApi: { environment: 'HID_NOTIFICATION_API_PORT', defaultPort: 3007 },
  notificationWorkerStatus: { environment: 'HID_NOTIFICATION_WORKER_STATUS_PORT', defaultPort: 3008 },
  eventDispatcherStatus: { environment: 'HID_EVENT_DISPATCHER_STATUS_PORT', defaultPort: 3010 },
  webUi: { environment: 'HID_WEB_PORT', defaultPort: 3100 },
  ehrUi: { environment: 'HID_EHR_PORT', defaultPort: 3101 },
  labUi: { environment: 'HID_LAB_PORT', defaultPort: 3102 },
  pharmacyUi: { environment: 'HID_PHARMACY_PORT', defaultPort: 3103 },
  outreachUi: { environment: 'HID_OUTREACH_PORT', defaultPort: 3104 },
  ocrUi: { environment: 'HID_OCR_PORT', defaultPort: 3105 },
  adminUi: { environment: 'HID_ADMIN_PORT', defaultPort: 3106 },
})

function parsePort(value, environmentName) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${environmentName} must be an integer between 1 and 65535`)
  }
  return port
}

export function resolveDevelopmentPorts(environment = process.env) {
  const ports = {}

  for (const [name, definition] of Object.entries(portDefinitions)) {
    const preferredValue = environment[definition.environment]
    const legacyValue = definition.legacyEnvironment
      ? environment[definition.legacyEnvironment]
      : undefined

    if (preferredValue && legacyValue && preferredValue !== legacyValue) {
      throw new Error(
        `${definition.environment} and ${definition.legacyEnvironment} must match when both are set`,
      )
    }

    ports[name] = parsePort(
      preferredValue ?? legacyValue ?? definition.defaultPort,
      definition.environment,
    )
  }

  const claimedPorts = new Map()
  for (const [name, port] of Object.entries(ports)) {
    const existingName = claimedPorts.get(port)
    if (existingName) {
      throw new Error(`Development port ${port} is assigned to both ${existingName} and ${name}`)
    }
    claimedPorts.set(port, name)
  }

  return Object.freeze(ports)
}

export const defaultDevelopmentPorts = resolveDevelopmentPorts({})
