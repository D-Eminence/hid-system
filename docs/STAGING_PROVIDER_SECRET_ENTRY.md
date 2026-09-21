# Staging provider secret entry

Use `scripts/staging-provider-secret.py` on the existing Linux operator machine
to inspect or securely enter one absent provider field. It pins AWS profile
`hid-admin`, account `659225405023`, and region `eu-west-1`. It never creates a
secret container, sends a message, verifies a provider or deploys an application.
No MetaMap/NIN secret is accessed.

| Field | Existing Secrets Manager container | Value source |
| --- | --- | --- |
| `turnstileSecretKey` | `/hid/staging/identity-sensitive` | The actual staging Turnstile widget |
| `sesFromAddress` | `/hid/staging/notification-provider` | The controlled sender selected for SES in `eu-west-1` |
| `novuApiKey` | `/hid/staging/notification-provider` | The actual isolated Novu staging environment's secret key |

Inspect without entering a value or writing anything:

```sh
python3 scripts/staging-provider-secret.py --field turnstileSecretKey
python3 scripts/staging-provider-secret.py --field sesFromAddress
python3 scripts/staging-provider-secret.py --field novuApiKey
```

After selecting and obtaining the real provider value, run the corresponding
command with `--apply` in your own interactive terminal, for example:

```sh
python3 scripts/staging-provider-secret.py --field novuApiKey --apply
```

The tool first displays only the destination and presence metadata. It then
prompts with echo disabled for the value and the exact destination confirmation.
Do not add the value to the command line, environment, local JSON inputs, source,
or chat. AWS CLI history must be disabled; the tool checks this before accessing
any value. The write payload goes through an anonymous stdin pipe, not a file or
process argument. Raw AWS errors and secret values are never printed.
[AWS file parameters](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html),
[PutSecretValue](https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html).

Existing selected fields are preserved and refused, including empty or null
fields; this is first entry, not credential rotation. All other JSON fields are
retained. The notification container may receive its first version only when a
metadata check confirms that it has zero versions. Missing containers, malformed
JSON, duplicate keys, ambiguous version state, automated rotation and pending
deletion stop the operation.

Run one operator update at a time and stop other writers while entering values.
The tool rechecks identity and the source version after prompting, but
`PutSecretValue` has no conditional source-version parameter; this is not an
atomic concurrent merge. If a write fails or its outcome is unclear, run the
read-only inspection before considering a retry. An existing field is never
silently replaced.

Minimum operator access is STS identity read plus Secrets Manager
`DescribeSecret`, `ListSecretVersionIds`, and `GetSecretValue` on the two exact
staging containers. `--apply` additionally needs `PutSecretValue` there. If a
container uses a customer-managed KMS key, grant only the applicable decrypt/data-key
permissions on that key. This does not require changing the runtime task roles
or granting access to production secrets.

The Cloudflare publisher is separate: its token remains a **raw SecretString**
under the existing `hid-staging-cloudflare-publisher-token-*` convention and is
not supported by this JSON-field helper. Follow [Cloudflare setup](STAGING_CLOUDFLARE_SETUP.md).
Provider fields being present does not prove sender verification, correct widget
binding, workflow/channel configuration, delivery, or staging acceptance. The
quota hold and all protected release gates remain in effect.
