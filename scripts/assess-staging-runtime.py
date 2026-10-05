"""Image-bound OpenVEX for reviewed, non-applicable system-library findings.

No blanket ignores: exact component, package versions and every ELF hash must
match the retained assessment. Other CVEs and changed binaries fail closed.
"""
import datetime
import hashlib
import json
import pathlib
import struct
import subprocess
import sys
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def elf_imports(data):
    if data[:6] != b'\x7fELF\x02\x01':
        return []  # Other ABI prebuilds are still bound by their whole-file hash.
    offset = struct.unpack_from('<Q', data, 40)[0]
    stride, count = struct.unpack_from('<HH', data, 58)
    sections = [struct.unpack_from('<IIQQQQIIQQ', data, offset + i * stride) for i in range(count)]
    result = []
    for section in sections:
        if section[1] not in (2, 11):
            continue
        strings = sections[section[6]]
        names = data[strings[4]:strings[4] + strings[5]]
        for index in range(section[4], section[4] + section[5], section[9]):
            name, _, _, defined, _, _ = struct.unpack_from('<IBBHQQ', data, index)
            if not defined and name:
                result.append(names[name:names.find(b'\0', name)].decode('utf8'))
    return result

def assess(component, image, scan, directory):
    policy = json.loads((ROOT / 'security/staging-novu-runtime-assessment.json').read_text())
    if datetime.datetime.now(datetime.timezone.utc) >= datetime.datetime.fromisoformat(policy['expires_at']):
        raise RuntimeError('Runtime assessment expired; re-assess before publication')
    if component not in policy['elf_inventory']:
        raise RuntimeError('No reviewed runtime assessment for this component')
    metadata = json.loads(run('docker', 'image', 'inspect', image))[0]
    if metadata['Architecture'] != 'arm64' or metadata['Os'] != 'linux':
        raise RuntimeError('Only the assessed Linux ARM64 runtime is covered')
    inventory, imports = {}, []
    with tempfile.TemporaryDirectory(prefix='hid-vex-') as temporary:
        archive = pathlib.Path(temporary) / 'rootfs.tar'
        container = run('docker', 'create', '--platform', 'linux/arm64', image)
        try:
            subprocess.run(['docker', 'export', '-o', str(archive), container], check=True)
        finally:
            subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)
        with tarfile.open(archive) as files:
            for member in files:
                if not member.isfile() or member.size < 4:
                    continue
                stream = files.extractfile(member)
                prefix = stream.read(4)
                if prefix == b'\x7fELF':
                    data = prefix + stream.read()
                    inventory[member.name] = hashlib.sha256(data).hexdigest()
                    imports.extend(elf_imports(data))
    if inventory != policy['elf_inventory'][component]:
        raise RuntimeError('Native binary inventory changed; new assessment required')
    forbidden = ('strfmon', 'strfmon_l', '__strfmon_l', 'ns_printrr', 'ns_printrrf', 'fp_nquery')
    if any(name in forbidden for name in imports):
        raise RuntimeError('Affected glibc function entered the execution path')
    statements = []
    reviewed = []
    for match in scan['matches']:
        if match['vulnerability']['severity'] not in ('High', 'Critical'):
            continue
        artifact, vulnerability = match['artifact'], match['vulnerability']
        found = next((entry for entry in policy['findings']
                      if entry['id'] == vulnerability['id'] and artifact['name'] in entry['packages']
                      and entry['versions'][artifact['name']] == artifact['version']), None)
        if not found or vulnerability['severity'] == 'Critical':
            raise RuntimeError('Unassessed High/Critical finding blocks publication')
        reviewed.append({'id': vulnerability['id'], 'package': artifact['name'],
                         'version': artifact['version'], 'purl': artifact['purl']})
        statements.append({'vulnerability': {'name': vulnerability['id']},
            'products': [{'@id': artifact['purl']}], 'status': 'not_affected',
            'justification': found['justification'], 'impact_statement': found['rationale']})
    if not statements:
        raise RuntimeError('Assessment is unnecessary for an already clean scan')
    timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output = {'schema': 'hid.image-runtime-assessment/v1', 'component': component,
              'image_id': metadata['Id'], 'assessed_at': timestamp, 'expires_at': policy['expires_at'],
              'policy_sha256': hashlib.sha256((ROOT / 'security/staging-novu-runtime-assessment.json').read_bytes()).hexdigest(),
              'native_inventory_sha256': hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest(),
              'native_binary_count': len(inventory), 'glibc_affected_imports': 0,
              'raw_high_matches': len(reviewed), 'reviewed_not_affected': reviewed,
              'scope': 'Exact image only; original findings retained; no risk-acceptance waiver'}
    vex = {'@context': 'https://openvex.dev/ns/v0.2.0',
           '@id': 'https://healthidentitydirectory.com/security/assessments/' + metadata['Id'].split(':')[1],
           'author': 'HID staging runtime assessment', 'timestamp': timestamp, 'version': 1,
           'statements': statements}
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'runtime-assessment.json').write_text(json.dumps(output, indent=2) + '\n')
    (directory / 'runtime.vex.json').write_text(json.dumps(vex, indent=2) + '\n')
    print(json.dumps({'component': component, 'assessed_not_affected': len(reviewed), 'image_id': metadata['Id']}))

if __name__ == '__main__':
    component, image, filename, directory = sys.argv[1:]
    assess(component, image, json.loads(pathlib.Path(filename).read_text()), pathlib.Path(directory))
