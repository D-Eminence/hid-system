import copy
import unittest
from unittest.mock import patch
import production_deployment_core as c
import production_release_infrastructure as r
from test_production_deployment_core import image, index

ARN = 'arn:aws:ecs:' + c.REGION + ':' + c.ACCOUNT + ':task-definition/'
MIGRATION = ARN + 'hid-staging-database-migration:1'


class FakeLease:
    def __init__(self, lose_at=None):
        self.lose_at, self.released, self.owned_checks = lose_at, None, 0
    def acquire(self): return self
    def assert_owned(self):
        self.owned_checks += 1
        if self.owned_checks == self.lose_at: raise c.ReleaseError('LEASE_LOST')
    def release(self, reconciled=True): self.released = reconciled


class FakeStore:
    def __init__(self, value, fail_put=False, readback_differs=False):
        self.value, self.fail_put, self.readback_differs, self.puts = value, fail_put, readback_differs, []
    def read(self, key, version=None):
        assert key == c.INDEX_KEY
        if version:
            saved = copy.deepcopy(self.puts[-1][1])
            if self.readback_differs: saved['backend']['ocr-worker']['config_sha256'] = '0' * 64
            return saved, {'VersionId': version}
        return copy.deepcopy(self.value), {'VersionId': 'v1', 'ETag': '"etag-1"'}
    def put(self, key, value, etag=None):
        if self.fail_put: raise c.ReleaseError('S3_FAILED')
        self.puts.append((key, copy.deepcopy(value), etag))
        return {'VersionId': 'v2'}


class FakeAWS:
    def __init__(self, migration_image=None):
        self.migration_image, self.described = migration_image or image('database-migration'), []
    def call(self, service, operation, args, **kwargs):
        assert (service, operation) == ('ecs', 'describe-task-definition'), (service, operation)
        self.described.append(args['taskDefinition'])
        return {'taskDefinition': {'taskDefinitionArn': args['taskDefinition'],
                'containerDefinitions': [{'name': 'database-migration', 'image': self.migration_image}]}}


def live_rows(value, **changes):
    rows = {n: r.physical(row) for n, row in value['backend'].items()}
    for name, row in changes.items(): rows[name] = {**rows[name], **row}
    return rows


OCR = {'task_definition': ARN + 'hid-production-ocr-worker:2', 'config_sha256': 'd' * 64}


