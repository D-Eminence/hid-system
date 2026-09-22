import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SPEC = importlib.util.spec_from_file_location(
    "cloudflare_access", Path(__file__).parents[1] / "check-staging-cloudflare-access.py")
access = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(access)
SENTINEL = "synthetic-private-value-do-not-report"


class Response:
    def __init__(self, status, body):
        self.status = status
        self.data = body if isinstance(body, bytes) else json.dumps(body).encode()

    def read(self, size):
        return self.data[:size]

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class Opener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def inventory(path, _token):
    if path == access.ZONE_PATH:
        result = {"id": access.CF_ZONE, "name": access.DOMAIN, "status": "active",
                  "account": {"id": access.CF_ACCOUNT}, "unrelated": SENTINEL}
        return {"result": result}, access.diagnostic("read", 200)
    result = []
    if path == access.WIDGETS_PATH:
        result = [{"domains": list(access.APP_HOSTS), "sitekey": SENTINEL, "secret": SENTINEL}]
    elif path in access.CUSTOM_PATHS.values():
        host = next(host for host, value in access.CUSTOM_PATHS.items() if value == path)
        result = [{"hostname": host, "zone_id": access.CF_ZONE, "zone_name": access.DOMAIN,
                   "service": access.WORKERS[host], "cert_id": SENTINEL}]
    body = {"result": result}
    if path in access.DNS_PATHS.values() or path == access.WIDGETS_PATH:
        body["result_info"] = {"count": len(result), "page": 1, "per_page": 100,
                               "total_count": len(result), "total_pages": 1}
    return body, access.diagnostic("read", 200)


class TransportTests(unittest.TestCase):
    def test_http_error_reports_only_status_and_numeric_error_chain(self):
        body = {"success": False, "errors": [{"code": 6003, "message": SENTINEL,
                "error_chain": [{"code": 6111, "message": SENTINEL}, {"code": SENTINEL}]}],
                "result": {"secret": SENTINEL}, "messages": [{"code": 9999, "message": SENTINEL}]}
        error = urllib.error.HTTPError(access.BASE_URL + access.ZONE_PATH, 400, SENTINEL, {},
                                      io.BytesIO(json.dumps(body).encode()))
        result, info = access.cf_get(access.ZONE_PATH, SENTINEL, Opener(error))
        self.assertIsNone(result)
        self.assertEqual(info, {"status": "request_rejected", "http_status": 400,
                               "cloudflare_error_codes": [6003, 6111]})
        self.assertNotIn(SENTINEL, json.dumps(info))

    def test_http_status_is_retained_for_non_json_errors(self):
        for code, expected in [(401, "authentication_rejected"), (403, "access_denied"),
                               (404, "resource_unavailable_or_inaccessible"),
                               (429, "rate_limited"), (502, "provider_unavailable")]:
            with self.subTest(code=code):
                _, info = access.cf_get(access.ZONE_PATH, SENTINEL, Opener(Response(code, SENTINEL.encode())))
                self.assertEqual(info["status"], expected)
                self.assertEqual(info["http_status"], code)
                self.assertNotIn(SENTINEL, json.dumps(info))

    def test_transport_is_allowlisted_get_with_redirects_disabled(self):
        opener = Opener(Response(200, {"success": True, "errors": [], "result": {}}))
        with patch.object(access.urllib.request, "build_opener", return_value=opener) as build:
            access.cf_get(access.ZONE_PATH, SENTINEL)
        self.assertIsInstance(build.call_args.args[0], access.NoRedirect)
        self.assertIsNone(build.call_args.args[0].redirect_request())
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, access.BASE_URL + access.ZONE_PATH)
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + SENTINEL)
        self.assertEqual(timeout, 20)
        for target in ("https://other.invalid/", "/user/tokens/verify", "/zones/other-zone"):
            _, info = access.cf_get(target, SENTINEL, opener)
            self.assertEqual(info["status"], "target_not_allowlisted")
        self.assertEqual(len(opener.requests), 1)

    def test_redirect_body_cannot_trigger_another_request(self):
        opener = Opener(Response(302, {"url": "https://other.invalid/", "token": SENTINEL}))
        result, info = access.cf_get(access.ZONE_PATH, SENTINEL, opener)
        self.assertIsNone(result)
        self.assertEqual(info["status"], "redirect_refused")
        self.assertEqual(len(opener.requests), 1)
        self.assertNotIn(SENTINEL, json.dumps(info))

    def test_network_and_malformed_success_responses_are_not_success(self):
        samples = [urllib.error.URLError(SENTINEL), Response(200, b'{"success":true,"success":false}'),
                   Response(200, b'{"success":true,"result":NaN}'),
                   Response(200, {"success": False, "errors": [{"code": 1000, "message": SENTINEL}]}),
                   Response(200, {"success": True, "errors": [{"code": 1000}]}),
                   Response(200, b'[' * 2000), Response(200, b'x' * (access.MAX_RESPONSE + 1))]
        for sample in samples:
            with self.subTest(kind=type(sample).__name__):
                body, info = access.cf_get(access.ZONE_PATH, SENTINEL, Opener(sample))
                self.assertIsNone(body)
                self.assertNotEqual(info["status"], "read")
                self.assertNotIn(SENTINEL, json.dumps(info))

    def test_invalid_token_format_is_refused_before_any_request(self):
        for token in (None, "", "Bearer " + SENTINEL, " " + SENTINEL, SENTINEL + "\n", "token\u00e9"):
            opener = Opener(Response(200, {}))
            body, info = access.cf_get(access.ZONE_PATH, token, opener)
            self.assertIsNone(body)
            self.assertNotEqual(info["status"], "read")
            self.assertFalse(opener.requests)
            self.assertNotIn(SENTINEL, json.dumps(info))
        access.validate_token("x")  # No invented provider token-length contract.


