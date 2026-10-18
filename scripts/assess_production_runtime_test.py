import copy
import datetime
import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('production_assessment',pathlib.Path(__file__).with_name('assess-production-runtime.py'))
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)

class ProductionAssessmentTests(unittest.TestCase):
    def inputs(self):
        source='a'*40;component='notification-worker';image='hid-ci/'+component+':'+source
        now=datetime.datetime.now(datetime.timezone.utc)
        policy={'schema':'hid.production-runtime-assessment-policy/v1',
                'assessed_at':(now-datetime.timedelta(hours=1)).isoformat(),
                'expires_at':(now+datetime.timedelta(days=7)).isoformat(),
                'elf_inventory':{component:{'nodejs/bin/node':'reviewed-native-hash'}}}
        scan={'descriptor':{'version':'0.120.0'},'matches':[],
              'distro':{'name':'debian','version':'13'},'source':{'target':{'userInput':image}}}
        metadata={'Os':'linux','Architecture':'arm64','Id':'sha256:'+'b'*64,
                  'Config':{'Labels':{'org.opencontainers.image.revision':source}}}
        return [component,image,scan,metadata,policy,source]

    def test_exact_inputs_pass(self):a.validate_inputs(*self.inputs())

    def test_drift_denied(self):
        changes=[(0,'ehr-api'),(1,'hid-ci/notification-worker:'+'c'*40),(5,'c'*40)]
        for index,value in changes:
            with self.subTest(index=index):
                args=self.inputs();args[index]=value
                with self.assertRaises(RuntimeError):a.validate_inputs(*args)
        mutations=[lambda p:p[3].update(Architecture='amd64'),lambda p:p[3].update(Os='windows'),
                   lambda p:p[3].update(Id='mutable-image-tag'),
                   lambda p:p[3]['Config']['Labels'].update({'org.opencontainers.image.revision':'d'*40}),
                   lambda p:p[2]['source']['target'].update(userInput='hid-ci/foreign:other'),
                   lambda p:p[2]['distro'].update(version='12'),lambda p:p[2]['distro'].update(name='alpine'),
                   lambda p:p[2].pop('matches'),lambda p:p[2]['descriptor'].pop('version'),
                   lambda p:p[2].update(ignoredMatches=[{'vulnerability':{'severity':'High'}}]),
                   lambda p:p[4].update(schema='hid.staging-runtime-assessment-policy/v1'),
                   lambda p:p[4].update(expires_at='2020-01-01T00:00:00+00:00'),
                   lambda p:p[4].update(expires_at='2099-01-01T00:00:00+00:00'),
                   lambda p:p[4].update(assessed_at='2099-01-01T00:00:00+00:00')]
        for index,mutate in enumerate(mutations):
            with self.subTest(mutation=index):
                args=copy.deepcopy(self.inputs());mutate(args)
                with self.assertRaises(RuntimeError):a.validate_inputs(*args)

if __name__=='__main__':unittest.main()
