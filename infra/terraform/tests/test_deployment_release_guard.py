"""Evaluate the actual release comparisons with Terraform's real value types."""
import json
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ReleaseImageComparisonTests(unittest.TestCase):
    def test_actual_guards_compare_maps_and_reject_changed_images(self):
        expressions = []
        for name in ('main.tf', 'deployment_release_guard.tf'):
            source = (ROOT / name).read_text()
            expression = re.search(
                r'(tomap\(jsondecode\(data\.external\.release_state\[0\]\.result\.image_uris\)\)'
                r' == var\.image_uris &&\s*'
                r'data\.external\.release_state\[0\]\.result\.migration_image_uri == var\.migration_image_uri)',
                source)
            self.assertIsNotNone(expression, name)
            expressions.append(expression.group(1).replace(
                'data.external.release_state[0].result', 'var.release_state'))
        for changed in ('none', 'image', 'missing', 'extra', 'migration'):
            actual = {'gateway': 'image@sha256:aaa', 'identity-api': 'image@sha256:bbb'}
            expected = dict(actual)
            if changed == 'image':
                actual['gateway'] = 'image@sha256:old'
            elif changed == 'missing':
                del actual['identity-api']
            elif changed == 'extra':
                actual['unexpected'] = 'image@sha256:ccc'
            variables = {
                'image_uris': {'type': 'map(string)', 'default': expected},
                'migration_image_uri': {'type': 'string', 'default': 'migration@sha256:aaa'},
                'release_state': {'type': 'map(string)', 'default': {
                    'image_uris': json.dumps(actual),
                    'migration_image_uri': 'migration@sha256:old' if changed == 'migration' else 'migration@sha256:aaa'}},
            }
            with tempfile.TemporaryDirectory() as directory:
                pathlib.Path(directory, 'main.tf.json').write_text(json.dumps({'variable': variables}))
                for expression in expressions:
                    with self.subTest(changed=changed, expression=expression):
                        result = subprocess.run(['terraform', 'console', '-no-color'],
                            input=' '.join(expression.split()) + '\n', cwd=directory, text=True,
                            capture_output=True, timeout=30)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(result.stdout.strip(), 'true' if changed == 'none' else 'false')


if __name__ == '__main__':
    unittest.main()
