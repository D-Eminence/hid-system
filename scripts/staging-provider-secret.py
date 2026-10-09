#!/usr/bin/env python3
"""Inspect or enter one provider field in an existing, fixed HID staging secret.

Default mode is read-only. --apply requires a real terminal, hidden entry, and
confirmation of the exact staging destination. It never creates containers,
replaces an existing field, verifies a provider, sends messages, or deploys.
Serialize operator updates: Secrets Manager PutSecretValue has no conditional
version parameter. A second read detects changes before writing, not an atomic
compare-and-swap. Do not run other secret writers during this operation.
"""
import argparse
import configparser
import getpass
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import warnings

ACCOUNT = "659225405023"
REGION = "eu-west-1"
PROFILE = "hid-admin"
FIELDS = {
    "turnstileSecretKey": "/hid/staging/identity-sensitive",
    "sesFromAddress": "/hid/staging/notification-provider",
    "novuApiKey": "/hid/staging/notification-provider",
}
VERSION = re.compile(r"[A-Za-z0-9-]{32,64}")


class SafeFailure(Exception):
    pass


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        # argparse normally echoes invalid arguments, which might contain a key.
        raise SafeFailure("Invalid arguments; use --help. Values belong only in hidden terminal prompts")


def assert_cli_history_disabled():
    for filename in (os.environ.get("AWS_CONFIG_FILE", str(Path.home() / ".aws/config")),
                     os.environ.get("AWS_SHARED_CREDENTIALS_FILE", str(Path.home() / ".aws/credentials"))):
        config = configparser.ConfigParser(interpolation=None)
        try:
            try:
                with open(filename) as source:
                    config.read_file(source)
            except FileNotFoundError:
                continue
            for section in config.sections():
                if config.get(section, "cli_history", fallback="disabled").strip() != "disabled":
                    raise SafeFailure("Disable AWS CLI cli_history before accessing provider credentials")
        except (OSError, configparser.Error):
            raise SafeFailure("AWS CLI history configuration could not be checked safely") from None


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def invalid_constant(_value):
    raise ValueError("non-finite JSON value")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("non-finite JSON value")
    return number


def parse_json(value):
    try:
        result = json.loads(value, object_pairs_hook=unique_object, parse_constant=invalid_constant, parse_float=finite_float)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, TypeError, RecursionError):
        raise SafeFailure("Existing secret or AWS response is not an unambiguous JSON object; no values displayed") from None


