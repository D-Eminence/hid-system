import { issuerConfiguration, createIssuer } from './issuer.mjs';

const configuration = issuerConfiguration(process.env);
let handlerImplementation;

export async function handler(event) {
  if (!handlerImplementation) {
    const { KMSClient, GetPublicKeyCommand, SignCommand } = await import('@aws-sdk/client-kms');
    const kms = new KMSClient({ maxAttempts: 2 });
    handlerImplementation = createIssuer(configuration, {
      getPublicKey: KeyId => kms.send(new GetPublicKeyCommand({ KeyId })),
      sign: (KeyId, Message) => kms.send(new SignCommand({
        KeyId, Message, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256',
      })),
    });
  }
  return handlerImplementation(event);
}