class InventoryTests(unittest.TestCase):
    def test_wrong_zone_or_failed_read_stops_before_any_inventory(self):
        for mismatch in ("zone", "account", "domain", "http"):
            calls = []
            def fake(path, token):
                calls.append(path)
                body, info = inventory(path, token)
                if mismatch == "zone":
                    body["result"]["id"] = "other"
                elif mismatch == "account":
                    body["result"]["account"]["id"] = "other"
                elif mismatch == "domain":
                    body["result"]["name"] = "other.invalid"
                else:
                    info = access.diagnostic("request_rejected", 400, [6003])
                return body, info
            result = access.check(SENTINEL, fake)
            self.assertFalse(result["account_and_zone_match"])
            self.assertEqual(calls, [access.ZONE_PATH])
            self.assertFalse(result["checks"])

    def test_complete_inventory_records_only_fixed_names_and_comparisons(self):
        calls = []
        def fake(path, token):
            calls.append(path)
            return inventory(path, token)
        result = access.check(SENTINEL, fake)
        self.assertTrue(result["inventory_reads_complete"])
        self.assertEqual(len(calls), 20)
        self.assertEqual(set(calls), access.ALLOWED_PATHS)
        self.assertNotIn(SENTINEL, json.dumps(result))
        self.assertEqual(result["checks"]["turnstile"]["exact_staging_hostname_set_match_count"], 1)
        for host in access.WORKERS:
            self.assertTrue(result["checks"]["custom_domain:" + host]["single_expected_binding_present"])

    def test_missing_or_wrong_worker_is_read_evidence_not_deployment_readiness(self):
        host = next(iter(access.WORKERS))
        for records in ([], [{"hostname": host, "zone_id": access.CF_ZONE,
                              "zone_name": access.DOMAIN, "service": "another-worker"}]):
            def fake(path, token):
                body, info = inventory(path, token)
                if path == access.CUSTOM_PATHS[host]:
                    body["result"] = records
                return body, info
            result = access.check(SENTINEL, fake)
            self.assertTrue(result["inventory_reads_complete"])
            self.assertFalse(result["checks"]["custom_domain:" + host]["single_expected_binding_present"])
            self.assertFalse(access.base_report()["deployment_authorized"])

    def test_partial_or_unverified_pagination_never_proves_absence(self):
        for page in (None, {}, {"count": 0, "page": 1, "per_page": 100, "total_count": 101},
                     {"count": True, "page": 1, "per_page": 100, "total_count": 0}):
            result, info = access.valid_list({"result": [], "result_info": page},
                                            access.diagnostic("read", 200), pagination_required=True)
            self.assertIsNone(result)
            self.assertFalse(info["inventory_complete"])

    def test_custom_domains_single_page_contract_accepts_zero_paging_counters(self):
        for records in ([], [{"hostname": "synthetic.invalid"}]):
            body = {"result": records, "result_info": {"count": len(records), "page": 0,
                    "per_page": 0, "total_count": len(records), "total_pages": 0}}
            result, info = access.valid_list(body, access.diagnostic("read", 200), single_page=True)
            self.assertEqual(result, records)
            self.assertTrue(info["inventory_complete"])
            self.assertEqual(info["pagination"]["per_page"], 0)
            self.assertEqual(info["pagination_mode"], "single_page")
            result, info = access.valid_list(body, access.diagnostic("read", 200), pagination_required=True)
            self.assertIsNone(result)  # DNS and widget pagination stays strict.
            self.assertFalse(info["inventory_complete"])
        observed_empty = {"result": [], "result_info": {"count": 0, "page": 1,
                          "per_page": 0, "total_count": 0}}
        result, info = access.valid_list(observed_empty, access.diagnostic("read", 200), single_page=True)
        self.assertEqual(result, [])
        self.assertTrue(info["inventory_complete"])
        def fake(path, token):
            body, info = inventory(path, token)
            if path in access.CUSTOM_PATHS.values():
                body = {"result": [], "result_info": {"count": 0, "page": 0,
                        "per_page": 0, "total_count": 0, "total_pages": 0}}
            return body, info
        result = access.check(SENTINEL, fake)
        self.assertTrue(result["inventory_reads_complete"])
        self.assertTrue(all(not result["checks"]["custom_domain:" + host]["single_expected_binding_present"]
                            for host in access.WORKERS))

    def test_single_page_retains_safe_metadata_and_rejects_partial_or_conflicting_counts(self):
        for metadata in ({"count": 1, "total_count": 0}, {"total_count": 2},
                         {"page": 2, "count": 0, "total_count": 0, "total_pages": 1},
                         {"total_pages": 2}, {"per_page": SENTINEL, "raw": SENTINEL}):
            result, info = access.valid_list({"result": [], "result_info": metadata},
                                            access.diagnostic("read", 200), single_page=True)
            self.assertIsNone(result)
            self.assertFalse(info["inventory_complete"])
            self.assertNotIn(SENTINEL, json.dumps(info))
            self.assertNotIn("raw", info["pagination"])

    def test_result_shape_and_filtered_hostname_mismatches_block_inventory(self):
        host = next(iter(access.DNS_PATHS))
        for payload in ({}, [None], [{"name": "production.invalid", "content": SENTINEL}]):
            def fake(path, token):
                body, info = inventory(path, token)
                if path == access.DNS_PATHS[host]:
                    body["result"] = payload
                    body["result_info"]["count"] = len(payload)
                    body["result_info"]["total_count"] = len(payload)
                return body, info
            result = access.check(SENTINEL, fake)
            self.assertFalse(result["inventory_reads_complete"])
            self.assertNotIn(SENTINEL, json.dumps(result))


