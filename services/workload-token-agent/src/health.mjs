import { readFile } from 'node:fs/promises';
try {
  const data = JSON.parse(await readFile('/var/run/hid/workload-tokens/ready.json', 'utf8'));
  process.exit(Number.isSafeInteger(data.expiresAt) && data.expiresAt > Date.now() + 10_000 ? 0 : 1);
} catch { process.exit(1); }
