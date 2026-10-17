import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertScan, runtimePolicyPath } from './production-backend-build.mjs';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function validatePublication(directory) {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'publication.json')));
  const scan = JSON.parse(readFileSync(path.join(directory, 'grype.json')));
  const assessment = receipt.assessment_sha256
    ? JSON.parse(readFileSync(path.join(directory, 'runtime-assessment.json'))) : null;
  const policy = assessment ? JSON.parse(readFileSync(runtimePolicyPath(receipt.component))) : null;
  assertScan(scan, assessment, policy);
  if (assessment && (receipt.assessment_sha256 !== hash(path.join(directory, 'runtime-assessment.json'))
      || assessment.policy_sha256 !== hash(runtimePolicyPath(receipt.component)))) {
    throw Error('ASSESSMENT_BINDING_DIFFERS');
  }
  return receipt;
}
function directories(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? directories(path.join(folder, entry.name)) : entry.name === 'publication.json' ? [folder] : []);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'candidate') for (const folder of directories('release-evidence')) validatePublication(folder);
    execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      ['scripts/production_deployment.py', ...process.argv.slice(2)], { stdio: 'inherit' });
  } catch { process.exitCode = 1; }
}