class LocalEntryTests(unittest.TestCase):
    def test_hidden_entry_requires_tty_and_has_no_visible_fallback(self):
        with patch.object(access.sys.stdin, "isatty", return_value=False), patch.object(access.getpass, "getpass") as prompt:
            with self.assertRaises(access.SafeFailure):
                access.hidden_token()
            prompt.assert_not_called()
        with patch.object(access.sys.stdin, "isatty", return_value=True), patch.object(access.sys.stderr, "isatty", return_value=True), patch.object(access.getpass, "getpass", side_effect=access.getpass.GetPassWarning(SENTINEL)):
            with self.assertRaisesRegex(access.SafeFailure, "secure_hidden_entry_unavailable"):
                access.hidden_token()

    def test_bad_cli_arguments_and_missing_environment_do_not_expose_values(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = access.main(["--token", SENTINEL])
        self.assertEqual(code, 1)
        self.assertNotIn(SENTINEL, output.getvalue())
        with patch.dict(os.environ, {}, clear=True), patch.object(access, "cf_get") as transport, contextlib.redirect_stdout(io.StringIO()) as output:
            code = access.main([])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["cloudflare"]["zone"]["status"], "credential_unavailable")
        transport.assert_not_called()

    def test_output_requires_private_ignored_new_non_symlink_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            local = workspace / "release/local"
            local.mkdir(parents=True, mode=0o700)
            target = local / "report.json"
            with patch.object(access.subprocess, "run") as run:
                run.return_value.returncode = 0
                with access.open_output(target, workspace) as stream:
                    stream.write('{}\n')
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                with self.assertRaises(access.SafeFailure):
                    access.open_output(target, workspace)
                (local / "link.json").symlink_to(target)
                with self.assertRaises(access.SafeFailure):
                    access.open_output(local / "link.json", workspace)
                with self.assertRaises(access.SafeFailure):
                    access.open_output(workspace / "outside.json", workspace)
                (local / "linked").symlink_to(workspace, target_is_directory=True)
                with self.assertRaises(access.SafeFailure):
                    access.open_output(local / "linked/report.json", workspace)
                local.chmod(0o755)
                with self.assertRaises(access.SafeFailure):
                    access.open_output(local / "public.json", workspace)
                local.chmod(0o700)
                run.return_value.returncode = 1
                with self.assertRaises(access.SafeFailure):
                    access.open_output(local / "not-ignored.json", workspace)

    def test_failed_diagnostic_saves_sanitized_report_and_returns_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            with patch.object(access, "open_output", side_effect=lambda _: path.open('w')), patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "Bearer " + SENTINEL}), contextlib.redirect_stdout(io.StringIO()) as output:
                code = access.main(["--output", str(path)])
            self.assertEqual(code, 1)
            self.assertEqual(path.read_text(), output.getvalue())
            self.assertNotIn(SENTINEL, output.getvalue())
            report = json.loads(path.read_text())
            self.assertFalse(report["cloud_mutations"])
            self.assertFalse(report["deployment_authorized"])
            self.assertEqual(report["cloudflare"]["zone"]["status"], "token_must_not_include_bearer_header_prefix")

    def test_unsafe_output_stops_before_token_entry_or_cloud_read(self):
        with patch.object(access, "open_output", side_effect=access.SafeFailure("unsafe_output_path")), patch.object(access, "hidden_token") as prompt, patch.object(access, "check") as check, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(access.main(["--prompt-token", "--output", "unsafe.json"]), 1)
        prompt.assert_not_called()
        check.assert_not_called()


if __name__ == "__main__":
    unittest.main()
