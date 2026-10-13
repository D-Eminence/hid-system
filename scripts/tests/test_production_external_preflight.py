import base64
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "production_preflight", Path(__file__).resolve().parents[1] / "production-external-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)

ACCOUNT = "000000000000"
REGION = "eu-west-1"
# Synthetic, non-secret key material: 32 bytes in canonical padded base64.
KEY = bytes(range(100, 132))
CANONICAL = base64.b64encode(KEY).decode("ascii")
PRIVATE = "never-serialize-this-value"


def arn(name):
    return f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:{name}-AbCdEf"


def identity(**overrides):
    value = {"ninLookupHmacKeyB64": CANONICAL, "ninEncryptionKeyB64": CANONICAL, "otpHmacKeyB64": CANONICAL,
             "contactLookupHmacKeyB64": CANONICAL, "turnstileSecretKey": PRIVATE, "googleOidcClientIds": "",
             "mfaSecretKeyB64": CANONICAL, **overrides}
    return {field: item for field, item in value.items() if item is not None}


def notification(**overrides):
    value = {"sesFromAddress": "security@healthidentitydirectory.com", "termiiBaseUrl": "https://termii.example.invalid",
             "termiiApiKey": PRIVATE, "termiiSenderId": "HID", **overrides}
    return {field: item for field, item in value.items() if item is not None}


CUSTOMER_KEY_ID = "1234abcd-12ab-34cd-56ef-1234567890ab"
CUSTOMER_KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/{CUSTOMER_KEY_ID}"
CUSTOMER_KEY_ALIAS = "alias/hid-production-alerts"
AWS_MANAGED_KEY_ID = "0987dcba-09fe-87dc-65ba-ab0987654321"
AWS_MANAGED_KEY_ARN = f"arn:aws:kms:{REGION}:{ACCOUNT}:key/{AWS_MANAGED_KEY_ID}"


def customer_key(**overrides):
    return {"KeyId": CUSTOMER_KEY_ID, "Arn": CUSTOMER_KEY_ARN, "KeyManager": "CUSTOMER", "KeyState": "Enabled",
            "KeyUsage": "ENCRYPT_DECRYPT", **overrides}


def aws_managed_keys():
    """Every spelling of the AWS-managed SNS key resolves to KeyManager AWS."""
    metadata = {"KeyId": AWS_MANAGED_KEY_ID, "Arn": AWS_MANAGED_KEY_ARN, "KeyManager": "AWS", "KeyState": "Enabled",
                "KeyUsage": "ENCRYPT_DECRYPT"}
    return {spelling: metadata for spelling in [
        "alias/aws/sns", f"arn:aws:kms:{REGION}:{ACCOUNT}:alias/aws/sns", AWS_MANAGED_KEY_ID, AWS_MANAGED_KEY_ARN]}


def cloudwatch_key_policy(service="cloudwatch.amazonaws.com", actions=("kms:Decrypt", "kms:GenerateDataKey*"),
                          effect="Allow"):
    return {"Version": "2012-10-17", "Statement": [
        {"Sid": "Root", "Effect": "Allow", "Principal": {"AWS": f"arn:aws:iam::{ACCOUNT}:root"},
         "Action": "kms:*", "Resource": "*"},
        {"Sid": "CloudWatchAlarms", "Effect": effect, "Principal": {"Service": service},
         "Action": list(actions), "Resource": "*"}]}


