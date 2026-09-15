import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).resolve().parents[1] / "staging-external-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class StagingPreflightTests(unittest.TestCase):
    def test_deferred_nin_credentials_are_not_staging_requirements(self):
        name = "/hid/staging/identity-sensitive"
        response = {"ARN": f"arn:aws:secretsmanager:eu-west-1:659225405023:secret:{name}-example",
                    "SecretString": json.dumps({"otpHmacKeyB64": "fixture", "turnstileSecretKey": "fixture"})}
        self.assertEqual(preflight.secret_summary(name, response)["required_fields_present"], {
            "otpHmacKeyB64": True, "turnstileSecretKey": True})
        self.assertNotIn("/hid/staging/nin-metamap", preflight.SECRET_FIELDS)

    def test_wrong_aws_account_stops_before_secret_reads(self):
        calls = []
        def call(arguments):
            calls.append(arguments)
            return {"Account": "000000000000"}, None
        self.assertEqual(preflight.aws_checks(call)["status"], "wrong_account_refused")
        self.assertEqual(calls, [["sts", "get-caller-identity"]])

    def test_secret_receipt_has_only_required_field_presence(self):
        name = "/hid/staging/notification-provider"
        value = {"ARN": f"arn:aws:secretsmanager:eu-west-1:659225405023:secret:{name}-example",
            "SecretString": json.dumps({"sesFromAddress": "synthetic@example.invalid", "novuApiKey": "never-serialize-this-value", "termiiApiKey": "also-private"})}
        result = preflight.secret_summary(name, value)
        self.assertEqual(result["required_fields_present"], {"sesFromAddress": True, "novuApiKey": True})
        self.assertNotIn("never-serialize", json.dumps(result))
        self.assertNotIn("synthetic@example.invalid", json.dumps(result))
        self.assertNotIn("termii", json.dumps(result))

    def test_wrong_secret_arn_and_invalid_json_fail_closed(self):
        name = "/hid/staging/auth"
        self.assertEqual(preflight.secret_summary(name, {"ARN": "production", "SecretString": "private"})["status"], "unexpected_secret_identity")
        for value in ["private", "[]", "null"]:
            result = preflight.secret_summary(name, {"ARN": f"arn:aws:secretsmanager:eu-west-1:659225405023:secret:{name}-example", "SecretString": value})
            self.assertEqual(result["status"], "missing_or_invalid_json")

    def test_wrong_cloudflare_zone_stops_before_resource_queries(self):
        calls = []
        def call(path, token):
            calls.append(path)
            return {"id": "wrong"}, None
        self.assertEqual(preflight.cloudflare_checks("synthetic", call)["status"], "wrong_account_or_zone_refused")
        self.assertEqual(calls, [f"/zones/{preflight.CF_ZONE}"])

    def test_cloudflare_widget_credentials_and_api_values_are_never_reported(self):
        calls = []
        def call(path, token):
            calls.append(path)
            if path == f"/zones/{preflight.CF_ZONE}":
                return {"id": preflight.CF_ZONE, "name": preflight.DOMAIN, "account": {"id": preflight.CF_ACCOUNT}}, None
            if "dns_records" in path:
                return None, "forbidden_or_expired"
            return [{"secret": "private-widget-secret", "content": "private-dns-value"}], None
        result = preflight.cloudflare_checks("private-api-token", call)
        self.assertNotIn("private-", json.dumps(result))
        self.assertEqual(result["checks"]["turnstile"]["returned_count"], 1)
        self.assertTrue(all("staging.healthidentitydirectory.com" in path for path in calls if "dns_records" in path))
        self.assertEqual(result["checks"]["dns:staging.healthidentitydirectory.com"]["status"], "forbidden_or_expired")


if __name__ == "__main__":
    unittest.main()
