"""Load the public FAQ catalogue; no credentials or network access."""
import json
import pathlib
import re
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[3]
CATALOG = ROOT / 'infra/terraform/support/health-id-faqs.json'
ALLOWED_HOSTS = {
    'staging.healthidentitydirectory.com',
    'www.staging.healthidentitydirectory.com',
    'migrate.staging.healthidentitydirectory.com',
}


def load_catalog(path=CATALOG):
    data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    if (data.get('schema') != 'hid.support-faq/v1' or data.get('environment') != 'staging'
            or data.get('support_contact') != 'mailto:support@healthidentitydirectory.com'):
        raise ValueError('EXACT_STAGING_FAQ_CATALOG_REQUIRED')
    faqs = data['faqs']
    if not isinstance(faqs, dict) or not 1 <= len(faqs) <= 40:
        raise ValueError('INVALID_FAQ_COUNT')
    seen = set()
    for name, faq in faqs.items():
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{1,49}', name) or name in ('Fallback', 'FallbackIntent'):
            raise ValueError('INVALID_FAQ_NAME')
        utterances = faq['utterances']
        if not isinstance(utterances, list) or not 2 <= len(utterances) <= 10:
            raise ValueError('INVALID_FAQ_UTTERANCES')
        for utterance in utterances:
            if not isinstance(utterance, str) or not 3 <= len(utterance.strip()) <= 200:
                raise ValueError('INVALID_FAQ_UTTERANCE')
            key = re.sub(r'[^a-z0-9 ]', '', utterance.lower()).strip()
            if key in seen:
                raise ValueError('DUPLICATE_FAQ_UTTERANCE')
            seen.add(key)
        if not isinstance(faq['answer'], str) or not 10 <= len(faq['answer'].strip()) <= 1000:
            raise ValueError('INVALID_FAQ_ANSWER')
        if not faq.get('source') or not faq.get('question'):
            raise ValueError('FAQ_EVIDENCE_REQUIRED')
        url = faq.get('action_url')
        if url:
            parsed = urllib.parse.urlsplit(url)
            if url != data['support_contact'] and (parsed.scheme != 'https'
                    or parsed.hostname not in ALLOWED_HOSTS or parsed.netloc != parsed.hostname
                    or parsed.query or parsed.fragment):
                raise ValueError('UNAPPROVED_FAQ_ACTION')
            if url not in faq['answer']:
                raise ValueError('FAQ_ACTION_MISSING_FROM_ANSWER')
    return data


def lex_faqs(data):
    return {name: {'utterances': row['utterances'], 'answer': row['answer']}
            for name, row in data['faqs'].items()}
