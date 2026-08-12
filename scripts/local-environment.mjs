import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

function readEnvironmentFile(file) {
  try {
    return parseEnv(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
}

export function environmentWithLocalFiles(files, baseEnvironment = process.env) {
  const localEnvironment = files.reduce(
    (environment, file) => ({ ...environment, ...readEnvironmentFile(file) }),
    {},
  )
  return { ...localEnvironment, ...baseEnvironment }
}

export function loadLocalEnvironment(files, targetEnvironment = process.env) {
  Object.assign(targetEnvironment, environmentWithLocalFiles(files, targetEnvironment))
  return targetEnvironment
}