def aws(arguments, payload=None, allow_missing=False):
    assert_cli_history_disabled()
    if not arguments or arguments[0] not in ("sts", "secretsmanager"):
        raise SafeFailure("Unsupported AWS service")
    service = arguments[0]
    command = ["aws", "--profile", PROFILE, "--region", REGION,
               "--endpoint-url", f"https://{service}.{REGION}.amazonaws.com",
               "--no-cli-pager", "--no-cli-auto-prompt", "--output", "json", *arguments]
    environment = {**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"}
    try:
        result = subprocess.run(command, input=payload, text=True, capture_output=True,
                                timeout=45, check=False, env=environment)
    except (OSError, subprocess.TimeoutExpired):
        raise SafeFailure("AWS operation unavailable; no credential or upstream error is displayed") from None
    if result.returncode:
        if allow_missing and "(ResourceNotFoundException)" in result.stderr:
            return None
        raise SafeFailure("AWS operation failed; check local browser login and scoped staging permissions")
    return parse_json(result.stdout)


def assert_identity(call):
    identity = call(["sts", "get-caller-identity"])
    if not isinstance(identity, dict) or identity.get("Account") != ACCOUNT:
        raise SafeFailure("AWS account mismatch; no secret was accessed")


def assert_binding(value, name):
    pattern = rf"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{re.escape(name)}-[A-Za-z0-9]{{6}}"
    if not isinstance(value, dict) or not isinstance(value.get("ARN"), str) or not re.fullmatch(pattern, value["ARN"]):
        raise SafeFailure("Unexpected staging secret identity; operation refused")
    if value.get("Name") != name:
        raise SafeFailure("Unexpected staging secret name; operation refused")


def read_existing(field, call):
    if field not in FIELDS:
        raise SafeFailure("Unsupported provider field; only the fixed staging destinations are allowed")
    name = FIELDS[field]
    existing = call(["secretsmanager", "describe-secret", "--secret-id", name], allow_missing=True)
    if existing is None:
        raise SafeFailure("Required staging secret container is absent; this tool never creates containers")
    assert_binding(existing, name)
    if existing.get("DeletedDate") or existing.get("RotationEnabled"):
        raise SafeFailure("Secret is scheduled for deletion or automated rotation; no changes allowed")
    stages = existing.get("VersionIdsToStages", {})
    if not isinstance(stages, dict):
        raise SafeFailure("Secret version state is ambiguous; no changes allowed")
    current = []
    for version, labels in stages.items():
        if not VERSION.fullmatch(version) or not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
            raise SafeFailure("Secret version state is ambiguous; no changes allowed")
        if "AWSCURRENT" in labels:
            current.append(version)
    if not stages:
        # An omitted version map is not proof that a container has never held a
        # value. Include deprecated versions and reject incomplete responses.
        versions = call(["secretsmanager", "list-secret-version-ids", "--secret-id", existing["ARN"],
                         "--include-deprecated"])
        assert_binding(versions, name)
        if versions.get("Versions") != [] or versions.get("NextToken"):
            raise SafeFailure("No unambiguous current version; existing versions are preserved")
        if name != "/hid/staging/notification-provider":
            raise SafeFailure("Identity secret must already have a current version; required identity fields are preserved")
        return {"arn": existing["ARN"], "name": name, "version": None, "fields": {}}
    if len(current) != 1:
        raise SafeFailure("No unambiguous current version; existing versions are preserved")
    value = call(["secretsmanager", "get-secret-value", "--secret-id", existing["ARN"],
                  "--version-id", current[0], "--version-stage", "AWSCURRENT"])
    assert_binding(value, name)
    if value.get("VersionId") != current[0] or not isinstance(value.get("VersionStages"), list) or "AWSCURRENT" not in value["VersionStages"]:
        raise SafeFailure("Current secret version changed or could not be confirmed")
    raw = value.get("SecretString")
    if not isinstance(raw, str) or "SecretBinary" in value or len(raw.encode("utf-8", errors="surrogatepass")) > 65536:
        raise SafeFailure("Existing secret must be JSON SecretString; preserved without changes")
    return {"arn": existing["ARN"], "name": name, "version": current[0], "fields": parse_json(raw)}


def hidden_entry(message):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass(message)
    except getpass.GetPassWarning:
        raise SafeFailure("Secure hidden terminal entry is unavailable; no value was read") from None


def validate_value(field, value):
    if not isinstance(value, str) or not value or len(value) > 4096 or re.search(r"[\x00-\x20\x7f\s]", value):
        raise SafeFailure("Value must be nonempty, at most 4096 characters, and contain no whitespace or control characters")
    if field == "sesFromAddress" and (len(value) > 254 or ".." in value or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}", value)):
        raise SafeFailure("SES sender must be one plain email address; no display name or recipient list")


def confirmation(field):
    return f"STORE {ACCOUNT} {REGION} {FIELDS[field]} {field}"


def prepare(field, apply=False, call=aws, prompt=hidden_entry, emit=lambda _value: None):
    if field not in FIELDS:
        raise SafeFailure("Unsupported provider field; only the fixed staging destinations are allowed")
    assert_identity(call)
    existing = read_existing(field, call)
    report = {"schema_version": "hid.staging-provider-secret-entry/v1", "status": "INSPECTED_READ_ONLY",
              "environment": "staging", "account_id": ACCOUNT, "region": REGION, "profile": PROFILE,
              "secret_name": existing["name"], "field": field,
              "container_exists": True, "current_version_present": existing["version"] is not None,
              "selected_field_present": field in existing["fields"],
              "existing_fields_preserved": True, "values_included": False, "cloud_mutations": False,
              "concurrent_updates_supported": False, "operator_must_serialize_secret_updates": True,
              "provider_verified": False, "messages_sent": False, "deployment_authorized": False}
    if not apply:
        return report
    if field in existing["fields"]:
        raise SafeFailure("Selected field already exists; preserved unchanged. Use a separately reviewed rotation process")
    emit({**report, "status": "AWAITING_HIDDEN_ENTRY_AND_CONFIRMATION"})
    value = prompt(f"Enter staging {field} (hidden; do not run concurrent secret writers): ")
    validate_value(field, value)
    if prompt(f"Confirm destination by typing exactly '{confirmation(field)}' (hidden): ") != confirmation(field):
        raise SafeFailure("Destination confirmation did not match; no write attempted")
    # Re-bind the session and re-read after the operator prompts. There is no
    # PutSecretValue precondition, so the operator must serialize writers.
    assert_identity(call)
    if read_existing(field, call) != existing:
        raise SafeFailure("Secret changed during entry; no write attempted. Re-inspect before retrying")
    fields = {**existing["fields"], field: value}
    payload = json.dumps(fields, allow_nan=False, ensure_ascii=True, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 65536:
        raise SafeFailure("Merged secret exceeds the AWS size limit; no write attempted")
    # AWS CLI documents file:// loading for string parameters. On this Linux
    # operator host /dev/stdin reads the anonymous subprocess input pipe.
    # https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html
    # https://docs.aws.amazon.com/cli/latest/reference/secretsmanager/put-secret-value.html
    receipt = call(["secretsmanager", "put-secret-value", "--secret-id", existing["arn"],
                    "--secret-string", "file:///dev/stdin"], payload=payload)
    assert_binding(receipt, existing["name"])
    if not isinstance(receipt.get("VersionId"), str) or not VERSION.fullmatch(receipt["VersionId"]) or not isinstance(receipt.get("VersionStages"), list) or "AWSCURRENT" not in receipt["VersionStages"]:
        raise SafeFailure("Write response could not be confirmed; inspect staging metadata before retrying")
    return {**report, "status": "STORED", "cloud_mutations": True, "selected_field_present": True,
            "current_version_present": True}


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument("--field", required=True, choices=tuple(FIELDS))
    parser.add_argument("--apply", action="store_true", help="Add an absent field after hidden terminal confirmation")
    try:
        args = parser.parse_args(argv)
        if args.apply and (not sys.stdin.isatty() or not sys.stderr.isatty()):
            raise SafeFailure("Secret entry requires an interactive terminal; piped input is refused")
        report = prepare(args.field, apply=args.apply, emit=lambda value: print(json.dumps(value, indent=2)))
        print(json.dumps(report, indent=2))
        return 0
    except (SafeFailure, EOFError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, SafeFailure) else "Secret entry cancelled"
        print(json.dumps({"status": "BLOCKED", "reason": message, "deployment_authorized": False,
                          "write_outcome": "Not confirmed; inspect current staging metadata before any retry"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
