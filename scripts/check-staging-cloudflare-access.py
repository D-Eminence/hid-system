#!/usr/bin/env python3
"""Read-only Cloudflare access diagnostics for fixed HID staging resources.

Use CLOUDFLARE_API_TOKEN or --prompt-token for hidden terminal entry. No Wrangler
fallback, token verification endpoint, redirects, retries, writes, or deployments.
Only sanitized metadata is printed or saved; credentials and provider messages
never enter the report. Successful reads are not staging acceptance.
"""
import argparse
import datetime
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.request
import warnings

CF_ACCOUNT = "20c809ffe35ccb2c240d19a664dff97a"
CF_ZONE = "69d385b9f6a3233a7113c525524f14fe"
DOMAIN = "healthidentitydirectory.com"
BASE_URL = "https://api.cloudflare.com/client/v4"
WORKSPACE = Path(__file__).resolve().parents[1]
LOCAL_ROOT = WORKSPACE / "release/local"
APPS = ("web", "ehr", "lab", "pharmacy", "ocr", "outreach", "admin")
APP_HOSTS = tuple(("staging" if app == "web" else f"{app}.staging") + "." + DOMAIN for app in APPS)
WORKERS = dict(zip(APP_HOSTS, (f"hid-{app}-staging" for app in APPS)))
WORKERS[f"updates.staging.{DOMAIN}"] = "hid-tuf-staging"
HOSTS = (*WORKERS, f"api.staging.{DOMAIN}")
ZONE_PATH = f"/zones/{CF_ZONE}"
ROUTES_PATH = f"/zones/{CF_ZONE}/workers/routes"
WIDGETS_PATH = f"/accounts/{CF_ACCOUNT}/challenges/widgets?per_page=100&page=1"
DNS_PATHS = {host: f"/zones/{CF_ZONE}/dns_records?name={host}&per_page=100&page=1" for host in HOSTS}
CUSTOM_PATHS = {host: f"/accounts/{CF_ACCOUNT}/workers/domains?hostname={host}&zone_id={CF_ZONE}" for host in WORKERS}
ALLOWED_PATHS = frozenset((ZONE_PATH, ROUTES_PATH, WIDGETS_PATH, *DNS_PATHS.values(), *CUSTOM_PATHS.values()))
MAX_RESPONSE = 1_000_000


class SafeFailure(Exception):
    """Only locally authored, static diagnostic codes may be used as messages."""


class SafeParser(argparse.ArgumentParser):
    def error(self, _message):
        raise SafeFailure("invalid_arguments_values_must_not_be_passed_on_command_line")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def validate_token(token):
    if not isinstance(token, str) or not token:
        raise SafeFailure("credential_unavailable")
    if token.lower().startswith("bearer "):
        raise SafeFailure("token_must_not_include_bearer_header_prefix")
    if any(ord(character) < 33 or ord(character) > 126 for character in token):
        raise SafeFailure("token_contains_whitespace_control_or_non_ascii_characters")


def hidden_token():
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise SafeFailure("hidden_token_entry_requires_interactive_terminal")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass("Cloudflare staging operator token (hidden): ")
    except getpass.GetPassWarning:
        raise SafeFailure("secure_hidden_entry_unavailable") from None


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError()
        value[key] = item
    return value


def invalid_constant(_value):
    raise ValueError()


def error_codes(body):
    """Inspect only error containers, never messages, result data, or contacts."""
    if not isinstance(body, dict):
        return []
    pending = [(body.get(name), 0) for name in ("errors", "error", "error_chain")]
    codes, visited = set(), 0
    while pending and visited < 128:
        value, depth = pending.pop()
        visited += 1
        if depth > 5:
            continue
        if isinstance(value, list):
            pending.extend((entry, depth + 1) for entry in value[:32])
        elif isinstance(value, dict):
            code = value.get("code")
            if type(code) is int and 0 <= code <= 2_147_483_647:
                codes.add(code)
            pending.append((value.get("error_chain"), depth + 1))
    return sorted(codes)[:32]


def diagnostic(status, http_status=None, codes=None):
    return {"status": status, "http_status": http_status, "cloudflare_error_codes": codes or []}


def cf_get(path, token, opener=None):
    """Return an internal body and a sanitized diagnostic. Only GET is possible."""
    try:
        validate_token(token)
    except SafeFailure as error:
        return None, diagnostic(str(error))
    if path not in ALLOWED_PATHS:
        return None, diagnostic("target_not_allowlisted")
    status = None
    try:
        request = urllib.request.Request(BASE_URL + path, method="GET", headers={
            "Authorization": "Bearer " + token, "Accept": "application/json", "Accept-Encoding": "identity"})
        # A redirect handler prevents forwarding Authorization to another host.
        transport = opener if opener is not None else urllib.request.build_opener(NoRedirect())
        try:
            response = transport.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            if type(status) is not int or not 100 <= status <= 599:
                return None, diagnostic("invalid_http_status")
            data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            return None, diagnostic("response_too_large", status)
    except (OSError, ValueError, http.client.HTTPException):
        return None, diagnostic("network_or_tls_failure", status)
    try:
        body = json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    except (ValueError, TypeError, RecursionError):
        body = None
    codes = error_codes(body)
    if 300 <= status <= 399:
        return None, diagnostic("redirect_refused", status, codes)
    if status != 200:
        cause = {400: "request_rejected", 401: "authentication_rejected", 403: "access_denied",
                 404: "resource_unavailable_or_inaccessible", 429: "rate_limited"}.get(status,
                 "provider_unavailable" if status >= 500 else "http_request_failed")
        return None, diagnostic(cause, status, codes)
    if not isinstance(body, dict):
        return None, diagnostic("invalid_response", status, codes)
    if body.get("success") is not True or body.get("errors") not in (None, []):
        return None, diagnostic("api_rejected", status, codes)
    return body, diagnostic("read", status)


