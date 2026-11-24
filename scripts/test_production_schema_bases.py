"""The candidate's two schema bases on real git histories, then production's plan binding.

B is the push's base (github.event.before, HEAD^ for a dispatch) and R the released base (the select
job's released_base: the last push run that deployed). The declaration D must hold this push's change and
may hold files earlier pushes left pending since R: schema(B) <= D <= schema(R), each migration new since R
and a migration this push changed new in this push too. migrate() then applies only when production's
pending (name, sha256) set equals D's migrations, so it decides what a failed release left behind.
"""
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import production_deployment_core as c
import production_deployment as b
from test_production_deployment_core import ctx, image, index

M = c.MIGRATIONS
M1, M2, M3, M4 = (M+name for name in ('0001_applied.sql','0002_second.sql','0003_third.sql','0004_fourth.sql'))
CODE = 'services/ehr-api/src/app.service.ts'


class Lease:
    def assert_owned(self): pass


class History:
    """A throwaway repository on the release branch and the migrations production has applied."""

    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.applied = {}
        self.git('init', '-q')

    def git(self, *args):
        return c.git(*args, cwd=self.root)

    def write(self, name, text):
        (self.root/name).parent.mkdir(parents=True, exist_ok=True)
        (self.root/name).write_text(text)

    def declare(self, *names):
        c.atomic_json(self.root/'config/production-schema-compatibility.json', {'schema': 'hid.schema-compatibility/v1',
            'backward_compatible': True, 'reviewed_by': 'HID reviewer', 'evidence': 'fictional rehearsal',
            'files': {n: c.file_sha(self.root/n) for n in names}})

    def commit(self, message):
        self.git('add', '-A')
        self.git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def at(self, commit):
        self.git('checkout', '-q', '--detach', commit)

    def candidate(self, before, released=None, migration_image=True):
        with patch.dict(os.environ, {'BASE_SHA': before, 'RELEASED_BASE_SHA': released or ''}):
            return c.candidate_schema_change(self.root, migration_image)

    def files(self):
        folder = self.root/M
        return {p.name: c.file_sha(p) for p in sorted(folder.glob('*.sql'))} if folder.exists() else {}

    def commit_applied(self, *names):
        """Production commits these files as they are at HEAD (a release's apply, file by file)."""
        self.applied.update({pathlib.PurePosixPath(n).name: c.file_sha(self.root/n) for n in names})

    def deploy(self, contract):
        """Runs the real migrate() against a fake migration task that reports production's plan."""
        history, started = self, []
        task = {'family': 'hid-staging-database-migration', 'networkMode': 'awsvpc',
            'runtimePlatform': {'cpuArchitecture': 'ARM64'},
            'taskRoleArn': 'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-task',
            'executionRoleArn': 'arn:aws:iam::'+c.ACCOUNT+':role/hid-staging-exec',
            'containerDefinitions': [{'name': 'database-migration', 'image': image('database-migration')}],
            'taskDefinitionArn': index()['migration_task_definition']}

        class AWS:
            def call(self, service, operation, args, **kwargs):
                files = history.files()
                # The runner refuses an applied file whose bytes changed, even in plan mode.
                edited = any(files.get(name) != digest for name, digest in history.applied.items())
                pending = [(name, digest) for name, digest in files.items() if name not in history.applied]
                if operation == 'register-task-definition':
                    return {'taskDefinition': {**args, 'taskDefinitionArn': task['taskDefinitionArn']}}
                if operation == 'run-task':
                    command = args['overrides']['containerOverrides'][0]['command']
                    started.append(command[1:] or ['apply'])
                    if command[1:] == [] and not edited: history.applied.update(pending)
                    return {'tasks': [{'taskArn': 'task/'+str(len(started))}]}
                if operation == 'describe-tasks':
                    return {'tasks': [{'lastStatus': 'STOPPED', 'containers': [{'exitCode': 1 if edited else 0}]}]}
                if operation == 'get-log-events':
                    return {'events': [{'message': str(len(pending))+' pending migration(s)'}]
                        + [{'message': name+' '+digest} for name, digest in pending]}
                raise AssertionError(operation)

        ecs = b.ECS(AWS(), Lease())
        with patch.object(ecs, 'definition', return_value=task), patch.object(ecs, 'protect_image'), \
                patch.object(b.time, 'sleep'):
            ecs.migrate(image('database-migration', 'b'), contract, {'migration_task_definition': task['taskDefinitionArn'],
                'migration_network': index()['migration_network']}, 'release')
        return started


