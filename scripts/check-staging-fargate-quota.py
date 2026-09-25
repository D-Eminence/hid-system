#!/usr/bin/env python3
"""Read the existing HID staging quota request; never request, deploy or log credentials.

The result distinguishes the applied limit from request approval and free capacity.
An exit status of zero means the read succeeded, not that deployment is authorized.
"""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import subprocess

ACCOUNT = "659225405023"
REGION = "eu-west-1"
QUOTA_CODE = "L-3032A538"
REQUEST_ID = "53cf4fecbdee43808970dadf399dce15KHtG3UD0"
REQUESTED_VCPU = 32
QUOTA_ARN = f"arn:aws:servicequotas:{REGION}:{ACCOUNT}:fargate/{QUOTA_CODE}"
STATUSES = {"PENDING", "CASE_OPENED", "APPROVED", "DENIED", "CASE_CLOSED", "NOT_APPROVED", "INVALID_REQUEST"}


class QuotaReadError(ValueError):
    def __init__(self, category):
        self.category = category
        super().__init__(category)


def aws_read(arguments):
    try:
        result = subprocess.run(["aws", *arguments, "--profile", "hid-admin", "--region", REGION,
            "--output", "json", "--no-cli-pager"], capture_output=True, text=True, timeout=35)
        if result.returncode:
            category = "expired_browser_session" if "expired" in (result.stderr + result.stdout).lower() else "denied_or_unavailable"
            raise QuotaReadError(category)
        return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        raise QuotaReadError("unavailable_or_invalid_response") from None


def summarize(quota, request):
    for record in (quota, request):
        if not isinstance(record, dict) or record.get("QuotaArn") != QUOTA_ARN \
                or record.get("ServiceCode") != "fargate" or record.get("QuotaCode") != QUOTA_CODE \
                or record.get("GlobalQuota") is not False:
            raise ValueError("Quota account, region or service identity rejected")
    value = quota.get("Value")
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("Applied quota value rejected")
    if request.get("Id") != REQUEST_ID or request.get("DesiredValue") != REQUESTED_VCPU \
            or request.get("QuotaRequestedAtLevel", "ACCOUNT") != "ACCOUNT" \
            or request.get("Status") not in STATUSES:
        raise ValueError("Existing request binding or status rejected")
    status = request["Status"]
    pending = status in {"PENDING", "CASE_OPENED"}
    applied = value >= REQUESTED_VCPU
    if pending:
        decision = "PENDING_REQUEST_DEPLOYMENT_HOLD"
    elif status == "APPROVED" and not applied:
        decision = "APPROVED_AWAITING_APPLIED_QUOTA"
    elif status == "APPROVED" and applied:
        decision = "APPLIED_QUOTA_CONFIRMED_USAGE_AND_RELEASE_GATES_REMAIN"
    else:
        decision = "REQUEST_OUTCOME_REVIEW_REQUIRED"
    return {
        "schema_version": "hid.staging-fargate-quota/v1", "environment": "staging",
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "account_id": ACCOUNT, "region": REGION, "quota_code": QUOTA_CODE,
        "request_id": REQUEST_ID, "request_status": status, "requested_vcpu": REQUESTED_VCPU,
        "value": value, "requested_capacity_applied": applied, "request_pending": pending,
        "quota_gate_cleared": status == "APPROVED" and applied,
        "existing_account_usage": "unverified", "available_capacity_verified": False,
        "decision": decision, "deployment_authorized": False, "staging_accepted": False,
        "duplicate_request_prohibited": True, "cloud_mutations": False,
    }


def check(call=aws_read):
    identity = call(["sts", "get-caller-identity"])
    if not isinstance(identity, dict) or identity.get("Account") != ACCOUNT:
        raise ValueError("Wrong AWS account; further reads refused")
    quota = call(["service-quotas", "get-service-quota", "--service-code", "fargate", "--quota-code", QUOTA_CODE])
    request = call(["service-quotas", "get-requested-service-quota-change", "--request-id", REQUEST_ID])
    if not isinstance(quota, dict) or not isinstance(request, dict):
        raise ValueError("AWS quota response rejected")
    return summarize(quota.get("Quota"), request.get("RequestedQuota"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="Optional new metadata-only receipt; refuses overwrite")
    args = parser.parse_args()
    try:
        report = check()
        serialized = json.dumps(report, indent=2) + "\n"
        if args.output:
            # Parent must already exist; the caller chooses a private evidence directory.
            fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(serialized)
        print(serialized, end="")
    except (ValueError, OSError) as error:
        # Never reflect provider errors, external response strings, or local paths.
        print(json.dumps({"status": "READ_OR_BINDING_FAILED", "deployment_authorized": False,
            "available_capacity_verified": False, "duplicate_request_prohibited": True,
            "aws_status": error.category if isinstance(error, QuotaReadError) else "binding_or_output_rejected"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
