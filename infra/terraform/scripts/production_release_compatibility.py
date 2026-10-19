"""Read-only source admission for promotion of the retained HID database.

Never rewrites migration history or treats a merged commit as schema compatibility.
Uses committed Git blobs to avoid Windows checkout newline differences.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

MIGRATIONS = "services/ehr-api/database/migrations/"
REQUIRED_WORKLOADS = (
    "identity-api", "ehr-api", "lab-api", "pharmacy-api", "ocr-api", "ocr-worker",
    "outreach-api", "notification-api", "notification-worker", "event-dispatcher",
    "support-api",
)


def migration_changes(baseline, candidate):
    """Each mapping is immutable filename -> exact committed SQL bytes."""
    return {
        "removed": sorted(set(baseline) - set(candidate)),
        "modified": sorted(name for name in baseline.keys() & candidate.keys()
                           if baseline[name] != candidate[name]),
        "added": sorted(set(candidate) - set(baseline)),
    }


def git(repository, *args):
    repository = Path(repository).resolve()
    result = subprocess.run(["git", "-c", "safe.directory=" + repository.as_posix(),
                             "-C", str(repository), *args], capture_output=True, timeout=90)
    if result.returncode:
        raise ValueError("COMMITTED_SOURCE_READ_FAILED")
    return result.stdout


def source(repository, commit):
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ValueError("EXACT_SOURCE_COMMIT_REQUIRED")
    actual = git(repository, "rev-parse", commit + "^{commit}").decode().strip()
    if actual != commit:
        raise ValueError("SOURCE_COMMIT_DIFFERS")
    paths = git(repository, "ls-tree", "-r", "--name-only", commit).decode().splitlines()
    migrations = {name.removeprefix(MIGRATIONS):
                  git(repository, "show", commit + ":" + name)
                  for name in paths if name.startswith(MIGRATIONS) and name.endswith(".sql")}
    if not migrations:
        raise ValueError("MIGRATION_SOURCE_REQUIRED")
    return set(paths), migrations


def inspect(repository, baseline_commit, candidate_commit):
    _, baseline = source(repository, baseline_commit)
    paths, candidate = source(repository, candidate_commit)
    changes = migration_changes(baseline, candidate)
    missing = [name for name in REQUIRED_WORKLOADS
               if f"services/{name}/Dockerfile" not in paths]
    blockers = []
    if changes["removed"]:
        blockers.append("RETAINED_MIGRATION_FILES_REMOVED")
    if changes["modified"]:
        blockers.append("EXISTING_MIGRATION_CONTENT_CHANGED")
    if missing:
        blockers.append("RETAINED_WORKLOAD_SOURCE_MISSING")
    return {
        "schema": "hid.production-source-compatibility/v1",
        "baseline_commit": baseline_commit,
        "candidate_commit": candidate_commit,
        "source_compatible": not blockers,
        "blockers": blockers,
        "migration_changes": changes,
        "missing_workload_sources": missing,
        "migration_set_sha256": {
            label: hashlib.sha256(json.dumps({name: hashlib.sha256(sql).hexdigest()
                  for name, sql in sorted(mapping.items())}, sort_keys=True).encode()).hexdigest()
            for label, mapping in [("baseline", baseline), ("candidate", candidate)]
        },
        "live_database_inspected": False,
        "database_migration_authorized": False,
        "note": "Source admission only. Added migrations still require database rehearsal and rollback review.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = inspect(args.repository, args.baseline, args.candidate)
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"source_compatible": report["source_compatible"],
                      "blockers": report["blockers"],
                      "migration_counts": {k: len(v) for k, v in report["migration_changes"].items()},
                      "missing_workload_sources": report["missing_workload_sources"]}))
    return 0 if report["source_compatible"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
