"""Production turns on four staff features that are built and off by default.

The names, values and defaults are the ones the services parse (hid-system
staging-novu-ci-20261005; identity-api at 4c843270, ehr-api, lab-api and
pharmacy-api at 06f98040, each in src/config/environment.ts):

  identity-api  STAFF_FACILITY_SELECTION_MODE            off | keep | ask, default off (0129)
  lab-api       OWN_WORK_PATIENT_CARD_ENABLED           true | false, default false (0124, 0133 D4)
  pharmacy-api  OWN_WORK_PATIENT_CARD_ENABLED           true | false, default false
  ehr-api       PRESCRIPTION_DISPENSING_DETAILS_ENABLED true | false, default false (0125)
  pharmacy-api  PRESCRIPTION_DISPENSING_DETAILS_ENABLED true | false, default false
  identity-api  STAFF_OPEN_PATIENT_ENABLED              true | false, default false (SX-8, 0140;
                identity-api at staging 95fa1e52, src/config/environment.ts)

Any other value stops the service at start-up, so Terraform must write only
these spellings. tests/staff-features.tftest.hcl checks the container
environments themselves.
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENVIRONMENTS = ROOT / 'environments'

# Terraform variable -> (production value, the values the service accepts).
PRODUCTION = {
    'staff_facility_selection_mode': ('"keep"', ('"off"', '"keep"', '"ask"')),
    'own_work_patient_card_enabled': ('true', ('true', 'false')),
    'prescription_dispensing_details_enabled': ('true', ('true', 'false')),
    'staff_open_patient_enabled': ('true', ('true', 'false')),
}

# Terraform variable -> (container setting, the services that read it).
WIRING = {
    'staff_facility_selection_mode': ('STAFF_FACILITY_SELECTION_MODE', ('identity-api',)),
    'own_work_patient_card_enabled': ('OWN_WORK_PATIENT_CARD_ENABLED', ('lab-api', 'pharmacy-api')),
    'prescription_dispensing_details_enabled': ('PRESCRIPTION_DISPENSING_DETAILS_ENABLED', ('ehr-api', 'pharmacy-api')),
    'staff_open_patient_enabled': ('STAFF_OPEN_PATIENT_ENABLED', ('identity-api',)),
}


def assignments(text, name):
    return re.findall(rf'(?m)^\s*{re.escape(name)}\s*=\s*(\S+)\s*$', text)


def service_block(workloads, service):
    """The text of one workload's entry in local.workload_environment."""
    start = workloads.index(f'\n    {service} = merge(')
    following = re.compile(r'\n    [a-z-]+ = |\n  }\n').search(workloads, start + 1)
    return workloads[start:following.start()]


class ProductionStaffFeatures(unittest.TestCase):
    def test_production_turns_each_feature_on_once(self):
        text = (ENVIRONMENTS / 'production.tfvars').read_text()
        for name, (value, allowed) in PRODUCTION.items():
            with self.subTest(name=name):
                self.assertEqual(assignments(text, name), [value])
                self.assertIn(value, allowed)

    def test_other_environments_leave_the_defaults(self):
        others = [p for p in sorted(ENVIRONMENTS.glob('*.tfvars*')) if p.name != 'production.tfvars']
        self.assertGreaterEqual(len(others), 3)
        for path in others:
            text = path.read_text()
            for name in PRODUCTION:
                with self.subTest(file=path.name, name=name):
                    self.assertEqual(assignments(text, name), [])

    def test_defaults_are_off(self):
        root = (ROOT / 'variables.tf').read_text()
        module = (ROOT / 'modules' / 'application' / 'variables.tf').read_text()
        for text in (root, module):
            for name, default in (('staff_facility_selection_mode', '"off"'),
                                  ('own_work_patient_card_enabled', 'false'),
                                  ('prescription_dispensing_details_enabled', 'false'),
                                  ('staff_open_patient_enabled', 'false')):
                with self.subTest(name=name):
                    block = re.search(rf'variable "{name}" {{(.*?)\n}}', text, re.S)
                    self.assertIsNotNone(block, f'{name} must be declared')
                    self.assertRegex(block.group(1), rf'(?m)^\s*default\s*=\s*{re.escape(default)}\s*$')

    def test_root_module_passes_each_variable_on(self):
        main = (ROOT / 'main.tf').read_text()
        for name in PRODUCTION:
            with self.subTest(name=name):
                self.assertRegex(main, rf'(?m)^\s*{name}\s*=\s*var\.{name}\s*$')

    def test_each_setting_reaches_only_its_services(self):
        workloads = (ROOT / 'modules' / 'application' / 'workloads.tf').read_text()
        local_names = {
            'staff_facility_selection_mode': 'local.staff_facility_selection_environment',
            'own_work_patient_card_enabled': 'local.own_work_patient_card_environment',
            'prescription_dispensing_details_enabled': 'local.prescription_dispensing_details_environment',
            'staff_open_patient_enabled': 'local.staff_open_patient_environment',
        }
        services = ('identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api')
        for name, (setting, readers) in WIRING.items():
            with self.subTest(setting=setting):
                self.assertIn(f'{setting} = ', re.sub(r'\s+=', ' =', workloads))
                for service in services:
                    has = local_names[name] in service_block(workloads, service)
                    self.assertEqual(has, service in readers, f'{setting} on {service}')


if __name__ == '__main__':
    unittest.main()
