"""Generator tests: determinism, committed keys and manifest, and the shape of what is generated.

    python3 -m unittest discover -s test -p 'test_*.py'
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

KIT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, KIT)

import generate  # noqa: E402

COUNT = 8


def run_generate(out, count=COUNT, seed=20261103, extra=()):
    return subprocess.run([sys.executable, os.path.join(KIT, 'generate.py'), '--seed', str(seed), '--count',
                           str(count), '--out', out, '--quiet', *extra], capture_output=True, text=True)


def tree(directory):
    result = {}
    for root, _, files in os.walk(directory):
        for name in files:
            path = os.path.join(root, name)
            with open(path, 'rb') as handle:
                result[os.path.relpath(path, directory)] = hashlib.sha256(handle.read()).hexdigest()
    return result


class GeneratorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.a = os.path.join(cls.tmp.name, 'a')
        cls.b = os.path.join(cls.tmp.name, 'b')
        for out in (cls.a, cls.b):
            result = run_generate(out)
            assert result.returncode == 0, result.stderr
        with open(os.path.join(KIT, 'keys', 'manifest.json'), encoding='utf-8') as handle:
            cls.manifest = json.load(handle)
        with open(os.path.join(KIT, 'keys', 'keys.jsonl'), encoding='utf-8') as handle:
            cls.committed_keys = [json.loads(line) for line in handle if line.strip()]

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_same_seed_gives_byte_identical_output(self):
        self.assertEqual(tree(self.a), tree(self.b))

    def test_a_different_seed_gives_different_documents(self):
        other = os.path.join(self.tmp.name, 'other')
        self.assertEqual(run_generate(other, count=2, seed=1).returncode, 0)
        self.assertNotEqual(tree(os.path.join(other, 'documents')),
                            {k: v for k, v in tree(os.path.join(self.a, 'documents')).items() if k[:4] in ('D001', 'D002')})

    def test_matches_the_committed_manifest_and_keys(self):
        files = tree(os.path.join(self.a, 'documents'))
        self.assertEqual(len(files), COUNT)
        for name, digest in files.items():
            self.assertEqual(self.manifest['files'][name], digest, name)
        with open(os.path.join(self.a, 'keys', 'keys.jsonl'), encoding='utf-8') as handle:
            keys = [json.loads(line) for line in handle if line.strip()]
        self.assertEqual(keys, self.committed_keys[:COUNT])

    def test_committed_manifest_is_self_consistent(self):
        with open(os.path.join(KIT, 'keys', 'keys.jsonl'), 'rb') as handle:
            self.assertEqual(hashlib.sha256(handle.read()).hexdigest(), self.manifest['keysSha256'])
        self.assertEqual(self.manifest['seed'], 20261103)
        self.assertEqual(self.manifest['count'], 200)
        self.assertEqual(sorted(self.manifest['files']), sorted(key['file'] for key in self.committed_keys))

    def test_check_against_reports_a_mismatch(self):
        result = run_generate(os.path.join(self.tmp.name, 'check'), count=3,
                              extra=('--check-against', os.path.join(KIT, 'keys')))
        self.assertEqual(result.returncode, 1, 'a 3-document set is not the committed 200')
        self.assertIn('seed or count differs', result.stderr)

    def test_documents_have_the_promised_shape(self):
        with open(os.path.join(self.a, 'keys', 'keys.jsonl'), encoding='utf-8') as handle:
            keys = [json.loads(line) for line in handle if line.strip()]
        for key in keys:
            path = os.path.join(self.a, 'documents', key['file'])
            with open(path, 'rb') as handle:
                data = handle.read()
            if key['mediaType'] == 'image/png':
                self.assertTrue(data.startswith(b'\x89PNG'))
                self.assertEqual(key['pages'], 1)
                self.assertLess(len(data), 4_500_000)
            else:
                self.assertTrue(data.startswith(b'%PDF'))
                self.assertIn(key['pages'], (2, 3, 4))
                self.assertEqual(len(re.findall(rb'/Type\s*/Page(?![a-zA-Z])', data)), key['pages'], key['file'])
            for item in key['items']:
                line = key['text'][item['page'] - 1]['lines'][item['lines'][0] - 1]['text']
                self.assertIn(item['asWritten'], line)
            self.assertIn(key['identity']['nameAsWritten'].split(',')[0].split()[-1].title(),
                          [s.title() for s in generate.SURNAMES] + [s.upper().title() for s in generate.SURNAMES])

    def test_document_traps_list_every_trap_its_items_carry(self):
        for key in self.committed_keys:
            item_traps = {item['trap'].split(':')[0] for item in key['items'] if item.get('trap')}
            self.assertTrue(item_traps <= set(key['traps']), f"{key['docId']}: {sorted(item_traps)} vs {key['traps']}")

    def test_every_document_is_independent_of_the_count(self):
        key_a, name_a, data_a = generate.build_document(20261103, 5)
        key_b, name_b, data_b = generate.build_document(20261103, 5)
        self.assertEqual((name_a, data_a), (name_b, data_b))
        self.assertEqual(key_a, key_b)
        self.assertEqual(hashlib.sha256(data_a).hexdigest(), self.manifest['files'][name_a])


if __name__ == '__main__':
    unittest.main()