class SchemaBaseTests(unittest.TestCase):
    def history(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        h = History(folder.name)
        # The released commit L: 0001 and the role bootstrap, applied in production.
        h.write(M1, 'select 1;'); h.write(c.RUNTIME_GRANTS, 'grant 1;'); h.write(CODE, 'v1')
        h.declare(M1, c.RUNTIME_GRANTS)
        h.released = h.commit('L')
        h.commit_applied(M1)
        return h

    def failed_release_adding(self, h, *names):
        for name in names: h.write(name, 'select '+pathlib.PurePosixPath(name).stem+';')
        h.declare(*names)
        failed = h.commit('F adds '+', '.join(names))
        contract = h.candidate(h.released, h.released)
        self.assertEqual(sorted(contract['files']), sorted(names))
        self.assertNotIn('from_earlier_pushes', contract)
        return failed

    def test_a_release_a_after_its_failures_ships_at_the_next_push_without_a_carrier(self):
        # #294 added 0128-0137 and the grants and failed before applying; the retry (#306/#309) changed no
        # database file and failed too; #313 edited the pending 0136 in place and re-signed; #308 followed.
        h = self.history()
        h.write(c.RUNTIME_GRANTS, 'grant 2;')
        for name in (M2, M3, M4): h.write(name, 'select '+pathlib.PurePosixPath(name).stem+';')
        h.declare(M2, M3, M4, c.RUNTIME_GRANTS)
        first = h.commit('#294 Release A')
        self.assertTrue(h.candidate(h.released, h.released)['changed'])
        # The retry has no database change of its own: it declares what the failed release left pending.
        h.write('services/ehr-api/scripts/apply-migrations.mjs', 'retry within a bound')
        retry = h.commit('#306/#309 retry')
        contract = h.candidate(first, h.released)
        self.assertEqual(sorted(contract['files']), sorted([M2, M3, M4, c.RUNTIME_GRANTS]))
        self.assertEqual(contract['from_earlier_pushes'], sorted([M2, M3, M4, c.RUNTIME_GRANTS]))
        self.assertNotIn('carried', contract)
        # #313 edits the pending 0003 in place and re-signs: that push ships itself, no carrier. Production
        # never committed 0003, so its pending set is exactly the re-signed declaration and the release applies it.
        h.write(M3, 'select raised_maximums;'); h.declare(M2, M3, M4, c.RUNTIME_GRANTS)
        edit = h.commit('#313 edits the pending 0003 and re-signs')
        contract = h.candidate(retry, h.released)
        self.assertEqual(c.migration_files(contract), [M2, M3, M4])
        self.assertEqual(contract['from_earlier_pushes'], sorted([M2, M4, c.RUNTIME_GRANTS]))
        self.assertEqual(h.deploy(contract), [['--plan'], ['--dry-run'], ['apply'], ['--plan']])
        self.assertEqual(set(h.applied), {'0001_applied.sql', '0002_second.sql', '0003_third.sql', '0004_fourth.sql'})
        self.assertEqual(h.applied['0003_third.sql'], c.file_sha(h.root/M3))
        # #308 followed with code only: #313 deployed and is the released base, so nothing is pending.
        h.write(CODE, 'v2'); h.commit('#308')
        self.assertEqual(h.candidate(edit, edit), {'changed': False})

    def test_b_after_a_release_that_failed_production_decides_what_is_declared(self):
        for committed in (True, False):
            with self.subTest(failed_release_committed_0002=committed):
                h = self.history()
                failed = self.failed_release_adding(h, M2)
                if committed: h.commit_applied(M2)        # migrated, then the rollout timed out
                # This push adds 0003; it declares 0003 and, if production still has it pending, 0002.
                right, wrong = ([M3], [M2, M3]) if committed else ([M2, M3], [M3])
                for names in (right, wrong):
                    h.at(failed); h.write(M3, 'select 3;'); h.declare(*names)
                    h.commit('H adds 0003, declares '+', '.join(n[len(M):len(M)+4] for n in names))
                    contract = h.candidate(failed, h.released)
                    self.assertEqual(sorted(contract['files']), sorted(names))
                    applied = dict(h.applied)
                    if names == right:
                        self.assertEqual(h.deploy(contract)[-1], ['--plan'])
                        self.assertIn('0003_third.sql', h.applied)
                    else:
                        with self.assertRaisesRegex(c.ReleaseError, 'UNREVIEWED_PENDING_MIGRATIONS'): h.deploy(contract)
                        self.assertEqual(h.applied, applied)
                    h.applied = applied
                # A declaration outside schema(R) (0001 was released) or missing this push's 0003 is refused.
                for names, code in (([M1, M3], 'SCHEMA_DECLARATION_BEYOND_RELEASED_BASE'),
                                    ([M2], 'SCHEMA_DECLARATION_MISSES_THIS_PUSH_CHANGE')):
                    h.at(failed); h.write(M3, 'select 3;'); h.declare(*names); h.commit('H declares badly')
                    with self.assertRaisesRegex(c.ReleaseError, code): h.candidate(failed, h.released)
                # Without a released base the push's before is the only base, as before: 0002 cannot be declared.
                h.at(failed); h.write(M3, 'select 3;'); h.declare(M2, M3); h.commit('H')
                with self.assertRaisesRegex(c.ReleaseError, 'SCHEMA_DECLARATION_BEYOND_RELEASED_BASE'): h.candidate(failed)

    def test_c_migrations_a_dispatch_applied_are_declared_by_production_not_by_the_released_base(self):
        h = self.history()
        failed = self.failed_release_adding(h, M2)
        # A dispatch on F (no released base, HEAD^ as its base) declares and applies 0002.
        dispatched = h.candidate(h.git('rev-parse', 'HEAD^'))
        self.assertEqual(list(dispatched['files']), [M2])
        h.deploy(dispatched)
        self.assertIn('0002_second.sql', h.applied)
        # Dispatch runs are never a released base, so R is still L; the next push declares only 0003.
        h.write(M3, 'select 3;'); h.declare(M3); h.commit('H adds 0003')
        contract = h.candidate(failed, h.released)
        self.assertEqual(list(contract['files']), [M3])
        self.assertEqual(h.deploy(contract)[0], ['--plan'])
        self.assertIn('0003_third.sql', h.applied)

    def test_d_an_edit_of_a_pending_migration_passes_the_candidate_and_production_decides(self):
        for committed in (False, True):
            with self.subTest(failed_release_committed_0002=committed):
                h = self.history()
                failed = self.failed_release_adding(h, M2)
                old = c.file_sha(h.root/M2)
                if committed: h.commit_applied(M2)
                h.write(M2, 'select 22;'); h.declare(M2); h.commit('H edits the pending 0002 and re-signs')
                contract = h.candidate(failed, h.released)
                self.assertEqual(contract['files'], {M2: c.file_sha(h.root/M2)})
                if committed:
                    # The failed release committed the old bytes: the plan step refuses before any change.
                    self.assertEqual(h.applied['0002_second.sql'], old)
                    applied = dict(h.applied)
                    with self.assertRaisesRegex(c.ReleaseError, 'MIGRATION_FAILED'): h.deploy(contract)
                    self.assertEqual(h.applied, applied)
                else:
                    h.deploy(contract)
                    self.assertEqual(h.applied['0002_second.sql'], c.file_sha(h.root/M2))
                # Without a released base the push's before is the only base, as before: the edit is refused.
                with self.assertRaisesRegex(c.ReleaseError, 'ONLY_NEW_REVIEWED_SCHEMA_FILES_ALLOWED'): h.candidate(failed)
        h = self.history()
        failed = self.failed_release_adding(h, M2)
        # An edit of a released migration is not new since R either.
        h.at(failed); h.write(M1, 'select 11;'); h.write(M3, 'select 3;'); h.declare(M1, M3); h.commit('H edits 0001')
        with self.assertRaisesRegex(c.ReleaseError, 'ONLY_NEW_REVIEWED_SCHEMA_FILES_ALLOWED'): h.candidate(failed, h.released)
        # A push may still change, in a later commit of the same push, a file it adds itself.
        h.at(failed); h.write(M3, 'select 3;'); h.declare(M3); h.commit('H1 adds 0003')
        h.write(M3, 'select 33;'); h.declare(M3); h.commit('H2 reworks 0003 before the push')
        self.assertEqual(list(h.candidate(failed, h.released)['files']), [M3])

    def test_e_a_push_with_no_database_change_declares_what_is_pending_or_nothing(self):
        h = self.history()
        failed = self.failed_release_adding(h, M2)
        h.write(CODE, 'v2'); released = h.commit('H changes code only')
        contract = h.candidate(failed, h.released)
        self.assertEqual((list(contract['files']), contract['from_earlier_pushes']), ([M2], [M2]))
        with self.assertRaisesRegex(c.ReleaseError, 'MIGRATION_IMAGE_REQUIRED'): h.candidate(failed, h.released, False)
        h.deploy(contract)
        self.assertIn('0002_second.sql', h.applied)
        # H deployed, so it is the released base. The next code-only push declares nothing, and with
        # nothing pending production's plan agrees; the declaration on file names released files only.
        h.write(CODE, 'v3'); h.commit('J changes code only')
        self.assertEqual(h.candidate(released, released), {'changed': False})
        self.assertEqual(h.candidate(released, released, False), {'changed': False})
        self.assertEqual(h.deploy({'changed': False}), [['--plan']])
        # Without a released base it is today's rule: the reviewed declaration is carried.
        self.assertTrue(h.candidate(released)['carried'])
        self.assertEqual(h.candidate(released, None, False), {'changed': False})
        # An empty declaration declares nothing too.
        h.at(failed); h.write(CODE, 'v2')
        c.atomic_json(h.root/'config/production-schema-compatibility.json', {'schema': 'hid.schema-compatibility/v1',
            'backward_compatible': True, 'reviewed_by': 'HID reviewer', 'evidence': 'none', 'files': {}})
        h.commit('H empties the declaration')
        self.assertEqual(h.candidate(failed, h.released), {'changed': False})

    def test_f_a_partial_apply_then_an_in_place_fix_ships_itself(self):
        h = self.history()
        failed = self.failed_release_adding(h, M2, M3)
        h.commit_applied(M2)                              # 0002 committed, 0003 failed and rolled back
        # The fix edits 0003 in place and declares only what is pending, {0003}: it passes and ships.
        h.write(M3, 'select fixed;'); h.declare(M3); h.commit('H fixes 0003 in place')
        contract = h.candidate(failed, h.released)
        self.assertEqual(contract['files'], {M3: c.file_sha(h.root/M3)})
        applied = dict(h.applied)
        h.deploy(contract)
        self.assertEqual(h.applied['0003_third.sql'], c.file_sha(h.root/M3))
        # Declaring the committed 0002 as well passes the candidate but not production's pending check.
        h.applied = dict(applied)
        h.at(failed); h.write(M3, 'select fixed;'); h.declare(M2, M3); h.commit('H declares 0002 again')
        with self.assertRaisesRegex(c.ReleaseError, 'UNREVIEWED_PENDING_MIGRATIONS'): h.deploy(h.candidate(failed, h.released))
        self.assertEqual(h.applied, applied)
        # Unchanged 0003 (a busy lock, a timeout): the next push of any kind declares only {0003}.
        h.at(failed); h.declare(M3); h.write(CODE, 'v2'); h.commit('H declares the pending 0003')
        contract = h.candidate(failed, h.released)
        self.assertEqual(list(contract['files']), [M3])
        h.deploy(contract)
        self.assertEqual(set(h.applied), {'0001_applied.sql', '0002_second.sql', '0003_third.sql'})

    def test_the_released_base_must_be_a_known_ancestor(self):
        h = self.history()
        failed = self.failed_release_adding(h, M2)
        for released, code in (('abc', 'KNOWN_RELEASED_BASE_REQUIRED'), ('0'*40, 'KNOWN_RELEASED_BASE_REQUIRED'),
                               ('f'*40, 'RELEASED_BASE_NOT_AN_ANCESTOR')):
            with self.assertRaisesRegex(c.ReleaseError, code): h.candidate(h.released, released)
        h.at(h.released); h.write(CODE, 'elsewhere'); other = h.commit('not on the branch')
        h.at(failed)
        with self.assertRaisesRegex(c.ReleaseError, 'RELEASED_BASE_NOT_AN_ANCESTOR'): h.candidate(h.released, other)

    def test_the_approval_summary_names_files_from_earlier_pushes(self):
        h = self.history()
        failed = self.failed_release_adding(h, M2)
        h.write(M3, 'select 3;'); h.declare(M2, M3); h.commit('H')
        contract = h.candidate(failed, h.released)
        self.assertEqual(contract['from_earlier_pushes'], [M2])
        release = c.make_candidate(ctx(), ['database-migration'], {'database-migration': {'image_uri': image('database-migration')}},
            {'select': 'success'}, schema=contract)
        with patch.dict(os.environ, {'GITHUB_STEP_SUMMARY': ''}):
            text = c.summarize(release)
        self.assertIn('Schema changes: True (declares files earlier pushes left pending: 0002_second.sql; applies only if '
                      "production's pending migrations are exactly: 0002_second.sql, 0003_third.sql)", text)


if __name__ == '__main__':
    unittest.main()
