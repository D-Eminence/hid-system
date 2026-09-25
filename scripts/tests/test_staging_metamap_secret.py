import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import warnings
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("metamap_secret", Path(__file__).resolve().parents[1] / "staging-metamap-secret.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ARN = "arn:aws:secretsmanager:eu-west-1:659225405023:secret:/hid/staging/nin-metamap-aBc123"


class MetaMapSecretTests(unittest.TestCase):
    def test_wrong_account_stops_before_any_secret_access(self):
        with patch.object(MODULE, "aws", return_value={"Account": "000000000000"}) as aws:
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.store("fixture", prompt=lambda _: self.fail("must not prompt"))
            self.assertEqual(aws.call_count, 1)

    def test_existing_fields_are_preserved_and_secret_is_only_in_stdin(self):
        replies = [{"Account": MODULE.ACCOUNT}, {"ARN": ARN, "VersionIdsToStages": {"one": ["AWSCURRENT"]}},
                   {"ARN": ARN, "SecretString": json.dumps({"clientId": "fixture", "unrelated": "preserve"})}, {"ARN": ARN}]
        value = "synthetic-secret-for-unit-test"
        with patch.object(MODULE, "aws", side_effect=replies) as aws:
            receipt = MODULE.store("fixture", prompt=lambda _: value)
            arguments, = aws.call_args.args
            self.assertNotIn(value, json.dumps(arguments))
            self.assertEqual(arguments[-2:], ["--secret-string", "file:///dev/stdin"])
            self.assertEqual(json.loads(aws.call_args.kwargs["payload"]), {
                "clientId": "fixture", "clientSecret": value, "unrelated": "preserve"})
            self.assertNotIn(value, json.dumps(receipt))
            self.assertFalse(receipt["deployment_authorized"])

    def test_new_secret_name_is_fixed_to_staging(self):
        with patch.object(MODULE, "aws", side_effect=[{"Account": MODULE.ACCOUNT}, None, {"ARN": ARN}]) as aws:
            MODULE.store("fixture", prompt=lambda _: "synthetic-test-secret")
            arguments, = aws.call_args.args
            self.assertEqual(arguments[:4], ["secretsmanager", "create-secret", "--name", MODULE.SECRET_NAME])

    def test_wrong_secret_arn_and_different_client_are_preserved(self):
        cases = [
            [{"Account": MODULE.ACCOUNT}, {"ARN": ARN.replace("/staging/", "/production/")}],
            [{"Account": MODULE.ACCOUNT}, {"ARN": ARN, "VersionIdsToStages": {"one": ["AWSCURRENT"]}},
             {"ARN": ARN, "SecretString": json.dumps({"clientId": "another-client"})}],
        ]
        for replies in cases:
            with self.subTest(replies=replies), patch.object(MODULE, "aws", side_effect=replies) as aws:
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.store("fixture", prompt=lambda _: self.fail("must not prompt"))
                self.assertEqual(aws.call_count, len(replies))

    def test_private_local_client_file_required_and_symlink_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "client.json"
            path.write_text(json.dumps({"clientId": "fixture"}))
            path.chmod(0o600)
            self.assertEqual(MODULE.client_id(path), "fixture")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.client_id(link)
            path.chmod(0o644)
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.client_id(path)

    def test_cli_endpoint_pinned_and_upstream_errors_redacted(self):
        sentinel = "synthetic-upstream-sensitive-text"
        result = subprocess.CompletedProcess([], 1, stdout=sentinel, stderr=sentinel)
        with patch.object(MODULE, "assert_cli_history_disabled"), patch.object(MODULE.subprocess, "run", return_value=result) as run:
            with self.assertRaises(MODULE.SafeFailure) as caught:
                MODULE.aws(["secretsmanager", "put-secret-value"], payload=sentinel)
            self.assertNotIn(sentinel, str(caught.exception))
            command, = run.call_args.args
            self.assertNotIn(sentinel, command)
            self.assertIn("https://secretsmanager.eu-west-1.amazonaws.com", command)
            self.assertEqual(run.call_args.kwargs["input"], sentinel)

    def test_aws_cli_history_is_refused_before_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.write_text("[profile hid-admin]\ncli_history = enabled\n")
            with patch.dict(os.environ, {"AWS_CONFIG_FILE": str(config),
                                         "AWS_SHARED_CREDENTIALS_FILE": str(Path(directory) / "absent")}), \
                    patch.object(MODULE.subprocess, "run") as run:
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.aws(["secretsmanager", "get-secret-value"])
                run.assert_not_called()

    def test_hidden_prompt_cannot_fall_back_to_echoed_input(self):
        def unavailable(_):
            warnings.warn("Cannot control echo", MODULE.getpass.GetPassWarning)
            self.fail("insecure fallback must not be reached")
        with patch.object(MODULE.getpass, "getpass", side_effect=unavailable):
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.hidden_secret("hidden")


if __name__ == "__main__":
    unittest.main()
