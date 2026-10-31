import { AwsClient, EhrClient, Metrics, bridgeConfiguration, route } from './bridge.mjs';
import { TokenCache, lambdaCredentials } from './sigv4.mjs';

// Configuration is checked when the Lambda loads: a wrong environment fails
// every invocation (and the Errors alarm) instead of acting on bad settings.
const configuration = bridgeConfiguration(process.env);
const credentials = () => lambdaCredentials(process.env);
const tokens = new TokenCache(configuration, { fetch, credentials });
const ehr = new EhrClient(configuration, { fetch, tokens });
const aws = new AwsClient(configuration, { fetch, credentials });

export async function handler(event, lambdaContext) {
  return route(event, {
    configuration, ehr, aws, tokens,
    metrics: new Metrics(configuration),
    logger: console,
    now: Date.now,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    remainingMs: () => lambdaContext?.getRemainingTimeInMillis?.() ?? 30_000,
    requestId: lambdaContext?.awsRequestId ?? 'unknown-request',
  });
}
