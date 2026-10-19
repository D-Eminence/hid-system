import unittest
from production_release_compatibility import migration_changes


class CompatibilityTests(unittest.TestCase):
    def test_additive_history_preserves_applied_sql(self):
        old = {"0001_initial.sql": b"create table test(id int);\n"}
        new = {**old, "0002_additive.sql": b"alter table test add column label text;\n"}
        self.assertEqual(migration_changes(old, new),
                         {"removed": [], "modified": [], "added": ["0002_additive.sql"]})

    def test_reused_ordinal_is_not_an_additive_upgrade(self):
        report = migration_changes({"0061_imported_medical_records.sql": b"original"},
                                   {"0061_provider_onboarding.sql": b"different feature"})
        self.assertEqual(report["removed"], ["0061_imported_medical_records.sql"])

    def test_applied_file_modification_is_detected(self):
        self.assertEqual(migration_changes({"0001_initial.sql": b"original"},
                                          {"0001_initial.sql": b"replacement"})["modified"],
                         ["0001_initial.sql"])


if __name__ == "__main__":
    unittest.main()
