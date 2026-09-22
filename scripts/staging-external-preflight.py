#!/usr/bin/env python3
"""Read-only, value-free checks for the fixed HID staging account and zone.

No login, provisioning, delivery, signing, deployment, or secret mutation occurs.
Run without --cloud-read-only for an entirely local configuration inventory.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import tomllib
import urllib.error
import urllib.request

AWS_ACCOUNT = "659225405023"
AWS_REGION = "eu-west-1"
CF_ACCOUNT = "20c809ffe35ccb2c240d19a664dff97a"
CF_ZONE = "69d385b9f6a3233a7113c525524f14fe"
DOMAIN = "healthidentitydirectory.com"
HOSTS = ["staging." + DOMAIN] + [f"{app}.staging.{DOMAIN}" for app in
    ["ehr", "lab", "pharmacy", "ocr", "outreach", "admin", "updates", "api"]]
SECRET_FIELDS = {
    "/hid/staging/auth": ["authSigningSecret", "authLoginPepper"],
    "/hid/staging/identity-sensitive": ["otpHmacKeyB64", "turnstileSecretKey"],
    "/hid/staging/notification-provider": ["sesFromAddress", "novuApiKey"],
}


def aws_json(arguments, run=subprocess.run):
    # Callers below supply only fixed read-only commands, never caller-provided argv.
    try:
        result = run(["aws", *arguments, "--profile", "hid-admin", "--region", AWS_REGION,
            "--output", "json", "--no-cli-pager"], capture_output=True, text=True, timeout=25)
        if result.returncode:
            message = (result.stderr + result.stdout).lower()
            return None, "expired_browser_session" if "expired" in message else "denied_or_unavailable"
        return json.loads(result.stdout), None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None, "unavailable_or_invalid_response"


def secret_summary(name, response):
    expected = f"arn:aws:secretsmanager:{AWS_REGION}:{AWS_ACCOUNT}:secret:{name}-"
    if not isinstance(response, dict) or not str(response.get("ARN", "")).startswith(expected):
        return {"status": "unexpected_secret_identity"}
    try:
        value = json.loads(response.get("SecretString", ""))
    except (ValueError, TypeError):
        return {"status": "missing_or_invalid_json"}
    if not isinstance(value, dict):
        return {"status": "missing_or_invalid_json"}
    return {"status": "read", "required_fields_present": {
        field: isinstance(value.get(field), str) and bool(value[field].strip())
        for field in SECRET_FIELDS[name]}}


def aws_checks(call=aws_json):
    identity, error = call(["sts", "get-caller-identity"])
    if error or not isinstance(identity, dict):
        return {"status": error or "invalid_identity", "account_matches": False}
    if identity.get("Account") != AWS_ACCOUNT:
        return {"status": "wrong_account_refused", "account_matches": False}
    report = {"status": "authenticated", "account_matches": True, "region": AWS_REGION, "secrets": {}}
    for name in SECRET_FIELDS:
        value, error = call(["secretsmanager", "get-secret-value", "--secret-id", name])
        report["secrets"][name] = {"status": error} if error else secret_summary(name, value)
    account, error = call(["sesv2", "get-account"])
    report["ses"] = {"status": error or "invalid_response"} if error or not isinstance(account, dict) else {
        "status": "read", "sending_enabled": account.get("SendingEnabled") is True,
        "production_access_enabled": account.get("ProductionAccessEnabled") is True}
    return report


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def cf_get(path, token):
    request = urllib.request.Request("https://api.cloudflare.com/client/v4" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"}, method="GET")
    try:
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(request, timeout=20) as response:
            status, data = response.status, response.read(1_000_001)
    except urllib.error.HTTPError as error:
        status, data = error.code, error.read(1_000_001)
    except (OSError, ValueError):
        return None, "network_failure"
    if status != 200:
        return None, "forbidden_or_expired" if status in [401, 403] else "request_failed"
    if len(data) > 1_000_000:
        return None, "response_too_large"
    try:
        body = json.loads(data)
        if not isinstance(body, dict) or body.get("success") is not True:
            return None, "api_rejected"
        return body.get("result"), None
    except (ValueError, TypeError):
        return None, "invalid_response"


def cloudflare_checks(token, call=cf_get):
    if not token:
        return {"status": "credential_unavailable"}
    zone, error = call(f"/zones/{CF_ZONE}", token)
    if error:
        return {"status": error}
    if not isinstance(zone, dict) or zone.get("id") != CF_ZONE or zone.get("name") != DOMAIN \
            or not isinstance(zone.get("account"), dict) or zone["account"].get("id") != CF_ACCOUNT:
        return {"status": "wrong_account_or_zone_refused"}
    report = {"status": "authenticated", "account_and_zone_match": True, "checks": {}}
    paths = {"worker_routes": f"/zones/{CF_ZONE}/workers/routes",
        "turnstile": f"/accounts/{CF_ACCOUNT}/challenges/widgets?per_page=100"}
    paths.update({"dns:" + host: f"/zones/{CF_ZONE}/dns_records?name={host}&per_page=100" for host in HOSTS})
    for name, path in paths.items():
        value, error = call(path, token)
        # No record contents, widget keys, contacts, API error messages or tokens are serialized.
        report["checks"][name] = {"status": error or "read",
            "returned_count": len(value) if not error and isinstance(value, list) else None}
    return report


def local_configuration():
    config = Path.home() / ".config/.wrangler/config/default.toml"
    values = {}
    if config.is_file():
        try:
            values = tomllib.loads(config.read_text())
        except (OSError, ValueError):
            pass
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or values.get("oauth_token")
    known_scopes = {"user:read", "offline_access", "account:read", "zone:read", "workers_scripts:write", "workers_routes:write"}
    scopes = values.get("scopes", [])
    report = {"aws_profile": "hid-admin", "aws_config_exists": (Path.home() / ".aws/config").is_file(),
        "cloudflare_credential_present": isinstance(token, str) and bool(token),
        "cloudflare_credential_source": "environment" if os.environ.get("CLOUDFLARE_API_TOKEN") else "wrangler",
        "cloudflare_scope_names": sorted(set(scopes).intersection(known_scopes))
            if isinstance(scopes, list) and all(isinstance(scope, str) for scope in scopes)
            and not os.environ.get("CLOUDFLARE_API_TOKEN") else []}
    return report, token if isinstance(token, str) else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cloud-read-only", action="store_true", help="Use existing credentials for fixed staging GET/read checks")
    parser.add_argument("--output", type=Path, help="Write a new, value-free receipt; existing files are never overwritten")
    args = parser.parse_args()
    local, token = local_configuration()
    report = {"schema_version": "hid.staging-external-preflight/v1", "environment": "staging",
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "local": local,
        "deployment_authorized": False, "staging_accepted": False,
        "nin": {"state": "deferred", "required_for_staging": False, "provider_secret_required": False},
        "scope": "read-only presence checks, not provider delivery or release acceptance"}
    if args.cloud_read_only:
        report["aws"] = aws_checks()
        report["cloudflare"] = cloudflare_checks(token)
    serialized = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as stream:
            stream.write(serialized)
    print(serialized, end="")


if __name__ == "__main__":
    main()
