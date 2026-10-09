export function publicationAuthorization(repository, now = new Date()) {
  const roles = ['root', 'targets', 'snapshot', 'timestamp']
  const authorizedAt = new Date(Math.floor(now.getTime() / 1000) * 1000)
  const candidate = Object.fromEntries(roles.map((role) => {
    const version = repository[`${role}Version`]
    const path = role === 'timestamp' ? 'metadata/timestamp.json' : `metadata/${version}.${role}.json`
    return [role, { version, sha256: repository.files?.find((file) => file.path === path)?.sha256 ?? 'a'.repeat(64) }]
  }))
  return {
    schema_version: 'hid.tuf.publication-authorization/v1',
    repository_sha256: repository.repositorySha256, previous_repository_sha256: '', file_count: repository.fileCount,
    config_sha256: 'd'.repeat(64), executable_sha256: 'e'.repeat(64),
    authorization: {
      schema_version: '1.0.0', environment: repository.deployment,
      repository_id: `hid-${repository.deployment}-v1`, state_id: `hid-${repository.deployment}-broker-v1`,
      bootstrap_root_sha256: candidate.root.sha256, state_revision: 0,
      release_id: `r0000000001-g${'a'.repeat(40)}`,
      authorized_at: authorizedAt.toISOString().replace('.000Z', 'Z'),
      expires_at: new Date(authorizedAt.getTime() + 300000).toISOString().replace('.000Z', 'Z'),
      current: Object.fromEntries(roles.map((role) => [role, { version: 0, sha256: '' }])), candidate,
    },
  }
}
