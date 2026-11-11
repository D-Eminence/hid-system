"""The support FAQ catalogue, the tfvars that publish it, and the answers the owner tested."""
import json
import pathlib
import re
import unittest
import urllib.parse

import support_faq_catalog as catalog

TERRAFORM = pathlib.Path(__file__).resolve().parents[1]
# The pages each answer may link to (health repo: apps/patient-web App.tsx, productHostname.ts; public-web site.ts).
PATIENT_PATHS = {'/enroll', '/sign-in', '/recover', '/profile', '/access', '/records'}
STAFF_PATHS = {'', '/provider/sign-in', '/provider/recover', '/provider/invitation', '/provider/enroll'}
PUBLIC_PATHS = {'/about', '/contact', '/resources/privacy', '/provider/apply'}
STAFF_SITES = ('ehr', 'lab', 'pharmacy', 'migrate', 'outreach')


def tfvars_faqs(env):
    """The support_faqs block of an environment's tfvars, read line by line (its strings are JSON strings)."""
    text = (TERRAFORM / f'environments/{env}.tfvars').read_text(encoding='utf-8')
    block = re.search(r'^support_faqs = \{\n(.*?)^\}\n', text, re.S | re.M).group(1)
    faqs, name = {}, None
    for line in block.splitlines():
        if m := re.fullmatch(r'  ([A-Za-z0-9_]+) = \{', line):
            name = m.group(1)
            faqs[name] = {}
        elif m := re.fullmatch(r'    utterances = (\[.*\])', line):
            faqs[name]['utterances'] = json.loads(m.group(1))
        elif m := re.fullmatch(r'    answer     = (".*")', line):
            faqs[name]['answer'] = json.loads(m.group(1))
    return faqs


class CatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = catalog.load_catalog()
        cls.faqs = cls.data['faqs']

    def test_tfvars_publish_exactly_the_catalogue(self):
        for env in ('staging', 'production'):
            self.assertEqual(tfvars_faqs(env), catalog.lex_faqs(self.data), env)

    def test_owner_questions_reach_the_right_answer(self):
        # Lex matches without regard to case; the owner's own words are sample questions of the right intent.
        for question, intent in (('HOW DO I RESET MY PASSWORD', 'PasswordRecovery'),
                                 ('HOW I DO I SIGNUP AS DOCTOR', 'StaffAccount'),
                                 ('SIGNUP NOT SIGNIN', 'SignUp')):
            self.assertIn(question, self.faqs[intent]['utterances'])

    def test_password_answers_name_the_staff_and_patient_pages(self):
        ehr = 'https://ehr.staging.healthidentitydirectory.com'
        generic = self.faqs['PasswordRecovery']['answer']
        self.assertIn(ehr + '/provider/recover', generic)
        self.assertIn('https://staging.healthidentitydirectory.com/recover', generic)
        staff = self.faqs['StaffPasswordReset']['answer']
        for site in STAFF_SITES:
            self.assertIn(f'https://{site}.staging.healthidentitydirectory.com/provider/recover', staff)
        self.assertNotIn('https://staging.healthidentitydirectory.com/recover', staff)

    def test_sign_up_answers_explain_invitation_and_facility_set_up(self):
        for intent in ('SignUp', 'StaffAccount'):
            answer = self.faqs[intent]['answer']
            self.assertIn('invit', answer)
            self.assertIn('Set up your facility', answer)
            self.assertIn('/provider/enroll', answer)
        self.assertIn('https://staging.healthidentitydirectory.com/enroll', self.faqs['SignUp']['answer'])

    def test_links_are_real_pages_on_approved_hosts(self):
        for name, faq in self.faqs.items():
            for url in re.findall(r'https://[^\s,;)]+', faq['answer']):
                url = url.rstrip('.')
                parsed = urllib.parse.urlsplit(url)
                self.assertIn(parsed.hostname, catalog.ALLOWED_HOSTS, (name, url))
                path = parsed.path.rstrip('/') if parsed.path != '/' else ''
                host = parsed.hostname.split('.')[0]
                allowed = (PATIENT_PATHS | {''} if host == 'staging' else PUBLIC_PATHS | {''} if host == 'www'
                           else STAFF_PATHS)
                self.assertIn(path, allowed, (name, url))

    def test_no_answer_asks_for_personal_or_clinical_details(self):
        asks = re.compile(r'\b(send|tell|give|enter|type|share|provide)\s+(me|us)\b|\bwhat is your\b'
                          r'|\b(reply|respond) with\b', re.I)
        for name, faq in self.faqs.items():
            self.assertIsNone(asks.search(faq['answer']), name)
        for name in ('ShareRecords', 'PatientAccessPin', 'StaffInvitation', 'TwoStepVerification',
                     'VerificationCode', 'PasswordRecovery'):
            self.assertRegex(self.faqs[name]['answer'], r'(?i)never|do not', name)

    def test_utterances_are_unique_across_intents(self):
        seen = {}
        for name, faq in self.faqs.items():
            for utterance in faq['utterances']:
                key = re.sub(r'[^a-z0-9 ]', '', utterance.lower()).strip()
                self.assertNotIn(key, seen, (name, utterance, seen.get(key)))
                seen[key] = name


if __name__ == '__main__':
    unittest.main()
