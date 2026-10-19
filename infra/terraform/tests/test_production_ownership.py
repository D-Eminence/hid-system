import copy
import importlib.util
from pathlib import Path
import unittest

script = Path(__file__).resolve().parents[1] / "scripts/check-production-ownership.py"
spec = importlib.util.spec_from_file_location("ownership", script)
ownership = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ownership)

class ProductionOwnershipTests(unittest.TestCase):
    lineage = "5059f263-8e0e-126a-40a1-fbc55220a317"
    account = "123456789012"
    def state(self):
        return {"lineage": self.lineage, "resources": [
            {"mode":"managed", "module":"module.data", "type":"aws_db_instance", "name":"main", "instances":[{"attributes":{"identifier":"hid-staging-postgres"}}]},
            {"mode":"managed", "module":"module.application", "type":"aws_ecs_cluster", "name":"main", "instances":[{"attributes":{"arn":"arn:aws:ecs:eu-west-1:123456789012:cluster/hid-staging"}}]},
        ]}
    def test_accepts_only_verified_existing_permanent_stack(self):
        self.assertEqual(ownership.verify_state(self.state(),self.lineage,self.account)["valid"],"true")
    def test_rejects_empty_or_unrelated_state(self):
        for value in [{}, {"lineage":self.lineage,"resources":[]}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                ownership.verify_state(value,self.lineage,self.account)
    def test_rejects_different_lineage(self):
        with self.assertRaisesRegex(ValueError,"LINEAGE"):
            ownership.verify_state(self.state(),"00000000-0000-0000-0000-000000000000",self.account)
    def test_rejects_foreign_account_cluster(self):
        with self.assertRaisesRegex(ValueError,"CLUSTER"):
            ownership.verify_state(self.state(),self.lineage,"999999999999")
    def test_rejects_new_or_wrong_database(self):
        state=self.state();state["resources"][0]["instances"][0]["attributes"]["identifier"]="hid-production-postgres"
        with self.assertRaisesRegex(ValueError,"DATABASE"):
            ownership.verify_state(state,self.lineage,self.account)
    def test_accepts_completed_ecs_move_with_retained_database_and_lineage(self):
        state=self.state()
        state['resources'][1]['instances']=[]
        state['resources'].append({'mode':'managed','module':'module.application','type':'aws_ecs_cluster',
            'name':'production','instances':[{'attributes':{'arn':f'arn:aws:ecs:eu-west-1:{self.account}:cluster/hid-production'}}]})
        self.assertEqual(ownership.verify_state(state,self.lineage,self.account)['valid'],'true')
    def test_rejects_foreign_production_cluster_after_retirement(self):
        state=self.state(); state['resources'][1]['name']='production'
        with self.assertRaisesRegex(ValueError,'CLUSTER'):
            ownership.verify_state(state,self.lineage,self.account)

if __name__ == "__main__":
    unittest.main()
