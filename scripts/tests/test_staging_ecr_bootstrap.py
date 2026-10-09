import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "ecr_bootstrap", Path(__file__).parents[1] / "check-staging-ecr-bootstrap.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def response(value=None, returncode=0, stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=json_text(value), stderr=stderr)


def json_text(value):
    import json
    return "" if value is None else json.dumps(value)


class EcrBootstrapCheckTest(unittest.TestCase):
    def successful_call(self):
        calls = []

        def call(arguments):
            calls.append(arguments)
            command = arguments[0:2]
            if command == ["sts", "get-caller-identity"]:
                return response({"Account": bootstrap.ACCOUNT})
            if command == ["ssm", "get-parameter"]:
                return response({"Parameter": {
                    "Name": bootstrap.CDK_BOOTSTRAP_VERSION_PARAMETER,
                    "Value": "6",
                }})
            if command == ["cloudformation", "describe-stacks"]:
                return response(returncode=255, stderr="ValidationError: Stack with id Hid-staging-Regional does not exist")
            if command == ["ecr", "describe-repositories"]:
                return response(returncode=254, stderr="RepositoryNotFoundException")
            self.fail(f"unexpected call: {arguments}")

        return calls, call

    def test_reads_only_fixed_staging_absence_inputs(self):
        calls, call = self.successful_call()
        report = bootstrap.check(call)
        self.assertTrue(report["bootstrap_absence_confirmed"])
        self.assertFalse(report["deployment_authorized"])
        self.assertFalse(report["cloud_mutations"])
        self.assertEqual(report["application_repository_count"], 11)
        self.assertEqual(len(report["application_repository_set_sha256"]), 64)
        self.assertEqual(calls[0], ["sts", "get-caller-identity"])
        self.assertEqual(calls[1], ["ssm", "get-parameter", "--name", bootstrap.CDK_BOOTSTRAP_VERSION_PARAMETER])
        self.assertEqual(calls[2], ["cloudformation", "describe-stacks", "--stack-name", bootstrap.STACK_NAME])
        self.assertEqual([call[0:2] for call in calls[3:]], [["ecr", "describe-repositories"]] * 11)
        self.assertEqual([call[-1] for call in calls[3:]], list(bootstrap.APPLICATION_REPOSITORIES))

    def test_wrong_account_stops_before_any_resource_read(self):
        calls = []

        def call(arguments):
            calls.append(arguments)
            return response({"Account": "000000000000"})

        with self.assertRaisesRegex(bootstrap.BootstrapReadError, "wrong_account"):
            bootstrap.check(call)
        self.assertEqual(calls, [["sts", "get-caller-identity"]])

    def test_present_stack_or_repository_fails_closed(self):
        calls, call = self.successful_call()

        def stack_present(arguments):
            if arguments[0:2] == ["cloudformation", "describe-stacks"]:
                return response({"Stacks": [{"StackName": bootstrap.STACK_NAME}]})
            return call(arguments)

        with self.assertRaisesRegex(bootstrap.BootstrapReadError, "regional_stack_present"):
            bootstrap.check(stack_present)

        calls, call = self.successful_call()
        repository_calls = 0

        def repository_present(arguments):
            nonlocal repository_calls
            if arguments[0:2] == ["ecr", "describe-repositories"]:
                repository_calls += 1
                if repository_calls == 1:
                    return response({"repositories": [{"repositoryName": bootstrap.APPLICATION_REPOSITORIES[0]}]})
            return call(arguments)

        with self.assertRaisesRegex(bootstrap.BootstrapReadError, "application_repository_present"):
            bootstrap.check(repository_present)

    def test_rejects_old_bootstrap_or_indeterminate_absence(self):
        calls, call = self.successful_call()

        def old_bootstrap(arguments):
            if arguments[0:2] == ["ssm", "get-parameter"]:
                return response({"Parameter": {
                    "Name": bootstrap.CDK_BOOTSTRAP_VERSION_PARAMETER,
                    "Value": "5",
                }})
            return call(arguments)

        with self.assertRaisesRegex(bootstrap.BootstrapReadError, "cdk_bootstrap_version_rejected"):
            bootstrap.check(old_bootstrap)

        calls, call = self.successful_call()

        def denied_repository(arguments):
            if arguments[0:2] == ["ecr", "describe-repositories"]:
                return response(returncode=255, stderr="AccessDeniedException")
            return call(arguments)

        with self.assertRaisesRegex(bootstrap.BootstrapReadError, "denied_or_unavailable"):
            bootstrap.check(denied_repository)

    def test_expired_session_category_never_reflects_cli_error_text(self):
        result = SimpleNamespace(returncode=1, stdout="", stderr="Token expired: SECRET-SENTINEL")
        with patch.object(bootstrap.subprocess, "run", return_value=result), self.assertRaises(
                bootstrap.BootstrapReadError) as raised:
            bootstrap.json_success(bootstrap.aws_command(["sts", "get-caller-identity"]))
        self.assertNotIn("SECRET-SENTINEL", str(raised.exception))

    def test_stack_absence_requires_validation_error_for_the_exact_stack(self):
        messages = (
            "ValidationError: Role with id staging-reader does not exist",
            "ValidationError: Stack with id Hid-other-Regional does not exist",
            "AccessDeniedException: Stack with id Hid-staging-Regional does not exist",
            "Stack with id Hid-staging-Regional does not exist",
        )
        for message in messages:
            with self.subTest(message=message):
                calls, call = self.successful_call()

                def ambiguous_missing(arguments):
                    if arguments[0:2] == ["cloudformation", "describe-stacks"]:
                        return response(returncode=255, stderr=message)
                    return call(arguments)

                with self.assertRaisesRegex(bootstrap.BootstrapReadError, "denied_or_unavailable"):
                    bootstrap.check(ambiguous_missing)
                self.assertFalse(any(arguments[0] == "ecr" for arguments in calls))

    def test_private_receipt_is_new_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            bootstrap.write_new_private_receipt(path, "{}\n")
            self.assertEqual(path.read_text(), "{}\n")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(bootstrap.BootstrapReadError, "binding_or_output_rejected"):
                bootstrap.write_new_private_receipt(path, "{}\n")


if __name__ == "__main__":
    unittest.main()
