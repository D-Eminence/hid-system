"""Reject privilege or resource-scope changes in the actual saved Terraform plan."""
import json,sys
p=json.load(open(sys.argv[1],encoding='utf-8-sig'))
changes=[r for r in p['resource_changes'] if r['mode']=='managed' and r['change']['actions']!=['no-op']]
allowed={'aws_iam_openid_connect_provider.github','aws_iam_role.build','aws_iam_role_policy.build'}
if any(r['address'] not in allowed or r['change']['actions']!=['create'] for r in changes):
    raise SystemExit('Only the three new build IAM resources may be created')
resources={r['address']:r['values'] for r in p['planned_values']['root_module']['resources'] if r['mode']=='managed'}
provider=resources['aws_iam_openid_connect_provider.github']
assert provider['url']=='https://token.actions.githubusercontent.com'
assert provider['client_id_list']==['sts.amazonaws.com']
role=resources['aws_iam_role.build'];assert role['name']=='hid-staging-github-ecr-build'
trust=json.loads(role['assume_role_policy'])['Statement'];assert len(trust)==1
assert trust[0]['Action']=='sts:AssumeRoleWithWebIdentity'
conditions=trust[0]['Condition']['StringEquals']
assert conditions['token.actions.githubusercontent.com:aud']=='sts.amazonaws.com'
prefix='repo:D-Eminence@182018869/hid-system@1317340803:ref:refs/heads/'
assert set(conditions['token.actions.githubusercontent.com:sub'])=={prefix+'staging',prefix+'staging-novu-ci-20261005'}
policy=json.loads(resources['aws_iam_role_policy.build']['policy'])['Statement'];assert len(policy)==2
assert policy[0]['Action']=='ecr:GetAuthorizationToken' and policy[0]['Resource']=='*'
expected={'ecr:BatchCheckLayerAvailability','ecr:InitiateLayerUpload','ecr:UploadLayerPart','ecr:CompleteLayerUpload',
          'ecr:PutImage','ecr:BatchGetImage','ecr:GetDownloadUrlForLayer','ecr:DescribeRepositories','ecr:DescribeImages'}
assert set(policy[1]['Action'])==expected
assert len(policy[1]['Resource'])==12 and all(r.startswith('arn:aws:ecr:eu-west-1:659225405023:repository/staging/hid/') for r in policy[1]['Resource'])
assert all(s['Effect']=='Allow' for s in policy+trust)
print(json.dumps({'status':'passed','managed_changes':len(changes),'scope':'staging ECR only','oidc_subjects':'two exact immutable repository branch subjects'}))
