#!/usr/bin/env python3
"""Read-only absence check for the HID staging ECR bootstrap path.

This script never deploys, creates, imports, deletes, changes, or adopts a
resource. It checks only the fixed staging account, regional stack name, CDK
bootstrap version, and application repository names. A successful read does not
authorize deployment.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

ACCOUNT = "659225405023"
REGION = "eu-west-1"
STACK_NAME = "Hid-staging-Regional"
CDK_BOOTSTRAP_VERSION_PARAMETER = "/cdk-bootstrap/hnb659fds/version"
MINIMUM_CDK_BOOTSTRAP_VERSION = 6
APPLICATION_REPOSITORIES = (
    "staging/hid/identity-api",
    "staging/hid/ehr-api",
    "staging/hid/lab-api",
    "staging/hid/pharmacy-api",
    "staging/hid/ocr-api",
    "staging/hid/ocr-worker",
    "staging/hid/outreach-api",
    "staging/hid/notification-api",
    "staging/hid/notification-worker",
    "staging/hid/event-dispatcher",
    "staging/hid/gateway",
)
REPOSITORY_SET_SHA256 = hashlib.sha256("\n".join(APPLICATION_REPOSITORIES).encode("utf-8")).hexdigest()


class BootstrapReadError(ValueError):
    def __init__(self, category):
        self.category = category
        super().__init__(category)


def aws_command(arguments):
    try:
        return subprocess.run(
            ["aws", *arguments, "--profile", "hid-admin", "--region", REGION,
             "--output", "json", "--no-cli-pager"],
            capture_output=True,
            text=True,
            timeout=35,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise BootstrapReadError("unavailable_or_invalid_response") from None


def failure_category(result):
    message = (result.stderr + result.stdout).lower()
    if "expired" in message:
        return "expired_browser_session"
    return "denied_or_unavailable"


def json_success(result):
    if result.returncode:
        raise BootstrapReadError(failure_category(result))
    try:
        value = json.loads(result.stdout)
    except (TypeError, ValueError):
        raise BootstrapReadError("unavailable_or_invalid_response") from None
    if not isinstance(value, dict):
        raise BootstrapReadError("unavailable_or_invalid_response")
    return value


def confirmed_absent(result, missing_markers, present_category):
    if result.returncode == 0:
        raise BootstrapReadError(present_category)
    message = (result.stderr + result.stdout).lower()
    if "expired" in message:
        raise BootstrapReadError("expired_browser_session")
    if not all(marker.lower() in message for marker in missing_markers):
        raise BootstrapReadError("denied_or_unavailable")
    return True


def check(call=aws_command):
    identity = json_success(call(["sts", "get-caller-identity"]))
    if identity.get("Account") != ACCOUNT:
        raise BootstrapReadError("wrong_account")

    bootstrap = json_success(call([
        "ssm", "get-parameter", "--name", CDK_BOOTSTRAP_VERSION_PARAMETER,
    ]))
    parameter = bootstrap.get("Parameter")
    if not isinstance(parameter, dict) or parameter.get("Name") != CDK_BOOTSTRAP_VERSION_PARAMETER:
        raise BootstrapReadError("cdk_bootstrap_binding_rejected")
    version = parameter.get("Value")
    if not isinstance(version, str) or not version.isdecimal() or int(version) < MINIMUM_CDK_BOOTSTRAP_VERSION:
        raise BootstrapReadError("cdk_bootstrap_version_rejected")

    confirmed_absent(
        call(["cloudformation", "describe-stacks", "--stack-name", STACK_NAME]),
        ("ValidationError", f"Stack with id {STACK_NAME} does not exist"),
        "regional_stack_present",
    )
    for repository in APPLICATION_REPOSITORIES:
        confirmed_absent(
            call(["ecr", "describe-repositories", "--repository-names", repository]),
            ("RepositoryNotFoundException",),
            "application_repository_present",
        )

    return {
        "schema_version": "hid.staging-ecr-bootstrap-absence/v1",
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "environment": "staging",
        "account_id": ACCOUNT,
        "region": REGION,
        "stack_name": STACK_NAME,
        "cdk_bootstrap_parameter": CDK_BOOTSTRAP_VERSION_PARAMETER,
        "cdk_bootstrap_version": int(version),
        "regional_stack_absent": True,
        "application_repository_count": len(APPLICATION_REPOSITORIES),
        "application_repository_set_sha256": REPOSITORY_SET_SHA256,
        "application_repositories_absent": True,
        "bootstrap_absence_confirmed": True,
        "deployment_authorized": False,
        "staging_accepted": False,
        "cloud_mutations": False,
        "next_gate": "quota_capacity_release_provider_and_custody_gates_remain",
    }


def write_new_private_receipt(path, serialized):
    parent = path.parent
    if not parent.is_dir() or parent.is_symlink():
        raise BootstrapReadError("binding_or_output_rejected")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError:
        raise BootstrapReadError("binding_or_output_rejected") from None
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        raise BootstrapReadError("binding_or_output_rejected") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Optional new metadata-only receipt; refuses overwrite")
    args = parser.parse_args()
    try:
        report = check()
        serialized = json.dumps(report, indent=2) + "\n"
        if args.output:
            write_new_private_receipt(args.output, serialized)
        print(serialized, end="")
    except BootstrapReadError as error:
        print(json.dumps({
            "status": "READ_OR_BOOTSTRAP_BINDING_FAILED",
            "bootstrap_absence_confirmed": False,
            "deployment_authorized": False,
            "cloud_mutations": False,
            "aws_status": error.category,
        }))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
