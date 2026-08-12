import { Link } from 'react-router-dom'
import { Layout } from '@hid/ui/Layout'
import { Card } from '@hid/ui'
import { OUTREACH_LOGIN_PATH } from '../lib/outreachRoutes'

export function OutreachProvisioningUnavailable() {
  return (
    <Layout title="Outreach" subtitle="Facility-managed access">
      <Card style={{ maxWidth: 600, margin: '0 auto', padding: 32 }}>
        <h2 style={{ marginTop: 0 }}>Public provisioning is unavailable</h2>
        <p style={{ color: '#4b5563', lineHeight: 1.6 }}>
          Outreach roles and facility permissions must be assigned through the approved Identity
          administration workflow. Self-signup, campaign creation, public invite codes, and Outreach
          OTP accounts are not part of this service boundary.
        </p>
        <Link to={OUTREACH_LOGIN_PATH} style={{ color: '#1a6fd4', fontWeight: 700 }}>
          Sign in with a provisioned Identity account
        </Link>
      </Card>
    </Layout>
  )
}
