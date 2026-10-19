"""Configure or verify the two fixed HID production approval environments.

No credentials in arguments/output. --configure requires repository admin access;
it does not enable deployment, alter repository visibility or upgrade a plan.
"""
import argparse
import json
import os
import subprocess
import urllib.error
import urllib.request

REVIEWER='yinkaowolabi091-web'
REVIEWER_ID=246086814
TARGETS={
    'hid-system':('1317340803','production-backend','staging-novu-ci-20261005'),
    'Health-id':('1396718647','production-frontend','main'),
}

class SetupError(RuntimeError):pass

def request(path,method='GET',body=None,login='aderojuolabode'):
    token=os.environ.get('GITHUB_TOKEN')
    if not token:
        result=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\nusername='+login+'\n\n',
            env=dict(os.environ,GCM_INTERACTIVE='never',GIT_TERMINAL_PROMPT='0'),text=True,capture_output=True,timeout=30)
        values=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        token=values.get('password')
    if not token:raise SetupError('GITHUB_AUTH_REQUIRED')
    req=urllib.request.Request('https://api.github.com/'+path,method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json',
                 'X-GitHub-Api-Version':'2022-11-28','User-Agent':'HID-Production-Setup/1'})
    try:
        with urllib.request.urlopen(req,timeout=45) as response:
            data=response.read();return json.loads(data) if data else {}
    except urllib.error.HTTPError as error:raise SetupError('GITHUB_HTTP_'+str(error.code)) from None
    except urllib.error.URLError:raise SetupError('GITHUB_TRANSPORT_UNAVAILABLE') from None

def validate(environment,branches,branch):
    rules=[r for r in environment.get('protection_rules',[]) if r.get('type')=='required_reviewers']
    if len(rules)!=1 or not rules[0].get('prevent_self_review'):raise SetupError('SELF_REVIEW_PROTECTION_REQUIRED')
    reviewers=rules[0].get('reviewers',[])
    if len(reviewers)!=1 or reviewers[0].get('type')!='User' or reviewers[0].get('reviewer',{}).get('id')!=REVIEWER_ID:
        raise SetupError('EXACT_HID_REVIEWER_REQUIRED')
    if environment.get('can_admins_bypass') is not False:raise SetupError('ADMIN_BYPASS_MUST_BE_DISABLED')
    policy=environment.get('deployment_branch_policy') or {}
    if policy!={'protected_branches':False,'custom_branch_policies':True}:raise SetupError('EXPLICIT_BRANCH_POLICY_REQUIRED')
    values=branches.get('branch_policies',[])
    if len(values)!=1 or values[0].get('name')!=branch or values[0].get('type','branch')!='branch':
        raise SetupError('EXACT_DEPLOYMENT_BRANCH_REQUIRED')

def run(api,configure=False):
    reviewer=api('users/'+REVIEWER)
    if reviewer.get('id')!=REVIEWER_ID:raise SetupError('REVIEWER_IDENTITY_CHANGED')
    metadata={repo:api('repos/D-Eminence/'+repo) for repo in TARGETS}
    for repo,(repo_id,_,_) in TARGETS.items():
        meta=metadata[repo]
        if str(meta.get('id'))!=repo_id or str(meta.get('owner',{}).get('id'))!='182018869':
            raise SetupError('REPOSITORY_IDENTITY_CHANGED')
        if configure and not meta.get('permissions',{}).get('admin'):raise SetupError('REPOSITORY_ADMIN_REQUIRED:'+repo)
    result=[]
    for repo,(_,env,branch) in TARGETS.items():
        prefix='repos/D-Eminence/'+repo;path=prefix+'/environments/'+env
        if configure:
            access=api(prefix+'/collaborators/'+REVIEWER+'/permission')
            if access.get('permission') not in ('read','triage','write','maintain','admin'):
                raise SetupError('REVIEWER_REPOSITORY_ACCESS_REQUIRED')
            api(path,'PUT',{'wait_timer':0,'prevent_self_review':True,'can_admins_bypass':False,
                'reviewers':[{'type':'User','id':REVIEWER_ID}],
                'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}})
            rules=api(path+'/deployment-branch-policies?per_page=100')['branch_policies']
            if not any(v.get('name')==branch and v.get('type','branch')=='branch' for v in rules):
                api(path+'/deployment-branch-policies','POST',{'name':branch,'type':'branch'})
            for rule in rules:
                if rule.get('name')!=branch or rule.get('type','branch')!='branch':
                    api(path+'/deployment-branch-policies/'+str(rule['id']),'DELETE')
            variables=api(prefix+'/actions/variables')['variables']
            exists=any(v['name']=='PRODUCTION_DEPLOYMENT_ENABLED' for v in variables)
            api(prefix+'/actions/variables'+('/PRODUCTION_DEPLOYMENT_ENABLED' if exists else ''),
                'PATCH' if exists else 'POST',{'name':'PRODUCTION_DEPLOYMENT_ENABLED','value':'false'})
        environment=api(path)
        validate(environment,api(path+'/deployment-branch-policies?per_page=100'),branch)
        result.append({'repository':'D-Eminence/'+repo,'environment':env,'branch':branch,'reviewer':REVIEWER,
                       'verified':True,'deployment_enabled':False if configure else 'not changed'})
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--configure',action='store_true')
    parser.add_argument('--github-login',default='aderojuolabode');args=parser.parse_args()
    try:
        value=run(lambda path,method='GET',body=None:request(path,method,body,args.github_login),args.configure)
        print(json.dumps({'status':'verified','environments':value}))
    except SetupError as error:
        print(json.dumps({'status':'blocked','code':str(error),'deployment_enabled':False,
            'note':'A private frontend requires GitHub entitlement for native required reviewers. No visibility or plan change is performed.'}))
        raise SystemExit(1)
