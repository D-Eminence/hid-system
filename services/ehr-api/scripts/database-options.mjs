function booleanEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function verifiedSsl(prefix) {
  const caVariable = `${prefix}_SSL_ROOT_CERT_BASE64`;
  const sslVariable = `${prefix}_SSL`;
  const encodedCa = process.env[caVariable]?.replace(/\s+/g, '');
  const sslRequested = booleanEnvironment(sslVariable);

  if (prefix === 'DATABASE' && process.env.NODE_ENV === 'production' && !encodedCa) {
    throw new Error(`${caVariable} is required for production target database verification`);
  }
  if (!encodedCa && !sslRequested) return undefined;
  if (!encodedCa) return { rejectUnauthorized: true };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCa) || encodedCa.length % 4 !== 0) {
    throw new Error(`${caVariable} is not valid base64`);
  }
  const ca = Buffer.from(encodedCa, 'base64').toString('utf8');
  if (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) {
    throw new Error(`${caVariable} does not contain a PEM certificate`);
  }
  return { rejectUnauthorized: true, ca };
}

export function databaseOptions(connectionString, applicationName, sslPrefix = 'DATABASE') {
  const ssl = verifiedSsl(sslPrefix);
  return {
    connectionString,
    application_name: applicationName,
    ...(ssl ? { ssl } : {}),
  };
}
