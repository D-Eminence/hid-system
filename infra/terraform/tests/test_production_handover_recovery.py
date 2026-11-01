"""The handover's recovery commands must match the helpers they recover.

DEVOPS_HANDOVER.md section 4, "If a helper apply stops part-way", releases the
lease the infrastructure helper keeps after an uncertain apply; AWS cost item 2
puts the ECR rules back. These commands are run by hand against production, so
they must stay in step with the code.
"""
import importlib.util
import json
import pathlib
import re
import sys
import unittest
import uuid

TERRAFORM = pathlib.Path(__file__).resolve().parents[1]
HANDOVER = (TERRAFORM.parent/'DEVOPS_HANDOVER.md').read_text()
sys.path.insert(0, str(TERRAFORM/'scripts'))
spec = importlib.util.spec_from_file_location('core', TERRAFORM/'scripts/production_deployment_core.py')
core = importlib.util.module_from_spec(spec); spec.loader.exec_module(core)


def section(title, end):
    start = HANDOVER.index(title)
    return HANDOVER[start:HANDOVER.index(end, start)]


def option(block, name):
    match = re.search('--'+name+r" (?:'([^']*)'|(\S+))", block)
    return match.group(1) if match.group(1) is not None else match.group(2)


class LeaseRecovery(unittest.TestCase):
    block = section('### If a helper apply stops part-way', '### Emergency contacts')
    release = next(line for line in block.splitlines() if 'dynamodb update-item' in line)

    def helper_release(self):
        calls = []
        class Aws:
            def call(self, service, operation, arguments, mutation=False):
                calls.append((service, operation, arguments, mutation))
        lease = core.Lease(Aws(), 'terraform-'+uuid.uuid4().hex, table='hid-staging-deployment-leases')
        lease.generation = '7'
        lease.release(reconciled=True)
        self.assertEqual(len(calls), 1)
        return calls[0][2]

    def test_release_is_the_helpers_own_release_with_an_expiry_condition(self):
        expected = self.helper_release()
        self.assertEqual(option(self.release, 'table-name'), expected['TableName'])
        self.assertEqual(option(self.release, 'update-expression'), expected['UpdateExpression'])
        self.assertEqual(option(self.release, 'condition-expression'),
                         expected['ConditionExpression']+' AND expires_at < :now')
        key = re.search(r"'(\{\"environment\"[^']*)' \| Set-Content -Encoding ascii lease-key\.json", self.block).group(1)
        self.assertEqual(json.loads(key), expected['Key'])
        names = re.search(r"'(\{[^']*)' \| Set-Content -Encoding ascii lease-names\.json", self.block).group(1)
        self.assertEqual(json.loads(names), expected['ExpressionAttributeNames'])
        values = next(line for line in self.block.splitlines() if 'lease-values.json' in line and 'ConvertTo-Json' in line)
        self.assertEqual(set(re.findall(r"'(:[a-z]+)' =", values)), set(expected['ExpressionAttributeValues'])|{':now'})
        self.assertIn("':ready' = @{ S = 'ready' }", values)
        self.assertIn('--key file://lease-key.json', self.release)

    def test_reads_the_lease_consistently_from_the_same_table(self):
        read = next(line for line in self.block.splitlines() if 'dynamodb get-item' in line)
        self.assertEqual(option(read, 'table-name'), 'hid-staging-deployment-leases')
        self.assertIn('--consistent-read', read)

    def test_releases_only_a_terraform_helper_lease(self):
        pattern = re.search(r"-notmatch '([^']+)'", self.block).group(1)
        source = (TERRAFORM/'scripts/production_release_infrastructure.py').read_text()
        self.assertIn("Lease(aws,'terraform-'+uuid.uuid4().hex)", source)
        self.assertTrue(re.search(pattern, 'terraform-'+uuid.uuid4().hex))
        for other in ('backend-41333594692-1-124c45a5cdf6c1c7', 'production-bootstrap-'+uuid.uuid4().hex,
                      'terraform-'+uuid.uuid4().hex+'x', 'xterraform-'+uuid.uuid4().hex):
            self.assertFalse(re.search(pattern, other), other)


class EcrRecovery(unittest.TestCase):
    item = section('#### 2. ECR clean-up', '#### 3. Worker scaling on dead metrics')

    def test_part_way_recovery_puts_back_the_dry_run_rules(self):
        self.assertIn('Set-Content -Encoding ascii ecr-new-rules.json', self.item)
        recovery = self.item[self.item.index('If the apply stops part-way:'):self.item.index('Rollback:')]
        put = next(line for line in recovery.splitlines() if 'put-lifecycle-policy' in line)
        self.assertIn('foreach ($r in $missing)', put)
        self.assertIn('--lifecycle-policy-text file://ecr-new-rules.json', put)
        self.assertIn("'LifecyclePolicyNotFoundException'", recovery)
        self.assertIn('If a helper apply stops part-way', recovery)
        self.assertNotIn('run it again.', self.item.split('Before applying, back up')[0])


if __name__ == '__main__':
    unittest.main()
