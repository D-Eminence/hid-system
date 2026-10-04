import { LexRuntimeV2Client, RecognizeTextCommand } from '@aws-sdk/client-lex-runtime-v2';
import { supportServer } from './server.mjs';

const { LEX_BOT_ID, LEX_BOT_ALIAS_ID, LEX_LOCALE_ID = 'en_GB', PORT = '3011' } = process.env;
if (!/^[A-Za-z0-9]{10}$/.test(LEX_BOT_ID ?? '') || !/^[A-Za-z0-9]{10}$/.test(LEX_BOT_ALIAS_ID ?? '')
    || LEX_LOCALE_ID !== 'en_GB' || !/^\d+$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535) {
  throw new Error('Valid Lex bot/alias, approved locale and port are required');
}
const lex = new LexRuntimeV2Client({ maxAttempts: 1 });

const supportContact = process.env.SUPPORT_CONTACT ?? '';
if (!/^(mailto:[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9/_-]*)?)$/.test(supportContact)
  || supportContact.length > 200) throw new Error('An approved support contact is required');
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
}, { supportContact });

server.listen(Number(PORT), '0.0.0.0');
process.on('SIGTERM', () => { server.close(() => lex.destroy()); server.closeIdleConnections(); });
