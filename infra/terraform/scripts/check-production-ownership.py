"""Read-only Terraform external check for adoption of HID's existing stack.

Never emits state, credentials, endpoint URLs or clinical values. It rejects an
empty/new backend before Terraform can create a duplicate production stack.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def verify_state(state, lineage, account):
    if not re.fullmatch(r"[0-9a-f-]{36}", lineage) or state.get("lineage") != lineage:
        raise ValueError("EXISTING_STATE_LINEAGE_REQUIRED")
    resources = {
        (r.get("module"), r.get("type"), r.get("name")): r.get("instances", [])
        for r in state.get("resources", []) if r.get("mode") == "managed"
    }
    database = resources.get(("module.data", "aws_db_instance", "main"), [])
    cluster = resources.get(("module.application", "aws_ecs_cluster", "main"), [])
    if len(database) != 1 or database[0]["attributes"].get("identifier") != "hid-staging-postgres":
        raise ValueError("EXISTING_DATABASE_REQUIRED")
    expected = f"arn:aws:ecs:eu-west-1:{account}:cluster/hid-staging"
    production = resources.get(("module.application", "aws_ecs_cluster", "production"), [])
    legacy_valid = len(cluster) == 1 and cluster[0]["attributes"].get("arn") == expected
    production_expected = f"arn:aws:ecs:eu-west-1:{account}:cluster/hid-production"
    production_valid = len(production) == 1 and production[0]["attributes"].get("arn") == production_expected
    if not (legacy_valid or (not cluster and production_valid)):
        raise ValueError("EXISTING_CLUSTER_REQUIRED")
    return {"valid": "true", "lineage": lineage, "account": account}


def command(*args):
    result = subprocess.run(args, capture_output=True, check=False)
    if result.returncode:
        raise ValueError("BACKEND_READ_FAILED")
    return result.stdout


def main():
    query = json.load(sys.stdin)
    account = query["account"]
    if not re.fullmatch(r"\d{12}", account):
        raise ValueError("EXPECTED_ACCOUNT_REQUIRED")
    data_directory = Path(os.environ.get("TF_DATA_DIR", ".terraform"))
    cache = json.loads((data_directory / "terraform.tfstate").read_text(encoding="utf-8"))["backend"]
    config = cache["config"]
    if (cache["type"] != "s3" or config.get("region") != "eu-west-1"
            or config.get("key") != query["backend_key"]
            or query["backend_key"] not in {
                "health-identity/staging/terraform.tfstate",
                "health-identity/production/terraform.tfstate",
            }):
        raise ValueError("EXACT_ADOPTION_BACKEND_REQUIRED")
    caller = json.loads(command("aws", "sts", "get-caller-identity", "--region", "eu-west-1", "--output", "json"))
    if caller["Account"] != account:
        raise ValueError("EXPECTED_ACCOUNT_REQUIRED")
    # Capture into memory. S3 object/state contents never appear in console output
    # or an unprotected temporary file; AWS credentials stay in the CLI chain.
    state = json.loads(command("aws", "s3", "cp", f"s3://{config['bucket']}/{config['key']}", "-",
                               "--region", "eu-west-1", "--only-show-errors"))
    result = verify_state(state, query["lineage"], account)
    result["backend_key"] = config["key"]
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r"[A-Z_]+", code):
            code = "OWNERSHIP_CHECK_FAILED"
        print(json.dumps({"valid": "false", "safe_code": code}))
