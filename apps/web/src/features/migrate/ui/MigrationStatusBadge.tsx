import React from 'react'
import { Badge } from '../../../components/ui'

export function formatMigrationStatus(status: string) {
  return status
    .split('_')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ')
}

export function MigrationStatusBadge({
  status,
  positive = false,
}: {
  status: string
  positive?: boolean
}) {
  return <Badge color={positive ? 'blue' : 'gray'}>{formatMigrationStatus(status)}</Badge>
}