class Account:
    """A mocked, read-only production account: every AWS CLI call is answered here."""

    def __init__(self, identity_value=None, notification_value=None, account=ACCOUNT, ses=None, dkim="SUCCESS",
                 topic=None, keys=None, key_policy=None):
        self.calls = []
        self.account = account
        # describe-key answers by key identifier; get-key-policy by key id.
        self.keys = {CUSTOMER_KEY_ALIAS: customer_key(), CUSTOMER_KEY_ID: customer_key(),
                     CUSTOMER_KEY_ARN: customer_key(), **aws_managed_keys()} if keys is None else keys
        self.key_policy = cloudwatch_key_policy() if key_policy is None else key_policy
        self.secrets = {
            preflight.AUTH_SECRET: {"authSigningSecret": PRIVATE, "authLoginPepper": PRIVATE},
            preflight.IDENTITY_SECRET: identity() if identity_value is None else identity_value,
            preflight.NOTIFICATION_SECRET: notification() if notification_value is None else notification_value,
        }
        self.ses = {"ProductionAccessEnabled": True, "SendingEnabled": True} if ses is None else ses
        self.dkim = dkim
        self.topic = {"KmsMasterKeyId": CUSTOMER_KEY_ALIAS, "SubscriptionsConfirmed": "2",
                      "SubscriptionsPending": "0"} if topic is None else topic

    def __call__(self, arguments):
        self.calls.append(arguments)
        if arguments[:2] == ["sts", "get-caller-identity"]:
            return {"Account": self.account, "Arn": f"arn:aws:sts::{self.account}:assumed-role/ReadOnly/session"}, None
        if arguments[:2] == ["secretsmanager", "get-secret-value"]:
            name = arguments[arguments.index("--secret-id") + 1]
            if name not in self.secrets:
                return None, "denied_or_unavailable"
            return {"ARN": arn(name), "SecretString": json.dumps(self.secrets[name])}, None
        if arguments[:2] == ["sesv2", "get-account"]:
            return self.ses, None
        if arguments[:2] == ["sesv2", "get-email-identity"]:
            return {"VerifiedForSendingStatus": self.dkim == "SUCCESS", "DkimAttributes": {"Status": self.dkim}}, None
        if arguments[:2] == ["sns", "get-topic-attributes"]:
            if self.topic == "missing":
                return None, "denied_or_unavailable"
            return {"Attributes": {"TopicArn": arguments[-1], **self.topic}}, None
        if arguments[:2] == ["kms", "describe-key"]:
            key = arguments[arguments.index("--key-id") + 1]
            if key not in self.keys:
                return None, "denied_or_unavailable"
            return {"KeyMetadata": self.keys[key]}, None
        if arguments[:2] == ["kms", "get-key-policy"]:
            if arguments[arguments.index("--policy-name") + 1] != "default" or self.key_policy == "denied":
                return None, "denied_or_unavailable"
            key = arguments[arguments.index("--key-id") + 1]
            if key not in {metadata["KeyId"] for metadata in self.keys.values()}:
                return None, "denied_or_unavailable"
            return {"PolicyName": "default", "Policy": json.dumps(self.key_policy)}, None
        raise AssertionError(f"unexpected AWS call {arguments}")


