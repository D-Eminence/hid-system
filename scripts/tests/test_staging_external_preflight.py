import base64
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
                    "SecretString": json.dumps({"otpHmacKeyB64": "fixture", "contactLookupHmacKeyB64": "fixture", "turnstileSecretKey": "fixture",
                                                "googleOidcClientIds": "fixture", "mfaSecretKeyB64": "fixture"})}
        self.assertEqual(preflight.secret_summary(name, response)["required_fields_present"], {
            "otpHmacKeyB64": True, "contactLookupHmacKeyB64": True, "turnstileSecretKey": True, "googleOidcClientIds": True,
            "mfaSecretKeyB64": True})
        self.assertNotIn("/hid/staging/nin-metamap", preflight.SECRET_FIELDS)
        self.assertNotIn("/hid/staging/nin-qoreid", preflight.SECRET_FIELDS)

    def test_identity_secret_requires_the_platform_mfa_key(self):
        name = "/hid/staging/identity-sensitive"
        self.assertIn("mfaSecretKeyB64", preflight.SECRET_FIELDS[name])
        arn = f"arn:aws:secretsmanager:eu-west-1:659225405023:secret:{name}-example"
        present = {field: "fixture" for field in preflight.SECRET_FIELDS[name]}
        self.assertTrue(preflight.secret_summary(name, {"ARN": arn, "SecretString": json.dumps(present)})["required_fields_present"]["mfaSecretKeyB64"])
        for missing in [{}, {"mfaSecretKeyB64": ""}, {"mfaSecretKeyB64": None}]:
            value = {**{field: "fixture" for field in preflight.SECRET_FIELDS[name] if field != "mfaSecretKeyB64"}, **missing}
            result = preflight.secret_summary(name, {"ARN": arn, "SecretString": json.dumps(value)})
            self.assertFalse(result["required_fields_present"]["mfaSecretKeyB64"])

    # Synthetic, non-secret key material: 32 bytes in canonical padded base64.
    KEY = bytes(range(200, 232))
    CANONICAL = base64.b64encode(KEY).decode("ascii")
    KEY_FIELDS = ["otpHmacKeyB64", "contactLookupHmacKeyB64", "mfaSecretKeyB64"]

    def identity_summary(self, **overrides):
        name = "/hid/staging/identity-sensitive"
        value = {"otpHmacKeyB64": self.CANONICAL, "contactLookupHmacKeyB64": self.CANONICAL, "turnstileSecretKey": "fixture",
                 "googleOidcClientIds": "fixture", "mfaSecretKeyB64": self.CANONICAL, **overrides}
        value = {field: item for field, item in value.items() if item is not None}
        return preflight.secret_summary(name, {"ARN": f"arn:aws:secretsmanager:eu-west-1:659225405023:secret:{name}-example",
                                               "SecretString": json.dumps(value)})

    def test_identity_secret_requires_the_contact_lookup_key(self):
        self.assertIn("contactLookupHmacKeyB64", preflight.SECRET_FIELDS["/hid/staging/identity-sensitive"])
        self.assertTrue(self.identity_summary()["required_fields_present"]["contactLookupHmacKeyB64"])
        self.assertFalse(self.identity_summary(contactLookupHmacKeyB64=None)["required_fields_present"]["contactLookupHmacKeyB64"])

    def test_identity_keys_report_the_format_identity_accepts_without_their_values(self):
        result = self.identity_summary()
        self.assertIn("canonical_32_byte_base64", result, "the identity-sensitive receipt must report whether each key has the format Identity accepts")
        self.assertEqual(result["canonical_32_byte_base64"], {field: True for field in self.KEY_FIELDS})
        self.assertNotIn(self.CANONICAL, json.dumps(result))
        # Identity trims the value before its check, so surrounding whitespace is accepted.
        self.assertTrue(self.identity_summary(mfaSecretKeyB64=f" {self.CANONICAL}\n")["canonical_32_byte_base64"]["mfaSecretKeyB64"])
        self.assertNotIn("canonical_32_byte_base64", preflight.secret_summary("/hid/staging/auth", {
            "ARN": "arn:aws:secretsmanager:eu-west-1:659225405023:secret:/hid/staging/auth-example",
            "SecretString": json.dumps({"authSigningSecret": "fixture", "authLoginPepper": "fixture"})}))

    def test_present_but_malformed_identity_keys_are_not_canonical(self):
        final = self.CANONICAL[-2]
        cases = {
            "hex": self.KEY.hex(),
            "unpadded": self.CANONICAL.rstrip("="),
            "base64url": base64.urlsafe_b64encode(self.KEY).decode("ascii"),
            "31 bytes": base64.b64encode(self.KEY[:31]).decode("ascii"),
            "33 bytes": base64.b64encode(self.KEY + b"\x00").decode("ascii"),
            "non-zero final bits": self.CANONICAL[:-2] + ("B" if final == "A" else chr(ord(final) + 1)) + "=",
            "inner whitespace": self.CANONICAL[:20] + " " + self.CANONICAL[20:],
            "non-ASCII": self.CANONICAL[:-2] + "\u00e9=",
            "number": 12345,
            "empty": "",
            "absent": None,
        }
        for label, value in cases.items():
            for field in self.KEY_FIELDS:
                with self.subTest(case=label, field=field):
                    result = self.identity_summary(**{field: value})
                    self.assertEqual(result["status"], "read")
                    self.assertIn("canonical_32_byte_base64", result, "the identity-sensitive receipt must report whether each key has the format Identity accepts")
                    self.assertFalse(result["canonical_32_byte_base64"][field])
                    for other in self.KEY_FIELDS:
                        if other != field:
                            self.assertTrue(result["canonical_32_byte_base64"][other])
                    if isinstance(value, str) and len(value) > 8:
                        self.assertNotIn(value, json.dumps(result))
        # Present but malformed is still present: the two reports answer different questions.
        hex_result = self.identity_summary(mfaSecretKeyB64=self.KEY.hex())
        self.assertTrue(hex_result["required_fields_present"]["mfaSecretKeyB64"])
        self.assertIn("canonical_32_byte_base64", hex_result, "the identity-sensitive receipt must report whether each key has the format Identity accepts")
        self.assertFalse(hex_result["canonical_32_byte_base64"]["mfaSecretKeyB64"])

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
