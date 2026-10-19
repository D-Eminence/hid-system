"""Admit unchanged existing Novu ECR-only publisher trust for production builds."""
import json
import sys

ACCOUNT = "659225405023"
REGION = "eu-west-1"
PREFIX = "repo:D-Eminence@182018869/hid-system@1317340803:ref:refs/heads/"


def validate(plan):
    changes = [r for r in plan.get("resource_changes", [])
               if r.get("mode") == "managed" and r["change"]["actions"] != ["no-op"]]
    if changes:
        raise ValueError("EXISTING_NOVU_PUBLISHER_MUST_REMAIN_UNCHANGED")
    resources = {r["address"]: r["values"] for r in plan["planned_values"]["root_module"]["resources"] if r.get("mode") == "managed"}
    role = resources["aws_iam_role.build"]
    if role['name'] != 'hid-staging-github-ecr-build':
        raise ValueError('EXACT_EXISTING_PUBLISHER_REQUIRED')
    for values, branches in [(role, {"staging", "staging-novu-ci-20261005"})]:
        trust = json.loads(values["assume_role_policy"])
        rows = trust["Statement"]
        if len(rows) != 1:
            raise ValueError("EXACT_REPOSITORY_TRUST_REQUIRED")
        row = rows[0]
        if row.get("Effect") != "Allow" or row.get("Action") != "sts:AssumeRoleWithWebIdentity" or row.get("Principal") != {"Federated": f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"}:
            raise ValueError("EXACT_OIDC_PRINCIPAL_REQUIRED")
        expected = {"StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                     "token.actions.githubusercontent.com:sub": sorted(PREFIX + b for b in branches)}}
        actual = row["Condition"]
        actual["StringEquals"]["token.actions.githubusercontent.com:sub"].sort()
        if actual != expected:
            raise ValueError("EXACT_NOVU_REPOSITORY_SUBJECT_REQUIRED")
    policy = json.loads(resources["aws_iam_role_policy.build"]["policy"])["Statement"]
    expected_actions = {"ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
                        "ecr:DescribeRepositories", "ecr:DescribeImages"}
    components = {"identity-api", "ehr-api", "lab-api", "pharmacy-api", "ocr-api", "ocr-worker", "outreach-api",
                  "notification-api", "notification-worker", "event-dispatcher", "gateway", "support-api"}
    repositories = {f"arn:aws:ecr:{REGION}:{ACCOUNT}:repository/staging/hid/{name}" for name in components}
    if len(policy) != 2 or any(s.get("Effect") != "Allow" for s in policy):
        raise ValueError("EXACT_ECR_POLICY_REQUIRED")
    if policy[0].get("Action") != "ecr:GetAuthorizationToken" or policy[0].get("Resource") != "*" or set(policy[1]["Action"]) != expected_actions or set(policy[1]["Resource"]) != repositories:
        raise ValueError("ECR_SCOPE_EXPANSION_REJECTED")
    return {"passed": True, "managed_changes": 0, "existing_trusted_branch": "staging-novu-ci-20261005", "runtime_mutation_permission": False}


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8-sig") as source:
        print(json.dumps(validate(json.load(source))))