def valid_list(body, info, pagination_required=False, single_page=False):
    if info["status"] != "read":
        return None, info
    result = body.get("result") if isinstance(body, dict) else None
    if not isinstance(result, list) or not all(isinstance(item, dict) for item in result):
        return None, {**info, "status": "invalid_result_shape"}
    page = body.get("result_info")
    info = {**info, "returned_count": len(result)}
    if isinstance(page, dict):
        # Retain only bounded numeric pagination metadata, even when rejected.
        # Provider strings and unrelated fields must never enter the receipt.
        info["pagination"] = {key: page[key] if type(page[key]) is int and 0 <= page[key] <= 2_147_483_647 else None
                              for key in ("count", "page", "per_page", "total_count", "total_pages") if key in page}
    if single_page:
        # Workers Domains is SinglePage in Cloudflare's generated SDK and has
        # no page/per_page query parameters. Do not impose DNS paging rules on
        # its optional metadata, which may use zero-valued paging counters.
        # https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/domains.ts
        if page is not None and not isinstance(page, dict):
            return None, {**info, "status": "pagination_unverified", "inventory_complete": False}
        numbers = info.get("pagination", {})
        if any(value is None for value in numbers.values()) or numbers.get("page", 1) > 1 or numbers.get("count", len(result)) != len(result) or numbers.get("total_count", len(result)) < len(result):
            return None, {**info, "status": "invalid_pagination", "inventory_complete": False}
        if numbers.get("total_count", len(result)) > len(result) or numbers.get("total_pages", 1) > 1:
            return None, {**info, "status": "inventory_incomplete_no_pagination_attempted", "inventory_complete": False}
        return result, {**info, "pagination_mode": "single_page", "inventory_complete": True}
    if page is None and not pagination_required:
        return result, {**info, "returned_count": len(result), "inventory_complete": True}
    if not isinstance(page, dict) or not all(type(page.get(key)) is int for key in ("count", "page", "per_page", "total_count")):
        return None, {**info, "status": "pagination_unverified", "inventory_complete": False}
    if page["count"] != len(result) or page["page"] != 1 or page["per_page"] <= 0 or page["count"] > page["per_page"] or page["total_count"] < len(result):
        return None, {**info, "status": "invalid_pagination", "inventory_complete": False}
    if "total_pages" in page and (type(page["total_pages"]) is not int or page["total_pages"] < 0):
        return None, {**info, "status": "invalid_pagination", "inventory_complete": False}
    if page["total_count"] != len(result) or page.get("total_pages", 1) > 1:
        return None, {**info, "status": "inventory_incomplete_no_pagination_attempted",
                      "returned_count": len(result), "inventory_complete": False}
    return result, {**info, "returned_count": len(result), "inventory_complete": True}


