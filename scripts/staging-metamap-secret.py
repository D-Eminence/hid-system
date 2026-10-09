#!/usr/bin/env python3
"""Store MetaMap credentials in one fixed staging secret; never print values.

Default mode is local preparation only. --store is an explicit secret write,
requires the existing AWS browser login, and prompts on a real terminal.
"""
import argparse
import configparser
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import warnings

ACCOUNT = "659225405023"
REGION = "eu-west-1"
PROFILE = "hid-admin"
SECRET_NAME = "/hid/staging/nin-metamap"
CLIENT_FILE = Path(__file__).resolve().parents[1] / "release/local/staging-metamap-client.json"
ARN_PATTERN = re.compile(r"arn:aws:secretsmanager:eu-west-1:659225405023:secret:/hid/staging/nin-metamap-[A-Za-z0-9]{6}")


class SafeFailure(Exception):
    pass


def assert_cli_history_disabled():
    # AWS CLI history can persist full API payloads, including SecretString.
    # Refuse it before both credential reads and writes; do not change user config.
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


def aws(arguments, payload=None, allow_missing=False):
    # Credentials are never put in argv, environment variables or a temp file.
    # AWS CLI file:// reads the anonymous stdin pipe for SecretString.
    assert_cli_history_disabled()
    service = arguments[0]
    if service not in ("sts", "secretsmanager"):
        raise SafeFailure("Unsupported AWS service")
    command = ["aws", "--profile", PROFILE, "--region", REGION,
               "--endpoint-url", f"https://{service}.{REGION}.amazonaws.com",
               "--no-cli-pager", "--output", "json", *arguments]
    environment = {**os.environ, "AWS_PAGER": "", "AWS_CLI_AUTO_PROMPT": "off"}
    try:
        result = subprocess.run(command, input=payload, text=True, capture_output=True,
                                timeout=45, check=False, env=environment)
    except (OSError, subprocess.TimeoutExpired):
        raise SafeFailure("AWS operation unavailable; no credential or upstream error is displayed") from None
    if result.returncode:
        if allow_missing and "(ResourceNotFoundException)" in result.stderr:
            return None
        raise SafeFailure("AWS operation failed; check the existing local browser login and scoped staging permissions")
    try:
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise SafeFailure("AWS returned an invalid response") from None


def client_id(path=CLIENT_FILE):
    try:
        # Reject symlinks and group/world-readable material; never overwrite it.
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor) as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 4096:
                raise ValueError()
            value = json.load(source)
        identifier = value["clientId"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise ValueError()
        return identifier
    except (OSError, ValueError, KeyError, TypeError):
        raise SafeFailure("A private local MetaMap client configuration is required") from None


def assert_arn(value):
    if not isinstance(value, str) or not ARN_PATTERN.fullmatch(value):
        raise SafeFailure("Unexpected secret identity; the operation cannot be confirmed")


def hidden_secret(message):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass(message)
    except getpass.GetPassWarning:
        raise SafeFailure("Secure hidden terminal entry is unavailable; no secret was read") from None


def store(identifier, prompt=hidden_secret):
    identity = aws(["sts", "get-caller-identity"])
    if identity.get("Account") != ACCOUNT:
        raise SafeFailure("AWS account mismatch; no secret was accessed")
    existing = aws(["secretsmanager", "describe-secret", "--secret-id", SECRET_NAME], allow_missing=True)
    fields = {}
    if existing is not None:
        assert_arn(existing.get("ARN"))
        if existing.get("DeletedDate"):
            raise SafeFailure("The staging secret is scheduled for deletion")
        if existing.get("VersionIdsToStages"):
            current = aws(["secretsmanager", "get-secret-value", "--secret-id", existing["ARN"]])
            assert_arn(current.get("ARN"))
            try:
                fields = json.loads(current["SecretString"])
                if not isinstance(fields, dict):
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise SafeFailure("Existing staging secret is not a JSON object; preserved without changes") from None
        if fields.get("clientId") not in (None, identifier):
            raise SafeFailure("Existing staging secret belongs to another MetaMap client; preserved without changes")
    secret = prompt("MetaMap staging Client Secret (hidden; stored only in AWS Secrets Manager): ")
    if not isinstance(secret, str) or not secret or len(secret) > 4096 or re.search(r"[\x00-\x1f\x7f]", secret):
        raise SafeFailure("Client Secret must be nonempty and contain no control characters")
    fields.update(clientId=identifier, clientSecret=secret)
    if existing is None:
        arguments = ["secretsmanager", "create-secret", "--name", SECRET_NAME,
                     "--description", "HID staging MetaMap NIN credentials; runtime disabled pending contract acceptance",
                     "--tags", "Key=Environment,Value=staging"]
    else:
        arguments = ["secretsmanager", "put-secret-value", "--secret-id", existing["ARN"]]
    receipt = aws([*arguments, "--secret-string", "file:///dev/stdin"], payload=json.dumps(fields))
    assert_arn(receipt.get("ARN"))
    return {"status": "STORED", "secret_arn": receipt["ARN"], "client_id_present": True,
            "client_secret_present": True, "provider_access_verified": False,
            "deployment_authorized": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", action="store_true", help="Write only the designated staging secret after a hidden local prompt")
    args = parser.parse_args()
    try:
        identifier = client_id()
        if args.store:
            if not sys.stdin.isatty() or not sys.stderr.isatty():
                raise SafeFailure("Secret entry requires an interactive terminal; piped input is refused")
            receipt = store(identifier)
        else:
            receipt = {"status": "LOCAL_PREPARATION_ONLY", "client_id_present": True,
                       "secret_name": SECRET_NAME, "cloud_checked": False,
                       "deployment_authorized": False}
        print(json.dumps(receipt, indent=2))
        return 0
    except (SafeFailure, EOFError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, SafeFailure) else "Secret entry cancelled"
        print(json.dumps({"status": "BLOCKED", "reason": message, "deployment_authorized": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
