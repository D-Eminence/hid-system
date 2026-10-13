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


class Account:
    """A mocked, read-only production account: every AWS CLI call is answered here."""

    def __init__(self, identity_value=None, notification_value=None, account=ACCOUNT, ses=None, dkim="SUCCESS",
                 topic=None):
        self.calls = []
        self.account = account
        self.secrets = {
            preflight.AUTH_SECRET: {"authSigningSecret": PRIVATE, "authLoginPepper": PRIVATE},
            preflight.IDENTITY_SECRET: identity() if identity_value is None else identity_value,
            preflight.NOTIFICATION_SECRET: notification() if notification_value is None else notification_value,
        }
        self.ses = {"ProductionAccessEnabled": True, "SendingEnabled": True} if ses is None else ses
        self.dkim = dkim
        self.topic = {"KmsMasterKeyId": "alias/hid-production-alerts", "SubscriptionsConfirmed": "2",
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
                                                 "subscriptions_confirmed": 2, "subscriptions_pending": 0})
        self.assertNotIn("alias/hid-production-alerts", json.dumps(report))
        self.assert_value_free(report)
        # Read-only calls only; the alarm topic is the exact one in this account and region.
        self.assertTrue(all(call[0] in {"sts", "secretsmanager", "sesv2", "sns"} for call in account.calls))
        self.assertTrue(all(call[1].startswith("get-") for call in account.calls))
        self.assertIn(["sns", "get-topic-attributes", "--topic-arn",
                       f"arn:aws:sns:{REGION}:{ACCOUNT}:hid-production-operational-alerts"], account.calls)

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
