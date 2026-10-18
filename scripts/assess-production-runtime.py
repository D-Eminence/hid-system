"""Exact production image applicability assessment; never a vulnerability waiver."""
import datetime
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
POLICY = ROOT / 'security/production-runtime-assessment.json'
spec = importlib.util.spec_from_file_location('native_assessment', ROOT / 'scripts/assess-staging-runtime.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

def validate_inputs(component, image, scan, metadata, policy, source):
    if policy.get('schema') != 'hid.production-runtime-assessment-policy/v1':
        raise RuntimeError('Production assessment policy required')
    if component not in policy.get('elf_inventory', {}) or not re.fullmatch(r'[a-z][a-z0-9-]+', component):
        raise RuntimeError('Unassessed production component')
    if not re.fullmatch(r'[a-f0-9]{40}', source or '') or image != 'hid-ci/' + component + ':' + source:
        raise RuntimeError('Exact source-bound image tag required')
    if metadata.get('Os') != 'linux' or metadata.get('Architecture') != 'arm64':
        raise RuntimeError('Exact Linux ARM64 image required')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', metadata.get('Id', '')):
        raise RuntimeError('Immutable Docker image ID required')
    if metadata.get('Config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != source:
        raise RuntimeError('Image source revision differs')
    if scan.get('source', {}).get('target', {}).get('userInput') != image:
        raise RuntimeError('Raw scan belongs to another image')
    if not isinstance(scan.get('matches'), list) or not scan.get('descriptor', {}).get('version'):
        raise RuntimeError('Complete raw vulnerability report required')
    if scan.get('distro', {}).get('name') != 'debian' or str(scan.get('distro', {}).get('version')) != '13':
        raise RuntimeError('Exact assessed distribution required')
    if any(v.get('vulnerability', {}).get('severity') in ('High', 'Critical') for v in scan.get('ignoredMatches', [])):
        raise RuntimeError('Raw scan must retain all original High/Critical findings')
    now = datetime.datetime.now(datetime.timezone.utc)
    assessed = datetime.datetime.fromisoformat(policy['assessed_at'])
    expires = datetime.datetime.fromisoformat(policy['expires_at'])
    if not assessed <= now < expires or not datetime.timedelta(0) < expires - assessed <= datetime.timedelta(days=30):
        raise RuntimeError('Current bounded production assessment required')

def assess(component, image, raw_file, directory):
    policy = json.loads(POLICY.read_text())
    scan = json.loads(raw_file.read_bytes())
    source = os.environ.get('GITHUB_SHA', '')
    metadata = json.loads(native.run('docker', 'image', 'inspect', image))[0]
    validate_inputs(component, image, scan, metadata, policy, source)
    native.assess(component, image, scan, directory, policy_file=POLICY,
                  author='HID production runtime applicability assessment')
    receipt_file = directory / 'runtime-assessment.json'
    receipt = json.loads(receipt_file.read_text())
    if receipt['image_id'] != metadata['Id']:
        raise RuntimeError('Image changed during assessment')
    receipt.update(source_commit=source, raw_scan_sha256=hashlib.sha256(raw_file.read_bytes()).hexdigest(),
                   base_digest=policy['base_digest'], assessment_scope='production')
    receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')

if __name__ == '__main__':
    component, image, filename, output = sys.argv[1:]
    assess(component, image, pathlib.Path(filename), pathlib.Path(output))