def check(token, call=cf_get):
    report = {"status": "BLOCKED", "account_and_zone_match": False, "inventory_reads_complete": False,
              "checks": {}}
    try:
        validate_token(token)
    except SafeFailure as error:
        report["zone"] = diagnostic(str(error))
        return report
    body, info = call(ZONE_PATH, token)
    report["zone"] = info
    if info["status"] != "read":
        return report
    zone = body.get("result") if isinstance(body, dict) else None
    if not isinstance(zone, dict) or zone.get("id") != CF_ZONE or zone.get("name") != DOMAIN or not isinstance(zone.get("account"), dict) or zone["account"].get("id") != CF_ACCOUNT:
        report["zone"] = {**info, "status": "wrong_account_or_zone_refused"}
        return report
    report["account_and_zone_match"] = True
    report["zone_active"] = zone.get("status") == "active"
    for host, path in DNS_PATHS.items():
        result, info = valid_list(*call(path, token), pagination_required=True)
        if result is not None and any(record.get("name") != host for record in result):
            info = {**info, "status": "dns_hostname_filter_mismatch", "inventory_complete": False}
        report["checks"]["dns:" + host] = info
    result, info = valid_list(*call(WIDGETS_PATH, token), pagination_required=True)
    if result is not None:
        if any(not isinstance(widget.get("domains"), list) or not all(isinstance(host, str) for host in widget["domains"]) for widget in result):
            info = {**info, "status": "invalid_widget_domains", "inventory_complete": False}
        else:
            info = {**info, "widget_count": len(result), "exact_staging_hostname_set_match_count": sum(
                len(widget["domains"]) == len(APP_HOSTS) and set(widget["domains"]) == set(APP_HOSTS) for widget in result)}
    report["checks"]["turnstile"] = info
    result, info = valid_list(*call(ROUTES_PATH, token))
    if result is not None and any(not isinstance(route.get("pattern"), str) for route in result):
        info = {**info, "status": "invalid_worker_route", "inventory_complete": False}
    report["checks"]["worker_routes"] = info
    for host, path in CUSTOM_PATHS.items():
        result, info = valid_list(*call(path, token), single_page=True)
        if result is not None:
            info = {**info, "expected_hostname_matches": bool(result) and all(item.get("hostname") == host for item in result),
                    "expected_zone_matches": bool(result) and all(item.get("zone_id") == CF_ZONE and item.get("zone_name") == DOMAIN for item in result),
                    "expected_worker_matches": bool(result) and all(item.get("service") == WORKERS[host] for item in result),
                    "single_expected_binding_present": len(result) == 1 and result[0].get("hostname") == host and result[0].get("zone_id") == CF_ZONE and result[0].get("zone_name") == DOMAIN and result[0].get("service") == WORKERS[host]}
            if any(item.get("hostname") != host or item.get("zone_id") != CF_ZONE or item.get("zone_name") != DOMAIN for item in result):
                info = {**info, "status": "custom_domain_filter_mismatch", "inventory_complete": False}
        report["checks"]["custom_domain:" + host] = info
    report["inventory_reads_complete"] = all(item["status"] == "read" and item.get("inventory_complete") is True for item in report["checks"].values())
    report["status"] = "READ_ONLY_DIAGNOSTIC_COMPLETE" if report["inventory_reads_complete"] else "INCOMPLETE_READ_ONLY_DIAGNOSTIC"
    return report


def open_output(path, workspace=WORKSPACE):
    """Reserve one ignored new 0600 receipt using non-symlink directory handles."""
    workspace = Path(workspace)
    root = workspace / "release/local"
    candidate = Path(path).absolute()
    directory_fd = None
    try:
        if root.resolve(strict=True) != root or candidate.resolve(strict=False) != candidate:
            raise SafeFailure("unsafe_output_path")
        relative = candidate.relative_to(root)
        if not relative.parts or any(part in (".", "..") for part in relative.parts) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.json", relative.name):
            raise SafeFailure("unsafe_output_path")
        ignored = subprocess.run(["git", "-C", str(workspace), "check-ignore", "--quiet", "--", str(candidate)],
                                 capture_output=True, timeout=5, check=False)
        if ignored.returncode != 0:
            raise SafeFailure("output_must_be_git_ignored")
        directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for part in (*relative.parts[:-1], None):
            metadata = os.fstat(directory_fd)
            if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
                raise SafeFailure("output_parent_must_be_owned_mode_0700")
            if part is not None:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                os.close(directory_fd)
                directory_fd = child
        fd = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory_fd)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "w", encoding="utf-8")
    except SafeFailure:
        raise
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise SafeFailure("output_unavailable_unsafe_or_already_exists") from None
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def base_report():
    return {"schema_version": "hid.staging-cloudflare-access-diagnostic/v1", "environment": "staging",
            "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "account_id": CF_ACCOUNT, "zone_id": CF_ZONE, "zone_name": DOMAIN,
            "deployment_authorized": False, "staging_accepted": False, "cloud_mutations": False,
            "production_changes": False, "provider_messages_included": False, "credential_values_included": False,
            "publisher_write_authority_verified": False, "turnstile_secret_binding_verified": False,
            "retries_performed": False}


def main(argv=None):
    parser = SafeParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--prompt-token", action="store_true", help="Read the operator token in a hidden interactive terminal prompt")
    parser.add_argument("--output", type=Path, help="New private JSON receipt inside ignored release/local")
    report, output = base_report(), None
    try:
        args = parser.parse_args(argv)
        if args.output:
            output = open_output(args.output)
        report["credential_source"] = "hidden_terminal" if args.prompt_token else "environment"
        token = hidden_token() if args.prompt_token else os.environ.get("CLOUDFLARE_API_TOKEN")
        report["cloudflare"] = check(token)
        exit_code = 0 if report["cloudflare"]["inventory_reads_complete"] else 1
    except (SafeFailure, EOFError, KeyboardInterrupt) as error:
        report["status"] = str(error) if isinstance(error, SafeFailure) else "diagnostic_cancelled"
        exit_code = 1
    except Exception:
        # Never let a raw exception include provider data or entered arguments.
        report["status"] = "unexpected_local_diagnostic_failure"
        exit_code = 1
    serialized = json.dumps(report, indent=2) + "\n"
    if output is not None:
        try:
            with output:
                output.write(serialized)
                output.flush()
                os.fsync(output.fileno())
        except OSError:
            report["receipt_status"] = "write_failed"
            serialized = json.dumps(report, indent=2) + "\n"
            exit_code = 1
    print(serialized, end="")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
