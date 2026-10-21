import copy
import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('setup',pathlib.Path(__file__).resolve().parents[1]/'scripts/configure_production_environments.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class GateTests(unittest.TestCase):
    def settings(self):
        return {'can_admins_bypass':False,'protection_rules':[{'type':'required_reviewers','prevent_self_review':True,
            'reviewers':[{'type':'User','reviewer':{'id':s.REVIEWER_ID}}]}],
            'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}}
    def test_exact_approval_policy(self):
        s.validate(self.settings(),{'branch_policies':[{'name':'main','type':'branch'}]},'main')
    def test_unsafe_approval_settings_denied(self):
        changes=[lambda v:v.update(can_admins_bypass=True),lambda v:v.update(protection_rules=[]),
            lambda v:v['protection_rules'][0].update(prevent_self_review=False),
            lambda v:v['protection_rules'][0]['reviewers'][0]['reviewer'].update(id=1),
            lambda v:v['protection_rules'][0]['reviewers'][0].update(type='Team'),
            lambda v:v.update(deployment_branch_policy={'protected_branches':True,'custom_branch_policies':False})]
        for change in changes:
            value=copy.deepcopy(self.settings());change(value)
            with self.assertRaises(s.SetupError):s.validate(value,{'branch_policies':[{'name':'main'}]},'main')
    def test_tags_wildcards_and_extra_branches_denied(self):
        for rules in [[{'name':'main','type':'tag'}],[{'name':'*','type':'branch'}],
                      [{'name':'main'},{'name':'dev'}],[]]:
            with self.assertRaises(s.SetupError):s.validate(self.settings(),{'branch_policies':rules},'main')
    def test_missing_admin_blocks_before_any_write(self):
        writes=[]
        def api(path,method='GET',body=None):
            if method!='GET':writes.append(path)
            if path.startswith('users/'):return {'id':s.REVIEWER_ID}
            name=path.split('/')[-1]
            return {'id':s.TARGETS[name][0],'owner':{'id':182018869},'permissions':{'admin':False}}
        with self.assertRaisesRegex(s.SetupError,'REPOSITORY_ADMIN_REQUIRED'):s.run(api,True)
        self.assertEqual(writes,[])

    def test_automatic_policy_requires_exact_branch_without_reviewer_gate(self):
        settings={'can_admins_bypass':False,'protection_rules':[],
            'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True}}
        branches={'branch_policies':[{'name':'main','type':'branch'}]}
        s.validate(settings,branches,'main','automatic')
        for change in [lambda v:v.update(can_admins_bypass=True),
                       lambda v:v.update(protection_rules=[{'type':'required_reviewers'}]),
                       lambda v:v.update(protection_rules=[{'type':'wait_timer'}])]:
            value=copy.deepcopy(settings);change(value)
            with self.assertRaises(s.SetupError):s.validate(value,branches,'main','automatic')
        with self.assertRaises(s.SetupError):s.validate(settings,branches,'main','invalid')

    def test_automatic_configuration_still_requires_admin_before_writes(self):
        writes=[]
        def api(path,method='GET',body=None):
            if method!='GET':writes.append(path)
            name=path.split('/')[-1]
            return {'id':s.TARGETS[name][0],'owner':{'id':182018869},'permissions':{'admin':False}}
        with self.assertRaisesRegex(s.SetupError,'REPOSITORY_ADMIN_REQUIRED'):s.run(api,True,'automatic')
        self.assertEqual(writes,[])

if __name__=='__main__':unittest.main()