class ReconcileTests(unittest.TestCase):
    def run_reconcile(self, live, expected=('ocr-worker',), sha=None, store=None, aws=None, lease=None,
                      migration=None):
        self.store = store or FakeStore(index()); self.lease = lease or FakeLease(); self.aws = aws or FakeAWS()
        with patch.object(r, 'live_backend', return_value=live):
            return r.reconcile(self.aws, self.store, list(expected), sha, migration,
                               make_lease=lambda: self.lease)

    def dry_sha(self, live, **kwargs):
        result = self.run_reconcile(live, **kwargs)
        self.assertEqual(result['status'], 'dry-run'); self.assertFalse(result['index_written'])
        self.assertEqual(self.store.puts, [])
        return result['drift_sha256']

    def test_dry_run_prints_exact_rows_and_writes_nothing(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        result = self.run_reconcile(live)
        self.assertEqual(result['drift']['before'], {'ocr-worker': r.physical(index()['backend']['ocr-worker'])})
        self.assertEqual(result['drift']['after'], {'ocr-worker': live['ocr-worker']})
        self.assertEqual(result['drift']['index_version_id'], 'v1')
        self.assertEqual(result['drift_sha256'], c.sha(c.canonical(result['drift'])))
        self.assertEqual(self.store.puts, []); self.assertTrue(self.lease.released)

    def test_happy_path_writes_exactly_the_live_rows(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        digest = self.dry_sha(live)
        result = self.run_reconcile(live, sha=digest)
        self.assertEqual(result['status'], 'reconciled'); self.assertEqual(result['recorded'], ['ocr-worker'])
        self.assertEqual(len(self.store.puts), 1)
        key, written, etag = self.store.puts[0]
        self.assertEqual((key, etag), (c.INDEX_KEY, '"etag-1"'))
        expected = index(); expected['backend']['ocr-worker'].update(OCR)
        self.assertEqual(written, expected)
        self.assertEqual(written['backend']['ocr-worker']['source_commit'], 'c' * 40)
        self.assertTrue(self.lease.released)

    def test_refuses_an_application_image_change(self):
        live = live_rows(index(), **{'ocr-worker': dict(OCR, image_uri=image('ocr-worker', 'e'))})
        with self.assertRaisesRegex(c.ReleaseError, 'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE'): self.run_reconcile(live)
        self.assertEqual(self.store.puts, [])

    def test_refuses_an_unexpected_or_missing_component(self):
        lab = {'task_definition': ARN + 'hid-production-lab-api:2', 'config_sha256': 'e' * 64}
        live = live_rows(index(), **{'ocr-worker': OCR, 'lab-api': lab})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_UNEXPECTED_DRIFT'): self.run_reconcile(live)
        live = live_rows(index(), **{'ocr-worker': OCR})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_UNEXPECTED_DRIFT'):
            self.run_reconcile(live, expected=('ocr-worker', 'lab-api'))
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_EXPECTED_DRIFT_REQUIRED'):
            self.run_reconcile(live, expected=())
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_EXPECTED_DRIFT_REQUIRED'):
            self.run_reconcile(live, expected=('not-a-service',))
        self.assertEqual(self.store.puts, [])

    def test_refuses_a_lower_equal_or_foreign_revision(self):
        for arn in (ARN + 'hid-production-ocr-worker:1', ARN + 'hid-production-ocr-worker:0',
                    ARN + 'hid-production-ocr-api:5', 'not-an-arn'):
            live = live_rows(index(), **{'ocr-worker': dict(OCR, task_definition=arn)})
            with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_(REVISION_NOT_NEWER|TASK_DEFINITION_INVALID)'):
                self.run_reconcile(live)
        self.assertEqual(self.store.puts, [])

    def test_refuses_a_wrong_sha_and_a_changed_index(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_REVIEW_REQUIRED'): self.run_reconcile(live, sha='0' * 64)
        self.assertEqual(self.store.puts, [])
        digest = self.dry_sha(live)
        moved = index(); moved['backend']['lab-api']['source_commit'] = 'f' * 40
        class Moved(FakeStore):
            def read(self, key, version=None):
                value, meta = super().read(key, version)
                return value, (meta if version else {'VersionId': 'v9', 'ETag': '"etag-9"'})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_REVIEW_REQUIRED'):
            self.run_reconcile(live, sha=digest, store=Moved(moved))

    def test_refuses_an_empty_diff(self):
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_NOTHING_TO_RECORD'):
            self.run_reconcile(live_rows(index()))

    def test_lease_loss_at_the_check_before_the_put_writes_nothing_and_keeps_the_lease(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        digest = self.dry_sha(live)
        self.run_reconcile(live, sha=digest)
        checks = self.lease.owned_checks
        lost = FakeLease(lose_at=checks)
        with self.assertRaisesRegex(c.ReleaseError, 'LEASE_LOST'):
            self.run_reconcile(live, sha=digest, lease=lost)
        self.assertEqual(lost.owned_checks, checks)
        self.assertEqual(self.store.puts, []); self.assertFalse(lost.released)

    def test_read_back_mismatch_keeps_the_lease(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        digest = self.dry_sha(live)
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_READBACK_DIFFERS'):
            self.run_reconcile(live, sha=digest, store=FakeStore(index(), readback_differs=True))
        self.assertEqual(len(self.store.puts), 1); self.assertFalse(self.lease.released)

    def test_refuses_to_write_an_invalid_index(self):
        live = live_rows(index(), **{'ocr-worker': dict(OCR, config_sha256='not-a-hash')})
        digest = self.dry_sha(live)
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_CONFIGURATION_HASH_REQUIRED'):
            self.run_reconcile(live, sha=digest)
        self.assertEqual(self.store.puts, [])

    def test_migration_task_definition_is_named_exactly_when_migration_is_expected(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_MIGRATION_TASK_DEFINITION_REQUIRED'):
            self.run_reconcile(live, expected=('ocr-worker', 'migration'), migration=None)
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_MIGRATION_TASK_DEFINITION_REQUIRED'):
            self.run_reconcile(live, migration=ARN + 'hid-staging-database-migration:2')
        self.run_reconcile(live)
        self.assertEqual(self.aws.described, [MIGRATION])

    def test_recorded_migration_must_still_hold_the_recorded_image(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        with self.assertRaisesRegex(c.ReleaseError, 'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE'):
            self.run_reconcile(live, aws=FakeAWS(image('database-migration', 'e')))

    def test_failed_put_keeps_the_lease_for_recovery(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        digest = self.dry_sha(live)
        with self.assertRaisesRegex(c.ReleaseError, 'S3_FAILED'):
            self.run_reconcile(live, sha=digest, store=FakeStore(index(), fail_put=True))
        self.assertFalse(self.lease.released)

    def test_refuses_live_state_that_moves_before_the_write(self):
        live = live_rows(index(), **{'ocr-worker': OCR})
        digest = self.dry_sha(live)
        moved = live_rows(index(), **{'ocr-worker': dict(OCR, config_sha256='9' * 64)})
        self.store = FakeStore(index()); self.lease = FakeLease()
        with patch.object(r, 'live_backend', side_effect=[live, moved]):
            with self.assertRaisesRegex(c.ReleaseError, 'LIVE_STATE_CHANGED_DURING_RECONCILE'):
                r.reconcile(FakeAWS(), self.store, ['ocr-worker'], digest, None, make_lease=lambda: self.lease)
        self.assertEqual(self.store.puts, [])

    def test_migration_drift_must_be_expected_and_keep_its_image(self):
        newer = ARN + 'hid-staging-database-migration:2'
        live = live_rows(index(), **{'ocr-worker': OCR})
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_UNEXPECTED_DRIFT'):
            self.run_reconcile(live, expected=('ocr-worker', 'migration'), migration=MIGRATION)
        with self.assertRaisesRegex(c.ReleaseError, 'INDEX_RECONCILE_REVISION_NOT_NEWER'):
            self.run_reconcile(live, expected=('ocr-worker', 'migration'), migration=ARN + 'hid-staging-database-migration:0')
        with self.assertRaisesRegex(c.ReleaseError, 'INFRASTRUCTURE_CHANGED_APPLICATION_IMAGE'):
            self.run_reconcile(live, expected=('ocr-worker', 'migration'), migration=newer,
                               aws=FakeAWS(image('database-migration', 'e')))
        digest = self.dry_sha(live, expected=('ocr-worker', 'migration'), migration=newer)
        self.run_reconcile(live, expected=('ocr-worker', 'migration'), sha=digest, migration=newer)
        self.assertEqual(self.store.puts[0][1]['migration_task_definition'], newer)
        self.assertEqual(self.store.puts[0][1]['migration_image_uri'], image('database-migration'))


if __name__ == '__main__': unittest.main()
