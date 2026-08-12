import { invokeApiFunction } from './functionApi'
import { formatDateTime } from './utils'

export async function logPatientActivity(hidCode: string, title: string, detail: string) {
  const timestamp = new Date().toISOString()
  await invokeApiFunction('patient-activity', {
    method: 'POST',
    body: {
      hidCode,
      title,
      message: `${detail} at ${formatDateTime(timestamp)}.`,
      type: 'system',
    },
  }, 'The activity could not be recorded right now.')
}
