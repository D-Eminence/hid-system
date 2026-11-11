import { LexRuntimeV2Client, RecognizeTextCommand } from '@aws-sdk/client-lex-runtime-v2';
import { captureServerError, initErrorReporting } from '@hid/server-telemetry';
import { healthIdCheck } from './health-id-check.mjs';
import { supportServer } from './server.mjs';

initErrorReporting({ service: 'support-api' });

const { LEX_BOT_ID, LEX_BOT_ALIAS_ID, LEX_LOCALE_ID = 'en_GB', PORT = '3011' } = process.env;
if (!/^[A-Za-z0-9]{10}$/.test(LEX_BOT_ID ?? '') || !/^[A-Za-z0-9]{10}$/.test(LEX_BOT_ALIAS_ID ?? '')
    || LEX_LOCALE_ID !== 'en_GB' || !/^\d+$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535) {
  throw new Error('Valid Lex bot/alias, approved locale and port are required');
}
const lex = new LexRuntimeV2Client({ maxAttempts: 1 });

const supportContact = process.env.SUPPORT_CONTACT ?? '';
if (!/^(mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9/_-]*)?)$/.test(supportContact)
  || supportContact.length > 200) throw new Error('An approved support contact is required');
// The server Health ID check (owner decision of 2026-10-31): identity-api says which Health IDs in a message are
// issued, and each is replaced before Lex. Without IDENTITY_API_URL or the workload token every message answers 503
// and nothing reaches Lex; a malformed setting stops the service here.
const checkHealthIds = healthIdCheck({
  identityApiUrl: process.env.IDENTITY_API_URL,
  mode: process.env.IDENTITY_SERVICE_IDENTITY_MODE || 'jwt',
  tokenFile: process.env.IDENTITY_SUPPORT_WORKLOAD_TOKEN_FILE,
  localToken: process.env.IDENTITY_SUPPORT_INTERNAL_SERVICE_TOKEN,
  production: process.env.NODE_ENV === 'production',
});
const server = supportServer(async (text, sessionId) => {
  const result = await lex.send(new RecognizeTextCommand({
    botId: LEX_BOT_ID,
    botAliasId: LEX_BOT_ALIAS_ID,
    localeId: LEX_LOCALE_ID,
    sessionId,
    text,
  }), { abortSignal: AbortSignal.timeout(5000) });
  return (result.messages ?? [])
    .filter((message) => message.contentType === 'PlainText' && message.content)
    .map((message) => message.content);
}, { supportContact, checkHealthIds, onError: (error) => captureServerError(error, '/api/v1/support/chat') });

server.listen(Number(PORT), '0.0.0.0');
process.on('SIGTERM', () => { server.close(() => lex.destroy()); server.closeIdleConnections(); });
