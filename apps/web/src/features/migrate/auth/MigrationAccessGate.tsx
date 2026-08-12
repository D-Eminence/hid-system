import React, { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Button, EmptyState, PageLoader } from '../../../components/ui'
import { HOSPITAL_AUTH_PATH } from '../../../lib/hospitalRoutes'
import { getSafeSession } from '../../../lib/identityClient'
import { fetchMigrationContext } from '../api/migrationContext'
import type { MigrationAccessContext } from '../domain'

type AccessState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'ready'; context: MigrationAccessContext }
  | { status: 'error'; message: string }

export function MigrationAccessGate({ children }: {
  children: (context: MigrationAccessContext) => React.ReactNode
}) {
  const [state, setState] = useState<AccessState>({ status: 'loading' })
  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      if (!await getSafeSession()) {
        setState({ status: 'signed_out' })
        return
      }
      setState({ status: 'ready', context: await fetchMigrationContext() })
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'HID Migrate could not verify your access.',
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'signed_out') return <Navigate to={HOSPITAL_AUTH_PATH} replace />
  if (state.status === 'loading') return <PageLoader label="Verifying your Migrate workspace access..." />
  if (state.status === 'error') {
    return <EmptyState
      icon={<span aria-hidden="true" style={{ fontSize: 32 }}>!</span>}
      title="Migrate access could not be verified"
      description={state.message}
      action={<Button onClick={() => void load()}>Try again</Button>}
    />
  }
  if (state.context.projects.length === 0 && (state.context.creation_scopes?.length ?? 0) === 0) {
    return <EmptyState
      icon={<span aria-hidden="true" style={{ fontSize: 28 }}>HID</span>}
      title="No migration workspace assigned"
      description="Your HID staff account is active, but it has no active Migrate project assignment. Ask a migration administrator or project manager for access."
    />
  }
  return <>{children(state.context)}</>
}
