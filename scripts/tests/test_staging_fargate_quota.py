import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("quota", Path(__file__).parents[1] / "check-staging-fargate-quota.py")
quota = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quota)


class QuotaTest(unittest.TestCase):
    def setUp(self):
        self.limit = {"QuotaArn": quota.QUOTA_ARN, "ServiceCode": "fargate", "QuotaCode": quota.QUOTA_CODE,
            "GlobalQuota": False, "Value": 6}
        self.request = {**self.limit, "Id": quota.REQUEST_ID, "DesiredValue": 32, "Status": "CASE_OPENED"}

    def test_pending_does_not_clear_even_if_applied_limit_changes(self):
        for value in (6, 32):
            result = quota.summarize({**self.limit, "Value": value}, self.request)
            self.assertTrue(result["request_pending"])
            self.assertFalse(result["quota_gate_cleared"])
            self.assertFalse(result["deployment_authorized"])
            self.assertEqual(result["requested_capacity_applied"], value == 32)

    def test_approval_is_not_an_applied_increase(self):
        result = quota.summarize(self.limit, {**self.request, "Status": "APPROVED"})
        self.assertEqual(result["decision"], "APPROVED_AWAITING_APPLIED_QUOTA")
        self.assertFalse(result["quota_gate_cleared"])

    def test_applied_limit_never_claims_free_capacity_or_release_permission(self):
        result = quota.summarize({**self.limit, "Value": 32}, {**self.request, "Status": "APPROVED"})
        self.assertTrue(result["quota_gate_cleared"])
        self.assertFalse(result["available_capacity_verified"])
        self.assertFalse(result["deployment_authorized"])
        self.assertFalse(result["staging_accepted"])

    def test_closed_or_rejected_request_is_not_approval(self):
        for status in ("CASE_CLOSED", "DENIED", "NOT_APPROVED", "INVALID_REQUEST"):
            result = quota.summarize({**self.limit, "Value": 32}, {**self.request, "Status": status})
            self.assertFalse(result["quota_gate_cleared"])
            self.assertEqual(result["decision"], "REQUEST_OUTCOME_REVIEW_REQUIRED")

    def test_wrong_account_stops_before_any_quota_read(self):
        calls = []
        def read(args):
            calls.append(args)
            return {"Account": "000000000000"}
        with self.assertRaises(ValueError):
            quota.check(read)
        self.assertEqual(calls, [["sts", "get-caller-identity"]])

    def test_all_calls_are_fixed_reads_of_the_existing_request(self):
        calls = []
        responses = [{"Account": quota.ACCOUNT}, {"Quota": self.limit}, {"RequestedQuota": self.request}]
        def read(args):
            calls.append(args)
            return responses[len(calls)-1]
        result = quota.check(read)
        self.assertEqual([args[1] for args in calls], ["get-caller-identity", "get-service-quota", "get-requested-service-quota-change"])
        self.assertEqual(calls[-1][-1], quota.REQUEST_ID)
        self.assertTrue(result["duplicate_request_prohibited"])

    def test_rejects_wrong_quota_request_region_and_malformed_values(self):
        for field, value in [("Id", "different"), ("DesiredValue", 64), ("Status", "unknown"),
                ("QuotaRequestedAtLevel", "RESOURCE"), ("QuotaArn", quota.QUOTA_ARN.replace("eu-west-1", "eu-west-2")),
                ("QuotaCode", "L-SPOT"), ("GlobalQuota", True)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                quota.summarize(self.limit, {**self.request, field: value})
        for value in [True, 0, -1, "32", float("nan"), float("inf")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                quota.summarize({**self.limit, "Value": value}, self.request)

    def test_expired_session_is_distinguished_without_reflecting_cli_output(self):
        result = SimpleNamespace(returncode=1, stdout="", stderr="Token expired: SECRET-SENTINEL")
        with patch.object(quota.subprocess, "run", return_value=result), self.assertRaises(quota.QuotaReadError) as raised:
            quota.aws_read(["sts", "get-caller-identity"])
        self.assertEqual(raised.exception.category, "expired_browser_session")
        self.assertNotIn("SECRET-SENTINEL", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