class ProductionPreflightTests(unittest.TestCase):
    def run_checks(self, account):
        return preflight.aws_checks(ACCOUNT, REGION, account)

    def assert_value_free(self, report):
        text = json.dumps(report)
        for value in [PRIVATE, CANONICAL, KEY.hex(), "security@", "termii.example.invalid",
                      "synthetic-client.apps.googleusercontent.com", "metaAccessToken"]:
            self.assertNotIn(value, text)

    def test_the_launch_profile_passes_with_every_field_canonical_keys_and_google_off(self):
        account = Account()
        report = self.run_checks(account)
        self.assertEqual(report["launch_profile"], {"passed": True, "failed_checks": []})
        identity_report = report["secrets"][preflight.IDENTITY_SECRET]
        self.assertEqual(identity_report["required_fields_present"],
                         {field: True for field in preflight.IDENTITY_SENSITIVE_FIELDS})
        self.assertEqual(identity_report["canonical_32_byte_base64"], {field: True for field in preflight.KEY_FIELDS})
        self.assertIs(identity_report["google_sign_in_enabled"], False)
        self.assertEqual(set(preflight.KEY_FIELDS), {"mfaSecretKeyB64", "otpHmacKeyB64", "contactLookupHmacKeyB64",
                                                     "ninLookupHmacKeyB64", "ninEncryptionKeyB64"})
        self.assertIs(report["secrets"][preflight.NOTIFICATION_SECRET]["exact_field_set"], True)
        self.assertEqual(report["ses"], {"status": "read", "production_access_enabled": True, "sending_enabled": True,
                                         "domain_verified_for_sending": True, "dkim_status_success": True})
        self.assertEqual(report["alarm_topic"], {"status": "read", "kms_encrypted": True, "customer_managed_key": True,
                                                 "key_enabled": True, "key_in_topic_account_and_region": True,
                                                 "key_policy_grants_cloudwatch": True,
                                                 "subscriptions_confirmed": 2, "subscriptions_pending": 0})
        for value in [CUSTOMER_KEY_ALIAS, CUSTOMER_KEY_ID, CUSTOMER_KEY_ARN, "CloudWatchAlarms"]:
            self.assertNotIn(value, json.dumps(report))
        self.assert_value_free(report)
        # Read-only calls only; the alarm topic is the exact one in this account and region.
        self.assertTrue(all(call[0] in {"sts", "secretsmanager", "sesv2", "sns", "kms"} for call in account.calls))
        self.assertTrue(all(call[1].startswith(("get-", "describe-")) for call in account.calls))
        self.assertIn(["sns", "get-topic-attributes", "--topic-arn",
                       f"arn:aws:sns:{REGION}:{ACCOUNT}:hid-production-operational-alerts"], account.calls)
        # The key is resolved, then its default policy read by the resolved key id.
        self.assertIn(["kms", "describe-key", "--key-id", CUSTOMER_KEY_ALIAS], account.calls)
        self.assertIn(["kms", "get-key-policy", "--key-id", CUSTOMER_KEY_ID, "--policy-name", "default"], account.calls)

    def test_a_non_empty_google_allowlist_fails_the_launch_profile(self):
        report = self.run_checks(Account(identity(googleOidcClientIds="synthetic-client.apps.googleusercontent.com")))
        self.assertIs(report["secrets"][preflight.IDENTITY_SECRET]["google_sign_in_enabled"], True)
        self.assertIn("google_sign_in_disabled", report["launch_profile"]["failed_checks"])
        self.assertFalse(report["launch_profile"]["passed"])
        self.assert_value_free(report)

    def test_an_empty_google_value_must_still_be_present(self):
        for value in ["", "  \n"]:
            with self.subTest(value=value):
                report = self.run_checks(Account(identity(googleOidcClientIds=value)))
                self.assertTrue(report["launch_profile"]["passed"], report["launch_profile"])
        report = self.run_checks(Account(identity(googleOidcClientIds=None)))
        self.assertFalse(report["secrets"][preflight.IDENTITY_SECRET]["required_fields_present"]["googleOidcClientIds"])
        self.assertIsNone(report["secrets"][preflight.IDENTITY_SECRET]["google_sign_in_enabled"])
        self.assertIn("identity_sensitive_fields_present", report["launch_profile"]["failed_checks"])
        self.assertIn("google_sign_in_disabled", report["launch_profile"]["failed_checks"])

    def test_every_missing_identity_field_fails_the_launch_profile(self):
        for field in preflight.IDENTITY_SENSITIVE_FIELDS:
            for value in [None, ""] if field != "googleOidcClientIds" else [None]:
                with self.subTest(field=field, value=value):
                    report = self.run_checks(Account(identity(**{field: value})))
                    self.assertFalse(report["secrets"][preflight.IDENTITY_SECRET]["required_fields_present"][field])
                    self.assertIn("identity_sensitive_fields_present", report["launch_profile"]["failed_checks"])
                    self.assert_value_free(report)

    def test_every_non_canonical_key_fails_without_revealing_it(self):
        final = CANONICAL[-2]
        cases = {
            "hex": KEY.hex(),
            "unpadded": CANONICAL.rstrip("="),
            "base64url": base64.urlsafe_b64encode(KEY).decode("ascii"),
            "31 bytes": base64.b64encode(KEY[:31]).decode("ascii"),
            "33 bytes": base64.b64encode(KEY + b"\x00").decode("ascii"),
            "non-zero final bits": CANONICAL[:-2] + ("B" if final == "A" else chr(ord(final) + 1)) + "=",
            "inner whitespace": CANONICAL[:20] + " " + CANONICAL[20:],
            "number": 12345,
        }
        for label, value in cases.items():
            for field in preflight.KEY_FIELDS:
                with self.subTest(case=label, field=field):
                    report = self.run_checks(Account(identity(**{field: value})))
                    canonical = report["secrets"][preflight.IDENTITY_SECRET]["canonical_32_byte_base64"]
                    self.assertFalse(canonical[field])
                    self.assertTrue(all(canonical[other] for other in preflight.KEY_FIELDS if other != field))
                    self.assertIn("identity_keys_canonical", report["launch_profile"]["failed_checks"])
                    if isinstance(value, str):
                        self.assertNotIn(value, json.dumps(report))
        # Identity trims surrounding ASCII whitespace before its check.
        report = self.run_checks(Account(identity(mfaSecretKeyB64=f" {CANONICAL}\n")))
        self.assertTrue(report["launch_profile"]["passed"])

    def test_the_notification_secret_must_hold_exactly_the_otp_email_sms_fields(self):
        self.assertEqual(preflight.NOTIFICATION_PROVIDER_FIELDS,
                         ["sesFromAddress", "termiiBaseUrl", "termiiApiKey", "termiiSenderId"])
        for overrides, failure in [
            ({"termiiSenderId": None}, "notification_fields_present"),
            ({"termiiApiKey": ""}, "notification_fields_present"),
            ({"metaAccessToken": PRIVATE}, "notification_exact_field_set"),
            ({"brevoApiKey": PRIVATE}, "notification_exact_field_set"),
            ({"novuApiKey": PRIVATE}, "notification_exact_field_set"),
            ({"sesFromAddress": "security@elsewhere.example.invalid"}, "ses_sender_uses_verified_domain"),
        ]:
            with self.subTest(overrides=list(overrides)):
                report = self.run_checks(Account(notification_value=notification(**overrides)))
                self.assertIn(failure, report["launch_profile"]["failed_checks"])
                self.assert_value_free(report)
                self.assertNotIn("elsewhere", json.dumps(report))
        report = self.run_checks(Account(notification_value=notification(metaAccessToken=PRIVATE)))
        self.assertEqual(report["secrets"][preflight.NOTIFICATION_SECRET]["unexpected_field_count"], 1)

    def test_ses_must_have_production_access_and_a_dkim_verified_domain(self):
        for account, failure in [
            (Account(ses={"ProductionAccessEnabled": False, "SendingEnabled": True}), "ses_production_access"),
            (Account(ses={"SendingEnabled": True}), "ses_production_access"),
            (Account(ses={"ProductionAccessEnabled": True, "SendingEnabled": False}), "ses_sending_enabled"),
            (Account(dkim="PENDING"), "ses_domain_dkim"),
        ]:
            with self.subTest(failure=failure):
                self.assertIn(failure, self.run_checks(account)["launch_profile"]["failed_checks"])

    def test_the_operational_alarm_topic_must_exist_encrypted_with_a_confirmed_subscription(self):
        for topic, failure in [
            ("missing", "alarm_topic_exists"),
            ({"SubscriptionsConfirmed": "1", "SubscriptionsPending": "0"}, "alarm_topic_kms_encrypted"),
            # CloudWatch cannot publish through the AWS-managed SNS key.
            ({"KmsMasterKeyId": "alias/aws/sns", "SubscriptionsConfirmed": "1", "SubscriptionsPending": "0"},
             "alarm_topic_customer_managed_key"),
            ({"KmsMasterKeyId": "alias/hid-production-alerts", "SubscriptionsConfirmed": "0", "SubscriptionsPending": "1"},
             "alarm_topic_confirmed_subscription"),
        ]:
            with self.subTest(failure=failure):
                self.assertIn(failure, self.run_checks(Account(topic=topic))["launch_profile"]["failed_checks"])

    def test_every_spelling_of_the_aws_managed_sns_key_fails(self):
        for spelling in aws_managed_keys():
            for written in [spelling, spelling.upper() if spelling.startswith("alias/") else spelling]:
                with self.subTest(key=written):
                    report = self.run_checks(Account(topic={"KmsMasterKeyId": written, "SubscriptionsConfirmed": "1"}))
                    self.assertIs(report["alarm_topic"]["kms_encrypted"], True)
                    self.assertIs(report["alarm_topic"]["customer_managed_key"], False)
                    self.assertIn("alarm_topic_customer_managed_key", report["launch_profile"]["failed_checks"])
                    self.assertFalse(report["launch_profile"]["passed"])
                    self.assertNotIn(AWS_MANAGED_KEY_ID, json.dumps(report))

    def test_the_customer_key_is_accepted_by_alias_key_id_or_key_arn(self):
        for spelling in [CUSTOMER_KEY_ALIAS, CUSTOMER_KEY_ID, CUSTOMER_KEY_ARN]:
            with self.subTest(key=spelling):
                report = self.run_checks(Account(topic={"KmsMasterKeyId": spelling, "SubscriptionsConfirmed": "1"}))
                self.assertTrue(report["launch_profile"]["passed"], report["launch_profile"])
                self.assertNotIn(spelling, json.dumps(report))

    def test_the_topic_key_must_be_enabled_local_and_usable_by_cloudwatch(self):
        other_account = f"arn:aws:kms:{REGION}:111111111111:key/{CUSTOMER_KEY_ID}"
        other_region = f"arn:aws:kms:us-east-1:{ACCOUNT}:key/{CUSTOMER_KEY_ID}"
        for keys, policy, failure in [
            ({CUSTOMER_KEY_ALIAS: customer_key(KeyState="Disabled")}, None, "alarm_topic_key_enabled"),
            ({CUSTOMER_KEY_ALIAS: customer_key(KeyState="PendingDeletion")}, None, "alarm_topic_key_enabled"),
            ({CUSTOMER_KEY_ALIAS: customer_key(Arn=other_account)}, None, "alarm_topic_key_in_account_and_region"),
            ({CUSTOMER_KEY_ALIAS: customer_key(Arn=other_region)}, None, "alarm_topic_key_in_account_and_region"),
            ({CUSTOMER_KEY_ALIAS: customer_key(KeyManager=None)}, None, "alarm_topic_customer_managed_key"),
            # describe-key denied or the key gone: nothing is known, so nothing passes.
            ({}, None, "alarm_topic_customer_managed_key"),
            (None, "denied", "alarm_topic_key_policy_grants_cloudwatch"),
            (None, cloudwatch_key_policy(service="events.amazonaws.com"), "alarm_topic_key_policy_grants_cloudwatch"),
            (None, cloudwatch_key_policy(actions=("kms:Decrypt",)), "alarm_topic_key_policy_grants_cloudwatch"),
            (None, cloudwatch_key_policy(actions=("kms:GenerateDataKey*",)), "alarm_topic_key_policy_grants_cloudwatch"),
            (None, cloudwatch_key_policy(effect="Deny"), "alarm_topic_key_policy_grants_cloudwatch"),
            (None, cloudwatch_key_policy(service="*"), "alarm_topic_key_policy_grants_cloudwatch"),
            (None, {"Statement": "not a list"}, "alarm_topic_key_policy_grants_cloudwatch"),
        ]:
            with self.subTest(failure=failure, keys=list(keys or []), policy=str(policy)[:60]):
                report = self.run_checks(Account(keys=keys, key_policy=policy))
                self.assertIn(failure, report["launch_profile"]["failed_checks"])
                self.assertFalse(report["launch_profile"]["passed"])
                for value in [CUSTOMER_KEY_ID, CUSTOMER_KEY_ARN, "111111111111", "events.amazonaws.com"]:
                    self.assertNotIn(value, json.dumps(report))

    def test_a_policy_granting_cloudwatch_by_wildcard_actions_or_a_service_list_passes(self):
        for policy in [
            cloudwatch_key_policy(actions=("kms:*",)),
            cloudwatch_key_policy(actions=("kms:decrypt", "kms:generatedatakey")),
            cloudwatch_key_policy(service=["sns.amazonaws.com", "cloudwatch.amazonaws.com"]),
        ]:
            with self.subTest(policy=json.dumps(policy["Statement"][1])):
                report = self.run_checks(Account(key_policy=policy))
                self.assertIs(report["alarm_topic"]["key_policy_grants_cloudwatch"], True)
                self.assertTrue(report["launch_profile"]["passed"], report["launch_profile"])

    def test_an_unrecognized_key_identifier_is_never_passed_to_the_cli(self):
        for value in ["--endpoint-url=https://example.invalid", "alias/../x y", "arn:aws:s3:::bucket", " "]:
            with self.subTest(value=value):
                account = Account(topic={"KmsMasterKeyId": value, "SubscriptionsConfirmed": "1"})
                report = self.run_checks(account)
                self.assertFalse(any(call[0] == "kms" for call in account.calls))
                self.assertIs(report["alarm_topic"]["customer_managed_key"], False)
                self.assertFalse(report["launch_profile"]["passed"])

    def test_a_different_account_stops_before_any_secret_read(self):
        account = Account(account="111111111111")
        report = self.run_checks(account)
        self.assertEqual(report["status"], "wrong_account_refused")
        self.assertEqual(account.calls, [["sts", "get-caller-identity"]])
        self.assertFalse(report["launch_profile"]["passed"])

    def test_the_target_must_be_an_exact_production_account_and_region(self):
        self.assertEqual(preflight.validate_target(ACCOUNT, REGION), (ACCOUNT, REGION))
        for account, region in [(None, REGION), (ACCOUNT, None), ("12345", REGION), (ACCOUNT, "europe"),
                                (ACCOUNT, "eu-west-1 "), ("659225405023", "eu-west-1")]:
            with self.subTest(account=account, region=region):
                with self.assertRaises(ValueError):
                    preflight.validate_target(account, region)

    def test_unreadable_secrets_and_invalid_json_fail_closed(self):
        account = Account()
        del account.secrets[preflight.AUTH_SECRET]
        report = self.run_checks(account)
        self.assertEqual(report["secrets"][preflight.AUTH_SECRET], {"status": "denied_or_unavailable"})
        self.assertIn("auth_fields_present", report["launch_profile"]["failed_checks"])
        for value in ["private", "[]", "null"]:
            with self.subTest(value=value):
                summary = preflight.secret_summary(preflight.IDENTITY_SECRET,
                                                   {"ARN": arn(preflight.IDENTITY_SECRET), "SecretString": value},
                                                   ACCOUNT, REGION)
                self.assertEqual(summary["status"], "missing_or_invalid_json")
        wrong = preflight.secret_summary(preflight.IDENTITY_SECRET, {
            "ARN": f"arn:aws:secretsmanager:{REGION}:659225405023:secret:{preflight.IDENTITY_SECRET}-AbCdEf",
            "SecretString": json.dumps(identity())}, ACCOUNT, REGION)
        self.assertEqual(wrong, {"status": "unexpected_secret_identity"})

    def test_the_receipt_states_it_authorizes_nothing(self):
        report = preflight.base_report(ACCOUNT, REGION)
        self.assertIs(report["deployment_authorized"], False)
        self.assertIs(report["production_accepted"], False)
        self.assertEqual(report["environment"], "production")
        self.assertEqual(report["schema_version"], "hid.production-external-preflight/v1")


if __name__ == "__main__":
    unittest.main()
