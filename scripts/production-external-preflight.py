#!/usr/bin/env python3
"""Read-only, value-free launch checks for the HID production account (I1, NOTIF-PROD, D4, REC-GOOGLE).

The production account and region are the approved out-of-band HID_AWS_ACCOUNT
and HID_AWS_REGION (release/config/environments.json); the staging account is
refused. Checks: every field the production template reads from the auth,
Identity sensitive and notification provider secrets is present, the five
Identity keys are canonical 32-byte base64, the notification secret holds
exactly the otp-email-sms fields, the Google allowlist is present and empty,
SES has production access and a DKIM-verified domain, and the operational
alarm topic exists, is encrypted with an enabled customer-managed KMS key in
its own account and region whose key policy lets cloudwatch.amazonaws.com use
it (CloudWatch cannot publish through the AWS-managed SNS key; the key is
resolved with kms describe-key, so an alias ARN or key id of that key fails
too) and has a confirmed subscription.

No value, length, encoding, sender, recipient or API error text is printed or
stored. No login, provisioning, delivery, signing, deployment or secret
mutation occurs. Run without --cloud-read-only for the local plan only.
"""
import argparse
import base64
import binascii
import datetime
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ENVIRONMENT = "production"
# release/config/environments.json aws_identity patterns.
ACCOUNT_PATTERN = re.compile(r"^[0-9]{12}$")
REGION_PATTERN = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$")
STAGING_ACCOUNT = "659225405023"
DOMAIN = "healthidentitydirectory.com"
AUTH_SECRET = "/hid/production/auth"
IDENTITY_SECRET = "/hid/production/identity-sensitive"
NOTIFICATION_SECRET = "/hid/production/notification-provider"
# Exactly the fields the production template reads from each secret
# (infra/aws/test/infrastructure.test.ts compares these lists with it).
AUTH_FIELDS = ["authSigningSecret", "authLoginPepper"]
IDENTITY_SENSITIVE_FIELDS = ["ninLookupHmacKeyB64", "ninEncryptionKeyB64", "otpHmacKeyB64", "contactLookupHmacKeyB64", "turnstileSecretKey", "googleOidcClientIds", "mfaSecretKeyB64"]
NOTIFICATION_PROVIDER_FIELDS = ["sesFromAddress", "termiiBaseUrl", "termiiApiKey", "termiiSenderId"]
# Identity refuses to start unless each is exactly 32 bytes in canonical padded base64.
KEY_FIELDS = ["mfaSecretKeyB64", "otpHmacKeyB64", "contactLookupHmacKeyB64", "ninLookupHmacKeyB64", "ninEncryptionKeyB64"]
GOOGLE_FIELD = "googleOidcClientIds"
ALARM_TOPIC_NAME = "hid-production-operational-alerts"
# The KMS identifiers SNS reports as KmsMasterKeyId: a key id (multi-Region
# keys start with mrk-), a key ARN, an alias name or an alias ARN.
KMS_KEY_ID = re.compile(r"^(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
KMS_KEY_IDENTIFIER = re.compile(
    r"^(?:(?:mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"|arn:aws(?:-cn|-us-gov)?:kms:[a-z]{2}(?:-gov)?-[a-z]+-[0-9]:[0-9]{12}:(?:key/[A-Za-z0-9-]{1,128}|alias/[A-Za-z0-9/_-]{1,250})"
    r"|alias/[A-Za-z0-9/_-]{1,250})$")
CLOUDWATCH_SERVICE = "cloudwatch.amazonaws.com"
# What CloudWatch needs to publish to an encrypted topic, matched against the
# policy's actions case-insensitively, wildcards included (kms:*, kms:GenerateDataKey*).
CLOUDWATCH_KEY_ACTIONS = ["kms:decrypt", "kms:generatedatakey"]
SECRET_FIELDS = {AUTH_SECRET: AUTH_FIELDS, IDENTITY_SECRET: IDENTITY_SENSITIVE_FIELDS,
                 NOTIFICATION_SECRET: NOTIFICATION_PROVIDER_FIELDS}


def validate_target(account, region):
    """The approved production account and region, or ValueError. Never the staging account."""
    if not isinstance(account, str) or not ACCOUNT_PATTERN.fullmatch(account):
        raise ValueError("HID_AWS_ACCOUNT must be the approved 12-digit production account")
    if not isinstance(region, str) or not REGION_PATTERN.fullmatch(region):
        raise ValueError("HID_AWS_REGION must be the approved production region")
    if account == STAGING_ACCOUNT:
        raise ValueError("the staging account is not a production target")
    return account, region


def aws_json(arguments, region, profile=None, run=subprocess.run):
    # Callers below supply only fixed read-only commands, never caller-provided argv.
    command = ["aws", *arguments, "--region", region, "--output", "json", "--no-cli-pager"]
    if profile:
        command += ["--profile", profile]
    try:
        result = run(command, capture_output=True, text=True, timeout=25)
        if result.returncode:
            message = (result.stderr + result.stdout).lower()
            return None, "expired_session" if "expired" in message else "denied_or_unavailable"
        return json.loads(result.stdout), None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, "unavailable_or_invalid_response"


def canonical_32_byte_base64(value):
    """Identity's start-up check (identity-api src/config/environment.ts, isBase64Key after its trim).

    Only ASCII whitespace is trimmed: a value that Identity accepts only after trimming
    other whitespace reports False, the fail-closed direction.
    """
    if not isinstance(value, str):
        return False
    text = value.strip(" \t\n\r\f\v")
    try:
        decoded = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(decoded) == 32 and base64.b64encode(decoded).decode("ascii") == text


def present(value):
    return isinstance(value, str) and bool(value.strip())


def secret_summary(name, response, account, region):
    expected = re.compile(r"^arn:aws(?:-cn|-us-gov)?:secretsmanager:" + re.escape(region) + ":" + re.escape(account)
                          + ":secret:" + re.escape(name) + r"-[A-Za-z0-9]{6}$")
    if not isinstance(response, dict) or not expected.fullmatch(str(response.get("ARN", ""))):
        return {"status": "unexpected_secret_identity"}
    try:
        value = json.loads(response.get("SecretString", ""))
    except (ValueError, TypeError):
        return {"status": "missing_or_invalid_json"}
    if not isinstance(value, dict):
        return {"status": "missing_or_invalid_json"}
    fields = SECRET_FIELDS[name]
    summary = {"status": "read", "required_fields_present": {
        # REC-GOOGLE: the Google allowlist must exist; an empty value turns Google sign-in off.
        field: isinstance(value.get(field), str) if field == GOOGLE_FIELD else present(value.get(field))
        for field in fields}}
    if name == IDENTITY_SECRET:
        # Value-free: one boolean per key, never the value, its length or its encoding.
        summary["canonical_32_byte_base64"] = {field: canonical_32_byte_base64(value.get(field)) for field in KEY_FIELDS}
        google = value.get(GOOGLE_FIELD)
        summary["google_sign_in_enabled"] = present(google) if isinstance(google, str) else None
    if name == NOTIFICATION_SECRET:
        unexpected = set(value) - set(fields)
        summary["exact_field_set"] = not unexpected and all(field in value for field in fields)
        summary["unexpected_field_count"] = len(unexpected)
        sender = value.get("sesFromAddress")
        summary["ses_sender_uses_verified_domain"] = (present(sender) and sender.strip().count("@") == 1
                                                      and sender.strip().rsplit("@", 1)[1].lower() == DOMAIN)
    return summary


def ses_checks(call):
    account, error = call(["sesv2", "get-account"])
    if error or not isinstance(account, dict):
        return {"status": error or "invalid_response"}
    report = {"status": "read", "production_access_enabled": account.get("ProductionAccessEnabled") is True,
              "sending_enabled": account.get("SendingEnabled") is True}
    identity, error = call(["sesv2", "get-email-identity", "--email-identity", DOMAIN])
    valid = not error and isinstance(identity, dict)
    report["domain_verified_for_sending"] = valid and identity.get("VerifiedForSendingStatus") is True
    report["dkim_status_success"] = (valid and isinstance(identity.get("DkimAttributes"), dict)
                                     and identity["DkimAttributes"].get("Status") == "SUCCESS")
    return report


def count(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def kms_key_identifier(value):
    """A KMS key id, key ARN, alias name or alias ARN as SNS reports it, else None.

    Only a recognised identifier is passed to the AWS CLI, so a topic attribute can
    never add an option or another argument to the fixed read-only command.
    """
    if not isinstance(value, str):
        return None
    return value if KMS_KEY_IDENTIFIER.fullmatch(value) else None


def statement_list(policy):
    statements = policy.get("Statement") if isinstance(policy, dict) else None
    if isinstance(statements, dict):
        return [statements]
    return [item for item in statements if isinstance(item, dict)] if isinstance(statements, list) else []


def as_list(value):
    return value if isinstance(value, list) else [value]


def grants_cloudwatch(policy):
    """Whether the key policy allows cloudwatch.amazonaws.com kms:Decrypt and kms:GenerateDataKey.

    Only explicit Allow statements that name the service principal count; a wildcard
    principal, NotAction or NotPrincipal statement never does. Conditions are not
    evaluated, so a statement scoped by condition still counts (the check is a
    presence check, not a policy simulation).
    """
    granted = []
    for statement in statement_list(policy):
        if statement.get("Effect") != "Allow" or "NotAction" in statement or "NotPrincipal" in statement:
            continue
        principal = statement.get("Principal")
        services = as_list(principal.get("Service")) if isinstance(principal, dict) else []
        if CLOUDWATCH_SERVICE not in [item for item in services if isinstance(item, str)]:
            continue
        granted += [action.lower() for action in as_list(statement.get("Action")) if isinstance(action, str)]
    return all(any(fnmatch.fnmatchcase(action, pattern) for pattern in granted) for action in CLOUDWATCH_KEY_ACTIONS)


def topic_key_checks(call, key, partition, account, region):
    """Resolves the topic's key and reports booleans only, never the key identifier or policy."""
    result = {"customer_managed_key": False, "key_enabled": False, "key_in_topic_account_and_region": False,
              "key_policy_grants_cloudwatch": False}
    identifier = kms_key_identifier(key)
    # CloudWatch alarms cannot publish to a topic encrypted with the AWS-managed
    # SNS key, whose key policy cannot grant cloudwatch.amazonaws.com.
    if identifier is None or identifier.lower().endswith("alias/aws/sns"):
        return result
    described, error = call(["kms", "describe-key", "--key-id", identifier])
    metadata = described.get("KeyMetadata") if not error and isinstance(described, dict) else None
    if not isinstance(metadata, dict):
        return result
    key_id = metadata.get("KeyId")
    expected_arn = re.compile(r"^arn:" + re.escape(partition) + ":kms:" + re.escape(region) + ":" + re.escape(account)
                              + r":key/[A-Za-z0-9-]{1,128}$")
    result["customer_managed_key"] = metadata.get("KeyManager") == "CUSTOMER"
    result["key_enabled"] = metadata.get("KeyState") == "Enabled"
    result["key_in_topic_account_and_region"] = bool(expected_arn.fullmatch(str(metadata.get("Arn", ""))))
    if not result["customer_managed_key"] or not isinstance(key_id, str) or not KMS_KEY_ID.fullmatch(key_id):
        return result
    response, error = call(["kms", "get-key-policy", "--key-id", key_id, "--policy-name", "default"])
    try:
        policy = json.loads(response.get("Policy", "")) if not error and isinstance(response, dict) else None
    except (TypeError, ValueError):
        policy = None
    result["key_policy_grants_cloudwatch"] = grants_cloudwatch(policy)
    return result


def topic_checks(call, partition, account, region):
    topic_arn = f"arn:{partition}:sns:{region}:{account}:{ALARM_TOPIC_NAME}"
    response, error = call(["sns", "get-topic-attributes", "--topic-arn", topic_arn])
    if error or not isinstance(response, dict) or not isinstance(response.get("Attributes"), dict):
        return {"status": error or "invalid_response"}
    attributes = response["Attributes"]
    key = attributes.get("KmsMasterKeyId")
    return {"status": "read", "kms_encrypted": present(key), **topic_key_checks(call, key, partition, account, region),
            "subscriptions_confirmed": count(attributes.get("SubscriptionsConfirmed")),
            "subscriptions_pending": count(attributes.get("SubscriptionsPending"))}


def launch_profile(report):
    """The checks the production launch profile needs; each failure is named, never valued."""
    failures = []
    if not report.get("account_matches"):
        failures.append("account_matches")
        return {"passed": False, "failed_checks": failures}
    secrets = report.get("secrets", {})

    def fields_ok(name):
        summary = secrets.get(name, {})
        return summary.get("status") == "read" and all(summary.get("required_fields_present", {}).values())

    identity = secrets.get(IDENTITY_SECRET, {})
    notification = secrets.get(NOTIFICATION_SECRET, {})
    ses = report.get("ses", {})
    topic = report.get("alarm_topic", {})
    checks = {
        "auth_fields_present": fields_ok(AUTH_SECRET),
        "identity_sensitive_fields_present": fields_ok(IDENTITY_SECRET),
        "identity_keys_canonical": identity.get("status") == "read"
        and all(identity.get("canonical_32_byte_base64", {}).values()),
        # REC-GOOGLE: Google sign-in is outside the launch scope.
        "google_sign_in_disabled": identity.get("google_sign_in_enabled") is False,
        "notification_fields_present": fields_ok(NOTIFICATION_SECRET),
        "notification_exact_field_set": notification.get("exact_field_set") is True,
        "ses_sender_uses_verified_domain": notification.get("ses_sender_uses_verified_domain") is True,
        "ses_production_access": ses.get("production_access_enabled") is True,
        "ses_sending_enabled": ses.get("sending_enabled") is True,
        "ses_domain_dkim": ses.get("domain_verified_for_sending") is True and ses.get("dkim_status_success") is True,
        "alarm_topic_exists": topic.get("status") == "read",
        "alarm_topic_kms_encrypted": topic.get("kms_encrypted") is True,
        "alarm_topic_customer_managed_key": topic.get("customer_managed_key") is True,
        "alarm_topic_key_enabled": topic.get("key_enabled") is True,
        "alarm_topic_key_in_account_and_region": topic.get("key_in_topic_account_and_region") is True,
        "alarm_topic_key_policy_grants_cloudwatch": topic.get("key_policy_grants_cloudwatch") is True,
        "alarm_topic_confirmed_subscription": (topic.get("subscriptions_confirmed") or 0) >= 1,
    }
    failures.extend(name for name, passed in checks.items() if not passed)
    return {"passed": not failures, "failed_checks": sorted(failures)}


def aws_checks(account, region, call):
    identity, error = call(["sts", "get-caller-identity"])
    if error or not isinstance(identity, dict):
        report = {"status": error or "invalid_identity", "account_matches": False}
    elif identity.get("Account") != account:
        report = {"status": "wrong_account_refused", "account_matches": False}
    else:
        partition = str(identity.get("Arn", "")).split(":")[1:2]
        partition = partition[0] if partition and partition[0] in {"aws", "aws-cn", "aws-us-gov"} else "aws"
        report = {"status": "authenticated", "account_matches": True, "region": region, "secrets": {}}
        for name in SECRET_FIELDS:
            value, error = call(["secretsmanager", "get-secret-value", "--secret-id", name])
            report["secrets"][name] = {"status": error} if error else secret_summary(name, value, account, region)
        report["ses"] = ses_checks(call)
        report["alarm_topic"] = topic_checks(call, partition, account, region)
    report["launch_profile"] = launch_profile(report)
    return report


def base_report(account, region):
    return {"schema_version": "hid.production-external-preflight/v1", "environment": ENVIRONMENT,
            "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "target": {"account": account, "region": region},
            "deployment_authorized": False, "production_accepted": False,
            "checks": ["auth, Identity sensitive and notification secret field presence",
                       "five Identity keys in canonical 32-byte base64",
                       "notification secret holds exactly the otp-email-sms fields",
                       "googleOidcClientIds present and empty (Google sign-in off)",
                       "SES production access, sending, and a DKIM-verified domain",
                       f"{ALARM_TOPIC_NAME} exists, uses an enabled customer-managed KMS key in its account and "
                       "region whose policy lets cloudwatch.amazonaws.com use it, and has a confirmed subscription"],
            "scope": "read-only presence and format checks, not provider delivery or release acceptance"}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cloud-read-only", action="store_true",
                        help="Use existing credentials for the fixed read-only production checks")
    parser.add_argument("--account", default=os.environ.get("HID_AWS_ACCOUNT"),
                        help="Approved production account (default: HID_AWS_ACCOUNT)")
    parser.add_argument("--region", default=os.environ.get("HID_AWS_REGION"),
                        help="Approved production region (default: HID_AWS_REGION)")
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE"),
                        help="Existing read-only AWS CLI profile (default: AWS_PROFILE)")
    parser.add_argument("--output", type=Path, help="Write a new, value-free receipt; existing files are never overwritten")
    args = parser.parse_args()
    try:
        account, region = validate_target(args.account, args.region)
    except ValueError as error:
        print(f"production preflight refused: {error}", file=sys.stderr)
        return 2
    report = base_report(account, region)
    if args.cloud_read_only:
        report["aws"] = aws_checks(account, region, lambda arguments: aws_json(arguments, region, args.profile))
    serialized = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as stream:
            stream.write(serialized)
    print(serialized, end="")
    if args.cloud_read_only and not report["aws"]["launch_profile"]["passed"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
