"""Terraform external protocol: apply-time verified index/lease read, no mutations."""
import json
import sys
from production_deployment_core import ACCOUNT, REGION, INDEX_KEY, AWS, Lease, Store, canonical, require, sha, validate_index


def read(query, aws=None):
    require(query.get('environment') == 'production', 'EXACT_PRODUCTION_REQUIRED')
    require(query.get('account') == ACCOUNT and query.get('region') == REGION, 'EXACT_STAGING_REQUIRED')
    require(query.get('bucket') == 'hid-staging-releases-'+ACCOUNT+'-'+REGION, 'EXACT_RELEASE_BUCKET_REQUIRED')
    aws = aws or AWS()
    aws.account()
    # Read latest first; selecting only an old VersionId would silently admit a stale plan.
    with __import__('tempfile').TemporaryDirectory() as folder:
        path = __import__('pathlib').Path(folder)/'index.json'
        meta = aws.call('s3api','get-object',{'Bucket':query['bucket'],'Key':INDEX_KEY,
            'ExpectedBucketOwner':ACCOUNT},extra=[str(path)])
        value = json.loads(path.read_bytes())
    validate_index(value)
    require(meta.get('VersionId') == query['version_id'] and sha(canonical(value)) == query['sha256']
        and meta.get('ServerSideEncryption') == 'aws:kms'
        and meta.get('SSEKMSKeyId','').startswith('arn:aws:kms:'+REGION+':'+ACCOUNT+':key/'), 'INDEX_CHANGED')
    lease = Lease(aws,query['holder'],table='hid-staging-deployment-leases')
    lease.generation = query['generation']
    lease.assert_owned()
    return {'valid':'true','image_uris':json.dumps({n:r['image_uri'] for n,r in value['backend'].items()},sort_keys=True),
            'migration_image_uri':value['migration_image_uri']}


if __name__ == '__main__':
    try:
        print(json.dumps(read(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({'valid':'false','image_uris':'{}','migration_image_uri':''}))
