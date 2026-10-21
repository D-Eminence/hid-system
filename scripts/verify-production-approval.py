"""Verify run-bound deployment policy before acquiring cloud credentials."""
import json
import os
from pathlib import Path
import sys
from production_deployment_core import context, validate_candidate, file_sha, require, GitHub
if __name__ == '__main__':
    path = Path(sys.argv[1])
    candidate = json.loads(path.read_text(encoding='utf-8'))
    ctx = context('backend')
    require(file_sha(path) == os.environ.get('EXPECTED_CANDIDATE_SHA256'), 'APPROVED_ARTIFACT_CHANGED')
    validate_candidate(candidate, ctx)
    GitHub(ctx['repository']).assert_approval(candidate)
    print('Exact production candidate and deployment policy verified')
