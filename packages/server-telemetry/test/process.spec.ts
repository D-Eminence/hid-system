import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/*
 * Real child processes against the built package (dist): crash semantics must
 * match Node's defaults when reporting is enabled. The transport is in-memory
 * and prints a marker, so nothing touches the network.
 */
const dist = join(__dirname, '..', 'dist');

function run(body: string) {
  const script = `
    const t = require(${JSON.stringify(dist)});
    const transport = () => ({ send: async (env) => { process.stdout.write('EVENT ' + JSON.stringify(env[1][0][1].exception.values.map(v => [v.type, v.mechanism])) + '\\n'); return {}; }, flush: async () => true });
    if (!t.initErrorReporting({ service: 'child', transport })) throw new Error('not enabled');
    ${body}
  `;
  return spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, SENTRY_DSN: 'https://public@example.invalid/1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('process crash semantics with reporting enabled', () => {
  it('an uncaught exception is reported and still crashes with exit code 1', () => {
    const result = run(`setTimeout(() => { throw new TypeError('Adaeze Okonkwo'); }, 10);`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('EVENT [["TypeError"');
    expect(result.stdout).not.toContain('Adaeze');
    expect(result.stderr).toContain('TypeError');
  });

  it('an unhandled AbortError rejection is reported and still crashes with exit code 1', () => {
    const result = run(`Promise.reject(new DOMException('aborted', 'AbortError')); setTimeout(() => {}, 5000);`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('auto.node.onunhandledrejection');
    expect(result.stderr).toContain('AbortError');
  });

  it('an unhandled plain rejection is reported and still crashes with exit code 1', () => {
    const result = run(`Promise.reject(new RangeError('x')); setTimeout(() => {}, 5000);`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('EVENT [["RangeError"');
  });
});
