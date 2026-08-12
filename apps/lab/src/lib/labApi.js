import { getIdentityCsrfToken } from '@hid/identity-browser-client'

function validId(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

async function request(path, facilityId, options = {}) {
  const method = options.method ?? 'GET'
  const headers = new Headers({
    Accept: 'application/problem+json, application/json',
    'X-Correlation-ID': crypto.randomUUID(),
    'X-Facility-ID': facilityId,
    'X-Purpose-Of-Use': 'direct-care',
  })
  if (options.body !== undefined) headers.set('Content-Type', 'application/json')
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey)
  if (method !== 'GET') {
    const csrfToken = getIdentityCsrfToken()
    if (!csrfToken) throw new Error('Refresh your Identity session before changing laboratory records.')
    headers.set('X-CSRF-Token', csrfToken)
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { throw new Error('The Laboratory service returned an invalid response.') }
  if (!response.ok) throw new Error(payload?.detail || payload?.message || 'Laboratory request could not be completed.')
  return payload
}

const key = () => crypto.randomUUID()

export function createLabApi(facilityId) {
  const id = (value, label) => validId(value, label)
  return {
    listWorkItems: () => request('/api/v1/lab/work-items', facilityId),
    getAccession: (accessionId) => request(`/api/v1/lab/accessions/${id(accessionId, 'Accession identifier')}`, facilityId),
    createAccession: (workItemId, input) => request(`/api/v1/lab/work-items/${id(workItemId, 'Lab work-item identifier')}/accession`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    collectSpecimen: (accessionId, specimenId, input) => request(`/api/v1/lab/accessions/${id(accessionId, 'Accession identifier')}/specimens/${id(specimenId, 'Specimen identifier')}/collect`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    receiveSpecimen: (accessionId, specimenId, input) => request(`/api/v1/lab/accessions/${id(accessionId, 'Accession identifier')}/specimens/${id(specimenId, 'Specimen identifier')}/receive`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    rejectSpecimen: (accessionId, specimenId, input) => request(`/api/v1/lab/accessions/${id(accessionId, 'Accession identifier')}/specimens/${id(specimenId, 'Specimen identifier')}/reject`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    listExecutions: (specimenId) => request(`/api/v1/lab/specimens/${id(specimenId, 'Specimen identifier')}/executions`, facilityId),
    startExecution: (specimenId, input) => request(`/api/v1/lab/specimens/${id(specimenId, 'Specimen identifier')}/executions`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    completeExecution: (executionId, input) => request(`/api/v1/lab/executions/${id(executionId, 'Execution identifier')}/complete`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    enterResult: (executionId, input) => request(`/api/v1/lab/executions/${id(executionId, 'Execution identifier')}/results`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    correctResult: (executionId, resultId, input) => request(`/api/v1/lab/executions/${id(executionId, 'Execution identifier')}/results/${id(resultId, 'Result identifier')}/corrections`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    verifyResult: (resultId, input) => request(`/api/v1/lab/results/${id(resultId, 'Result identifier')}/verify`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
    releaseResult: (resultId, input) => request(`/api/v1/lab/results/${id(resultId, 'Result identifier')}/release`, facilityId, { method: 'POST', body: input, idempotencyKey: key() }),
  }
}
