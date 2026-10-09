import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import warnings
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("provider_secret", Path(__file__).resolve().parents[1] / "staging-provider-secret.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
VERSION = "11111111-1111-1111-1111-111111111111"
NEXT_VERSION = "22222222-2222-2222-2222-222222222222"
SENTINEL = "synthetic-hidden-unit-test-value"


def binding(field="novuApiKey"):
    name = MODULE.FIELDS[field]
    return {"ARN": f"arn:aws:secretsmanager:{MODULE.REGION}:{MODULE.ACCOUNT}:secret:{name}-aBc123", "Name": name}


def existing_replies(field="novuApiKey", fields=None, empty=False):
    target = binding(field)
    identity = {"Account": MODULE.ACCOUNT}
    if empty:
        return [identity, {**target, "VersionIdsToStages": {}}, {**target, "Versions": []}]
    return [identity, {**target, "VersionIdsToStages": {VERSION: ["AWSCURRENT"]}},
            {**target, "VersionId": VERSION, "VersionStages": ["AWSCURRENT"],
             "SecretString": json.dumps(fields if fields is not None else {"existing": SENTINEL})}]


def write_reply(field="novuApiKey"):
    return {**binding(field), "VersionId": NEXT_VERSION, "VersionStages": ["AWSCURRENT"]}


def prompt_for(field, value=SENTINEL):
    return Mock(side_effect=[value, MODULE.confirmation(field)])


class ProviderSecretTests(unittest.TestCase):
    def test_default_inspection_is_read_only_and_does_not_prompt_or_disclose_fields(self):
        call = Mock(side_effect=existing_replies(fields={"novuApiKey": SENTINEL, "other": SENTINEL}))
        prompt = Mock(side_effect=AssertionError("must not prompt"))
        report = MODULE.prepare("novuApiKey", call=call, prompt=prompt)
        self.assertEqual(report["status"], "INSPECTED_READ_ONLY")
        self.assertTrue(report["selected_field_present"])
        self.assertFalse(report["cloud_mutations"])
        self.assertFalse(report["deployment_authorized"])
        self.assertNotIn(SENTINEL, json.dumps(report))
        self.assertNotIn("other", json.dumps(report))
        self.assertEqual(call.call_count, 3)
        prompt.assert_not_called()

    def test_wrong_account_stops_before_secret_access(self):
        call = Mock(return_value={"Account": "000000000000"})
        with self.assertRaisesRegex(MODULE.SafeFailure, "account mismatch"):
            MODULE.prepare("novuApiKey", apply=True, call=call)
        self.assertEqual(call.call_args.args, (["sts", "get-caller-identity"],))
        self.assertEqual(call.call_count, 1)

    def test_production_and_other_account_secret_responses_are_rejected(self):
        for old, new in [("/staging/", "/production/"), (MODULE.ACCOUNT, "000000000000"), (MODULE.REGION, "us-east-1")]:
            with self.subTest(new=new):
                replies = existing_replies()
                replies[1]["ARN"] = replies[1]["ARN"].replace(old, new)
                call = Mock(side_effect=replies)
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.prepare("novuApiKey", apply=True, call=call)
                self.assertEqual(call.call_count, 2)

    def test_existing_selected_fields_are_never_overwritten(self):
        for prior in [SENTINEL, "", None, {"nested": SENTINEL}]:
            with self.subTest(prior_type=type(prior).__name__):
                call = Mock(side_effect=existing_replies(fields={"novuApiKey": prior}))
                prompt = Mock(side_effect=AssertionError("must not prompt"))
                with self.assertRaisesRegex(MODULE.SafeFailure, "already exists"):
                    MODULE.prepare("novuApiKey", apply=True, call=call, prompt=prompt)
                self.assertEqual(call.call_count, 3)
                prompt.assert_not_called()

    def test_all_three_fields_merge_without_changing_unrelated_fields(self):
        for field in MODULE.FIELDS:
            with self.subTest(field=field):
                prior = {"nested": {"key": "retained", "count": 123}, "empty": None, "list": [True, False]}
                value = "approved-sender@example.invalid" if field == "sesFromAddress" else SENTINEL
                replies = existing_replies(field, prior)
                call = Mock(side_effect=replies + replies + [write_reply(field)])
                output = []
                report = MODULE.prepare(field, apply=True, call=call, prompt=prompt_for(field, value), emit=output.append)
                arguments, = call.call_args.args
                self.assertEqual(arguments[:4], ["secretsmanager", "put-secret-value", "--secret-id", binding(field)["ARN"]])
                self.assertEqual(arguments[-2:], ["--secret-string", "file:///dev/stdin"])
                self.assertNotIn(value, json.dumps(arguments))
                self.assertEqual(json.loads(call.call_args.kwargs["payload"]), {**prior, field: value})
                self.assertNotIn(value, json.dumps([report, output]))
                self.assertTrue(report["cloud_mutations"])
                self.assertEqual(report["status"], "STORED")
                self.assertFalse(report["provider_verified"])
                self.assertFalse(report["messages_sent"])
                self.assertEqual(call.call_count, 7)

    def test_confirmed_empty_notification_container_gets_first_value_without_creation(self):
        replies = existing_replies(empty=True)
        call = Mock(side_effect=replies + replies + [write_reply()])
        report = MODULE.prepare("novuApiKey", apply=True, call=call, prompt=prompt_for("novuApiKey"))
        self.assertEqual(report["status"], "STORED")
        self.assertTrue(report["current_version_present"])
        self.assertEqual(json.loads(call.call_args.kwargs["payload"]), {"novuApiKey": SENTINEL})
        all_arguments = [item.args[0] for item in call.call_args_list]
        self.assertFalse(any("create-secret" in arguments for arguments in all_arguments))
        self.assertTrue(any("--include-deprecated" in arguments for arguments in all_arguments))

    def test_missing_container_is_distinct_from_empty_container_and_never_created(self):
        call = Mock(side_effect=[{"Account": MODULE.ACCOUNT}, None])
        with self.assertRaisesRegex(MODULE.SafeFailure, "container is absent"):
            MODULE.prepare("novuApiKey", apply=True, call=call)
        self.assertEqual(call.call_count, 2)

    def test_no_current_version_and_uncertain_reads_never_become_empty_json(self):
        cases = [
            [{**binding(), "VersionIdsToStages": {VERSION: ["AWSPREVIOUS"]}}],
            [{**binding(), "VersionIdsToStages": {VERSION: ["AWSCURRENT"], NEXT_VERSION: ["AWSCURRENT"]}}],
            [{**binding()}, {**binding(), "Versions": [{"VersionId": VERSION}]}],
            [{**binding()}, {**binding(), "Versions": [], "NextToken": "not-complete"}],
            [{**binding()}, {**binding()}],
            [{**binding(), "VersionIdsToStages": None}],
        ]
        for replies in cases:
            with self.subTest(case=cases.index(replies)):
                call = Mock(side_effect=[{"Account": MODULE.ACCOUNT}] + replies)
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.prepare("novuApiKey", apply=True, call=call)
                self.assertEqual(call.call_count, 1 + len(replies))

    def test_empty_identity_container_is_not_initialized_by_provider_tool(self):
        call = Mock(side_effect=existing_replies("turnstileSecretKey", empty=True))
        with self.assertRaisesRegex(MODULE.SafeFailure, "Identity secret must already"):
            MODULE.prepare("turnstileSecretKey", apply=True, call=call)
        self.assertEqual(call.call_count, 3)

    def test_changed_secret_after_confirmation_stops_before_write(self):
        replies = existing_replies()
        changed = existing_replies(fields={"another": "writer"})
        call = Mock(side_effect=replies + changed)
        with self.assertRaisesRegex(MODULE.SafeFailure, "changed during entry"):
            MODULE.prepare("novuApiKey", apply=True, call=call, prompt=prompt_for("novuApiKey"))
        self.assertEqual(call.call_count, 6)

    def test_confirmation_mismatch_stops_before_write(self):
        call = Mock(side_effect=existing_replies())
        with self.assertRaisesRegex(MODULE.SafeFailure, "confirmation did not match"):
            MODULE.prepare("novuApiKey", apply=True, call=call, prompt=Mock(side_effect=[SENTINEL, "yes"]))
        self.assertEqual(call.call_count, 3)

    def test_malformed_duplicate_or_nonfinite_json_is_preserved_without_disclosure(self):
        for value in ["[]", '{"key":1,"key":2}', '{"nested":{"key":1,"key":2}}', '{"value":NaN}', '{"value":1e400}', SENTINEL]:
            with self.subTest(value_type=type(value).__name__):
                replies = existing_replies()
                replies[-1]["SecretString"] = value
                call = Mock(side_effect=replies)
                with self.assertRaises(MODULE.SafeFailure) as caught:
                    MODULE.prepare("novuApiKey", apply=True, call=call)
                self.assertNotIn(SENTINEL, str(caught.exception))
                self.assertEqual(call.call_count, 3)

    def test_invalid_hidden_values_are_rejected_without_echo(self):
        cases = [("novuApiKey", ""), ("novuApiKey", "unsafe\nvalue"), ("novuApiKey", "bad value"),
                 ("novuApiKey", "bad\u2003value"),
                 ("novuApiKey", "x" * 4097), ("sesFromAddress", "Display <user@example.invalid>"),
                 ("sesFromAddress", "user@example.invalid,second@example.invalid")]
        for field, value in cases:
            with self.subTest(field=field):
                call = Mock(side_effect=existing_replies(field))
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.prepare(field, apply=True, call=call, prompt=prompt_for(field, value))
                self.assertEqual(call.call_count, 3)

    def test_transport_keeps_payload_in_stdin_and_pins_profile_region_and_endpoint(self):
        result = subprocess.CompletedProcess([], 0, stdout='{"metadata":true}', stderr="")
        with patch.object(MODULE, "assert_cli_history_disabled"), patch.object(MODULE.subprocess, "run", return_value=result) as run:
            MODULE.aws(["secretsmanager", "put-secret-value"], payload=SENTINEL)
        command, = run.call_args.args
        self.assertNotIn(SENTINEL, json.dumps(command))
        self.assertNotIn(SENTINEL, json.dumps(run.call_args.kwargs["env"]))
        self.assertEqual(run.call_args.kwargs["input"], SENTINEL)
        self.assertEqual(command[command.index("--profile") + 1], "hid-admin")
        self.assertEqual(command[command.index("--region") + 1], "eu-west-1")
        self.assertIn("https://secretsmanager.eu-west-1.amazonaws.com", command)
        self.assertNotIn("--debug", command)

    def test_upstream_errors_and_malformed_outputs_are_redacted(self):
        for result in [subprocess.CompletedProcess([], 1, stdout=SENTINEL, stderr=SENTINEL),
                       subprocess.CompletedProcess([], 0, stdout=SENTINEL, stderr="")]:
            with patch.object(MODULE, "assert_cli_history_disabled"), patch.object(MODULE.subprocess, "run", return_value=result):
                with self.assertRaises(MODULE.SafeFailure) as caught:
                    MODULE.aws(["secretsmanager", "get-secret-value"])
                self.assertNotIn(SENTINEL, str(caught.exception))

    def test_cli_history_enabled_blocks_before_subprocess(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config"
            path.write_text("[profile hid-admin]\ncli_history = enabled\n")
            with patch.dict(os.environ, {"AWS_CONFIG_FILE": str(path), "AWS_SHARED_CREDENTIALS_FILE": str(Path(directory) / "absent")}), \
                    patch.object(MODULE.subprocess, "run") as run:
                with self.assertRaises(MODULE.SafeFailure):
                    MODULE.aws(["sts", "get-caller-identity"])
                run.assert_not_called()

    def test_hidden_entry_cannot_fall_back_to_echoed_input(self):
        def unavailable(_):
            warnings.warn("Cannot control echo", MODULE.getpass.GetPassWarning)
            self.fail("insecure fallback must not be reached")
        with patch.object(MODULE.getpass, "getpass", side_effect=unavailable):
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.hidden_entry("hidden")

    def test_cli_rejects_secret_arguments_without_echo_and_piped_apply_before_aws(self):
        for args in [["--field", "novuApiKey", "--value", SENTINEL], ["--field", SENTINEL],
                     ["--field", "novuApiKey", "--apply"]]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(MODULE, "prepare") as prepare:
                self.assertEqual(MODULE.main(args), 1)
                prepare.assert_not_called()
            self.assertNotIn(SENTINEL, stdout.getvalue() + stderr.getvalue())

    def test_field_allowlist_rejects_prod_nin_and_unknown_fields_before_aws(self):
        for field in ["clientSecret", "production", "/hid/production/notification-provider", "awsAccessKeyId"]:
            call = Mock()
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.prepare(field, apply=True, call=call)
            call.assert_not_called()

    def test_rotating_or_scheduled_for_deletion_secrets_are_preserved(self):
        for change in [{"RotationEnabled": True}, {"DeletedDate": "2026-01-01T00:00:00Z"}]:
            replies = existing_replies()
            replies[1].update(change)
            call = Mock(side_effect=replies)
            with self.assertRaises(MODULE.SafeFailure):
                MODULE.prepare("novuApiKey", apply=True, call=call)
            self.assertEqual(call.call_count, 2)

    def test_mismatched_current_value_version_is_rejected_before_prompt(self):
        replies = existing_replies()
        replies[-1]["VersionId"] = NEXT_VERSION
        call = Mock(side_effect=replies)
        with self.assertRaises(MODULE.SafeFailure):
            MODULE.prepare("novuApiKey", apply=True, call=call)
        self.assertEqual(call.call_count, 3)


if __name__ == "__main__":
    unittest.main()
