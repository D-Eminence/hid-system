#!/usr/bin/env python3
"""Generate the FICTIONAL paper-reading launch check set for Health ID.

Every person, number and place written by this script is invented: patient
surnames such as "Example" and "Testperson", facilities such as "Demo
Hospital", folder numbers such as "DH-TEST-0042". Nothing here comes from, or
may ever be replaced by, a real patient record.

    python3 generate.py --seed 20261103 --count 200 --out ./generated

writes, into --out:
  documents/<id>-<kind>.png   single-page documents
  documents/<id>-<kind>.pdf   2-4 page documents
  keys/keys.jsonl             one answer key per document (same seed, same keys)
  keys/manifest.json          sha256 of every generated file

The same seed always gives byte-identical files with the pinned Pillow and
reportlab versions in requirements.txt. Each document depends only on the seed
and its own number, so the first N documents of a 200 set are the same as a
set of N.

  --check-against keys      compare what was generated with the committed keys
                            and manifest; exit 1 if anything differs.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
import random
import sys
import time
from dataclasses import dataclass, field

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
import PIL
import reportlab
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

KIT_VERSION = 'hid-ocr-accuracy-kit-1'
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, 'fonts')
PAGE_W, PAGE_H = 1240, 1754  # A4 at 150 dpi
DPI = 150
MARGIN_X, MARGIN_TOP = 90, 80
FIXED_PDF_DATE = time.gmtime(1793664000)  # 2026-11-03T00:00:00Z: no clock time in any file

FONTS = {
    'sans': 'PT_Sans-Web-Regular.ttf',
    'sans_bold': 'PT_Sans-Web-Bold.ttf',
    'mono': 'CourierPrime-Regular.ttf',
    'mono_bold': 'CourierPrime-Bold.ttf',
    'hand_patrick': 'PatrickHand-Regular.ttf',
    'hand_kalam': 'Kalam-Regular.ttf',
    'hand_indie': 'IndieFlower-Regular.ttf',
}
HAND_FONTS = ['hand_patrick', 'hand_kalam', 'hand_indie']

DIFFICULTIES = ['clean_typed', 'faint_scan', 'skewed_noisy_scan', 'handwritten', 'handwritten_noisy']
DIFFICULTY_WEIGHTS = [30, 15, 20, 20, 15]
DOC_KINDS = ['outpatient_card', 'prescription', 'discharge_summary', 'lab_report', 'referral_letter', 'vitals_chart']
PDF_SHARE = {'outpatient_card': 0.35, 'prescription': 0.25, 'discharge_summary': 0.8, 'lab_report': 0.5,
             'referral_letter': 0.5, 'vitals_chart': 0.5}

# ---------------------------------------------------------------------------------------------------------------
# Fictional people and places. Surnames and facilities are deliberately obvious test names.
FIRST_NAMES_F = ['Adaeze', 'Ngozi', 'Funmilayo', 'Aisha', 'Bola', 'Ifeoma', 'Halima', 'Kemi', 'Zainab', 'Chioma',
                 'Amaka', 'Yetunde', 'Hauwa', 'Folake', 'Nkechi', 'Bisola']
FIRST_NAMES_M = ['Chinedu', 'Emeka', 'Tunde', 'Musa', 'Yusuf', 'Segun', 'Obinna', 'Ibrahim', 'Kunle', 'Uche',
                 'Bello', 'Femi', 'Ikenna', 'Sani', 'Dayo', 'Chukwudi']
SURNAMES = ['Example', 'Testperson', 'Sample', 'Demo', 'Placeholder', 'Fakename', 'Notreal', 'Mockpatient',
            'Testcase', 'Specimen']
PRESCRIBERS = ['Dr T. Testdoctor', 'Dr A. Sampleprescriber', 'Dr O. Exampledoc', 'Dr F. Demophysician',
               'Dr K. Notrealdoc', 'Dr B. Testclinician']
NURSES = ['Nurse B. Example', 'Nurse C. Testnurse', 'Nurse D. Samplecarer']
FACILITIES = [
    ('DEMO HOSPITAL', '12 Sample Road, Testville (fictional)', 'DH'),
    ('DEMO GENERAL HOSPITAL', '1 Example Close, Sampletown (fictional)', 'DGH'),
    ('EXAMPLE MEDICAL CENTRE', '7 Placeholder Street, Testville (fictional)', 'EMC'),
    ('SAMPLE PRIMARY HEALTH CENTRE', 'Ward 3, Demo LGA (fictional)', 'SPHC'),
    ('TESTVILLE COTTAGE HOSPITAL', '22 Mock Avenue, Testville (fictional)', 'TCH'),
]
REFERRAL_TARGETS = ['Demo Teaching Hospital', 'Example Specialist Hospital', 'Sample Federal Medical Centre']
FOOTER = 'FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT'

# ---------------------------------------------------------------------------------------------------------------
# Medicines (Nigerian Essential Medicines List). (name, strength, form, route, frequency, duration)
# route None = not written; duration None = not written.
MEDS = {
    'al': ('Artemether/Lumefantrine', '80/480mg', 'Tab', None, 'bd', 'x3/7'),
    'pcm': ('Paracetamol', '1g', 'Tab', None, 'tds', 'x3/7'),
    'pcm500': ('Paracetamol', '500mg', 'Tab', 'po', 'qds', 'x5/7'),
    'amox': ('Amoxicillin', '500mg', 'Cap', None, 'tds', 'x5/7'),
    'augm': ('Amoxicillin-clavulanate', '625mg', 'Tab', None, 'bd', 'x7/7'),
    'cipro': ('Ciprofloxacin', '500mg', 'Tab', 'po', 'bd', 'x7/7'),
    'metro': ('Metronidazole', '400mg', 'Tab', None, 'tds', 'x5/7'),
    'amlo5': ('Amlodipine', '5mg', 'Tab', None, 'od', None),
    'amlo10': ('Amlodipine', '10mg', 'Tab', None, 'od', None),
    'lisi': ('Lisinopril', '10mg', 'Tab', None, 'od', None),
    'losar': ('Losartan', '50mg', 'Tab', None, 'od', None),
    'hctz': ('Hydrochlorothiazide', '25mg', 'Tab', None, 'od', None),
    'nifed': ('Nifedipine', '20mg', 'Tab', None, 'bd', None),
    'mdopa': ('Methyldopa', '250mg', 'Tab', None, 'tds', None),
    'hydral': ('Hydralazine', '25mg', 'Tab', None, 'bd', None),
    'hydrox': ('Hydroxyzine', '25mg', 'Tab', None, 'nocte', 'x5/7'),
    'metf': ('Metformin', '500mg', 'Tab', None, 'bd', None),
    'metf1g': ('Metformin', '1g', 'Tab', None, 'bd', None),
    'glib': ('Glibenclamide', '5mg', 'Tab', None, 'od', None),
    'omep': ('Omeprazole', '20mg', 'Cap', None, 'bd', 'x14/7'),
    'magt': ('Magnesium trisilicate', '10ml', 'Mist', None, 'tds', None),
    'ibu': ('Ibuprofen', '400mg', 'Tab', None, 'tds', None),
    'diclo': ('Diclofenac', '50mg', 'Tab', None, 'bd', 'x5/7'),
    'cpm': ('Chlorpheniramine', '4mg', 'Tab', None, 'tds', 'x5/7'),
    'lora': ('Loratadine', '10mg', 'Tab', None, 'od', 'x5/7'),
    'folic': ('Folic acid', '5mg', 'Tab', None, 'od', None),
    'fes': ('Ferrous sulphate', '200mg', 'Tab', None, 'tds', None),
    'vitb': ('Vitamin B complex', '2 tabs', 'Tab', None, 'tds', None),
    'cotri': ('Cotrimoxazole', '960mg', 'Tab', None, 'bd', 'x5/7'),
    'azith': ('Azithromycin', '500mg', 'Tab', None, 'od', 'x3/7'),
    'ceftr': ('Ceftriaxone', '1g', 'Inj', 'IV', 'od', 'x5/7'),
    'artes': ('Artesunate', '120mg', 'Inj', 'IV', 'stat', None),
    'salb': ('Salbutamol', '100mcg', 'Inh', None, 'prn', None),
    'pred40': ('Prednisolone', '40mg', 'Tab', None, 'od', 'x5/7'),
    'pred5': ('Prednisolone', '5mg', 'Tab', None, 'od', None),
    'aten': ('Atenolol', '50mg', 'Tab', None, 'od', None),
    'cbz': ('Carbamazepine', '200mg', 'Tab', None, 'bd', None),
    'cbm': ('Carbimazole', '5mg', 'Tab', None, 'tds', None),
    'cpz': ('Chlorpromazine', '100mg', 'Tab', None, 'nocte', None),
    'cpp': ('Chlorpropamide', '250mg', 'Tab', None, 'od', None),
    'albe': ('Albendazole', '400mg', 'Tab', None, 'stat', None),
    'zinc': ('Zinc', '20mg', 'Tab', None, 'od', 'x10/7'),
    'nitro': ('Nitrofurantoin', '100mg', 'Cap', None, 'bd', 'x5/7'),
    'diaz': ('Diazepam', '5mg', 'Tab', None, 'nocte', 'x3/7'),
    'genta': ('Gentamicin', '80mg', 'Inj', 'IM', 'bd', 'x5/7'),
}

# Conditions: (diagnosis name as written, medicines, labs, complaint)
CONDITIONS = {
    'malaria': (['Malaria', 'Uncomplicated malaria'], ['al', 'pcm'], ['mp', 'mrdt'], 'fever, headache x3/7'),
    'typhoid': (['Typhoid fever', 'Enteric fever'], ['cipro', 'pcm500'], ['widal', 'fbc'], 'fever x7/7, abdominal pain'),
    'htn': (['HTN', 'Hypertension'], ['amlo5', 'lisi', 'losar', 'hctz', 'amlo10', 'nifed'], ['eucr'], 'headache, dizziness'),
    't2dm': (['T2DM', 'Type 2 diabetes mellitus'], ['metf', 'glib', 'metf1g'], ['fbs', 'eucr'], 'polyuria, polydipsia'),
    'urti': (['URTI'], ['amox', 'cpm', 'lora'], [], 'cough, catarrh x4/7'),
    'pud': (['PUD', 'Peptic ulcer disease'], ['omep', 'magt'], ['pcv'], 'epigastric pain x2/52'),
    'gastro': (['Acute gastroenteritis'], ['metro', 'zinc'], ['eucr'], 'diarrhoea, vomiting x2/7'),
    'uti': (['UTI'], ['nitro', 'cipro'], ['fbc'], 'dysuria, frequency x3/7'),
    'anaemia': (['Anaemia'], ['fes', 'folic', 'vitb'], ['pcv', 'fbc'], 'easy fatigability'),
    'asthma': (['Bronchial asthma'], ['salb', 'pred40'], [], 'wheeze, breathlessness'),
    'pneumonia': (['Community acquired pneumonia', 'Pneumonia'], ['augm', 'azith', 'ceftr'], ['fbc'], 'cough, fever x5/7'),
    'oa': (['Osteoarthritis'], ['diclo', 'ibu'], [], 'knee pain'),
    'pruritus': (['Allergic dermatitis'], ['hydrox', 'lora'], [], 'itchy rash x1/52'),
    'worms': (['Intestinal helminthiasis'], ['albe'], [], 'abdominal discomfort'),
}

LOOKALIKE_PAIRS = [('hydrox', 'hydral'), ('cpz', 'cpp'), ('cbz', 'cbm')]
STRENGTH_PAIRS = [('amlo5', 'losar'), ('glib', 'diclo'), ('pred5', 'aten'), ('folic', 'aten')]
SIG_VARIANTS = {'od': ['od', 'od', 'daily', 'OD'], 'bd': ['bd', 'bd', 'b.d.', 'BD', '12hrly'],
                'tds': ['tds', 'tds', 'tid', 'TDS', '8hrly'], 'qds': ['qds', 'qid'],
                'nocte': ['nocte', 'nocte'], 'stat': ['stat', 'STAT'], 'prn': ['prn', 'PRN']}

ALLERGIES = [
    # (asWritten, substance, reaction, severity, nka)
    ('Allergies: NKDA', None, None, None, True),
    ('Allergies: NKDA', None, None, None, True),
    ('Drug allergy: Nil known', None, None, None, True),
    ('Allergy: Penicillin (rash)', 'Penicillin', 'rash', None, False),
    ('Allergy: Sulphonamides - severe rash', 'Sulphonamides', 'severe rash', 'severe', False),
    ('Allergic to Aspirin - anaphylaxis', 'Aspirin', 'anaphylaxis', 'severe', False),
    ('Allergy: Chloroquine - itching (mild)', 'Chloroquine', 'itching', 'mild', False),
    ('Allergy: Ibuprofen - facial swelling', 'Ibuprofen', 'facial swelling', None, False),
]


@dataclass
class Line:
    text: str
    role: str = 'body'  # title, heading, body, small, hand
    indent: int = 0
    gap: int = 0
    box: dict | None = None


@dataclass
class Page:
    number: int
    lines: list = field(default_factory=list)
    items: list = field(default_factory=list)

    def add(self, text, role='body', indent=0, gap=0) -> int:
        self.lines.append(Line(text, role, indent, gap))
        return len(self.lines)

    def item(self, kind, as_written, line_no, fields, prescription=None, trap=None):
        text = self.lines[line_no - 1].text
        if as_written not in text:
            raise AssertionError(f'asWritten not on its line: {as_written!r} / {text!r}')
        self.items.append({'kind': kind, 'asWritten': as_written, 'page': self.number, 'lines': [line_no],
                           'fields': fields, 'prescription': prescription, 'trap': trap})


class Doc:
    """Context for one document: its random stream, people, dates and style."""

    def __init__(self, rng: random.Random, kind: str, difficulty: str, n_pages: int):
        self.rng = rng
        self.kind = kind
        self.difficulty = difficulty
        self.n_pages = n_pages
        self.hand = difficulty.startswith('handwritten')
        self.body_role = 'hand' if self.hand else 'body'
        female = rng.random() < 0.55
        first = rng.choice(FIRST_NAMES_F if female else FIRST_NAMES_M)
        self.surname = rng.choice(SURNAMES)
        self.first = first
        self.sex = rng.choice(['F', 'Female']) if female else rng.choice(['M', 'Male'])
        fac = rng.choice(FACILITIES)
        self.facility, self.address, prefix = fac
        self.folder = f'{prefix}-TEST-{rng.randint(1, 9999):04d}'
        year = rng.randint(1948, 2016)
        self.dob = f'{rng.randint(1, 28):02d}/{rng.randint(1, 12):02d}/{year}'
        self.use_age = rng.random() < 0.3
        self.age = f'{2026 - year}yrs'
        self.prescriber = rng.choice(PRESCRIBERS)
        self.nurse = rng.choice(NURSES)
        self.day = rng.randint(1, 20)
        self.month = rng.randint(1, 10)
        self.traps: list[str] = []
        self.name_written = (f'{self.surname.upper()}, {first}' if rng.random() < 0.3 else f'{first} {self.surname}')
        self.identity = None

    def date(self, offset=0):
        day = self.day + offset
        month = self.month + (day - 1) // 28
        day = (day - 1) % 28 + 1
        style = self.rng.random()
        if style < 0.6:
            return f'{day:02d}/{month:02d}/2026'
        if style < 0.85:
            return f'{day}/{month}/26'
        return f'{day:02d}-{month:02d}-2026'


# ---------------------------------------------------------------------------------------------------------------
# Writing helpers: each writes lines and records the matching key items.

def letterhead(doc: Doc, page: Page, title: str):
    page.add(doc.facility, 'title')
    page.add(doc.address, 'small')
    if page.number == 1:
        page.add('Tel: 0700 000 0000 (test line)', 'small')
    page.add(title if page.number == 1 else f'{title} (continued) - page {page.number} of {doc.n_pages}', 'heading', gap=8)


def identity_block(doc: Doc, page: Page):
    n1 = page.add(f'Name: {doc.name_written}   Sex: {doc.sex}', doc.body_role, gap=6)
    dob = doc.age if doc.use_age else doc.dob
    label = 'Age' if doc.use_age else 'DOB'
    n2 = page.add(f'Folder No: {doc.folder}   {label}: {dob}', doc.body_role)
    if doc.identity is None:
        doc.identity = {'nameAsWritten': doc.name_written, 'dateOfBirthAsWritten': dob,
                        'folderNumberAsWritten': doc.folder, 'sexAsWritten': doc.sex, 'page': page.number,
                        'lines': [n1, n2]}


def continuation_identity(doc: Doc, page: Page):
    page.add(f'Name: {doc.name_written}   Folder No: {doc.folder}', 'small')


def sig(doc: Doc, freq: str) -> str:
    return doc.rng.choice(SIG_VARIANTS.get(freq, [freq]))


def medicine_text(doc: Doc, key: str, numbered: int | None = None, status_word: str | None = None):
    name, strength, form, route, freq, duration = MEDS[key]
    rng = doc.rng
    strength_w = strength
    if rng.random() < 0.3 and strength[-1].isalpha() and strength[0].isdigit() and '/' not in strength \
            and ' ' not in strength:
        num = strength.rstrip('abcdefghijklmnopqrstuvwxyz')
        strength_w = f'{num} {strength[len(num):]}'
    freq_w = sig(doc, freq)
    parts = []
    use_form = rng.random() < 0.75 or form in ('Inj', 'Inh', 'Mist')
    if use_form:
        parts.append(form + ('.' if form == 'Mist' else ''))
    parts.append(name)
    parts.append(strength_w)
    if key == 'salb':
        parts.append('2 puffs')
    if route:
        parts.append(route)
    elif rng.random() < 0.15 and form in ('Tab', 'Cap'):
        route = 'po'
        parts.append('po')
    parts.append(freq_w)
    if duration and rng.random() < 0.85:
        parts.append(duration)
    else:
        duration = None
    as_written = ' '.join(parts)
    if status_word:
        as_written = f'{as_written} ({status_word})'
    text = f'{numbered}. {as_written}' if numbered is not None else as_written
    fields = {'name': name, 'strength': strength_w, 'form': (form + '.') if (use_form and form == 'Mist') else
              (form if use_form else None), 'route': route, 'frequency': freq_w, 'duration': duration}
    return text, as_written, fields


def write_medicine(doc: Doc, page: Page, key: str, status: str, numbered=None, status_word=None,
                   prescription=None, trap=None, indent=1):
    text, as_written, fields = medicine_text(doc, key, numbered, status_word)
    n = page.add(text, doc.body_role, indent=indent)
    page.item('medicine', as_written, n, {**fields, 'status': status}, prescription=prescription, trap=trap)


def write_two_medicines(doc: Doc, page: Page, k1: str, k2: str, status: str, trap=None):
    t1, a1, f1 = medicine_text(doc, k1)
    t2, a2, f2 = medicine_text(doc, k2)
    n = page.add(f'{t1}, {t2}', doc.body_role, indent=1)
    page.item('medicine', a1, n, {**f1, 'status': status}, trap=trap)
    page.item('medicine', a2, n, {**f2, 'status': status}, trap=trap)


def write_diagnosis(doc: Doc, page: Page, name: str, status: str, label='Dx:', trap=None):
    templates = {
        'confirmed': [f'{label} {name}'],
        'suspected': [f'?{name}', f'Query {name.lower() if name.isupper() is False else name}'],
        'ruled_out': [f'No evidence of {name}'],
        'history': [f'PMH: {name}', f'Past history of {name}'],
        'family_history': [f'FHx {name}'],
    }
    text = doc.rng.choice(templates[status])
    if status == 'suspected' and text.startswith('Query '):
        name = text[len('Query '):]
    as_written = text[len(label) + 1:] if status == 'confirmed' else text
    n = page.add(text, doc.body_role, indent=0 if status == 'confirmed' else 1)
    page.item('diagnosis', as_written, n, {'name': name, 'status': status}, trap=trap)


def write_allergy(doc: Doc, page: Page):
    as_written, substance, reaction, severity, nka = doc.rng.choice(ALLERGIES)
    n = page.add(as_written, doc.body_role)
    page.item('allergy', as_written, n, {'substance': substance, 'reaction': reaction, 'severity': severity,
                                         'noKnownAllergies': nka})


def write_note(doc: Doc, page: Page, text: str, label: str | None = None, indent=0):
    line = f'{label} {text}' if label else text
    n = page.add(line, doc.body_role, indent=indent)
    page.item('note', text, n, {'text': text})


VITALS = {
    'blood_pressure': lambda r: (f'{r.randint(100, 170)}/{r.randint(60, 105)}', 'mmHg', ['BP', 'BP:']),
    'pulse': lambda r: (str(r.randint(60, 118)), 'b/min', ['Pulse:', 'PR', 'P']),
    'temperature': lambda r: (f'{r.randint(361, 395) / 10:.1f}', '°C', ['Temp:', 'T']),
    'respiratory_rate': lambda r: (str(r.randint(14, 30)), 'c/min', ['RR:', 'RR']),
    'oxygen_saturation': lambda r: (str(r.randint(90, 100)), '%', ['SpO2:', 'SpO2']),
    'weight': lambda r: (str(r.randint(48, 105)), 'kg', ['Wt:', 'Weight:']),
}


def vital_span(doc: Doc, measure: str, with_unit: bool):
    value, unit, labels = VITALS[measure](doc.rng)
    label = doc.rng.choice(labels)
    if with_unit:
        sep = '' if unit in ('%', '°C', 'kg') else ' '
        span = f'{label} {value}{sep}{unit}'
    else:
        span = f'{label} {value}'
        unit = None
    return span, {'measure': measure, 'value': value, 'unit': unit}


def write_vitals_line(doc: Doc, page: Page, measures: list[str], prefix: str = '', with_units=None):
    spans = []
    for measure in measures:
        units = with_units if with_units is not None else doc.rng.random() < 0.6
        spans.append(vital_span(doc, measure, units))
    text = prefix + '   '.join(span for span, _ in spans)
    n = page.add(text, doc.body_role, indent=1 if not prefix else 0)
    for span, fields in spans:
        page.item('vital', span, n, fields)


LABS = {
    'mp': [lambda r: ('MP', r.choice(['Positive (++)', 'Positive (+)', 'Not seen']), None, None, None)],
    'mrdt': [lambda r: ('mRDT', r.choice(['Positive', 'Negative']), None, None, None)],
    'widal': [lambda r: ('Widal S. typhi O', r.choice(['1/80', '1/160', '1/320']), None, None, None),
              lambda r: ('Widal S. typhi H', r.choice(['1/40', '1/80', '1/160']), None, None, None)],
    'pcv': [lambda r: _num_lab(r, 'PCV', 22, 45, 0, '%', '36-46', 36, 46)],
    'fbc': [lambda r: _num_lab(r, 'WBC', 30, 160, 1, 'x10^9/L', '4.0-11.0', 4.0, 11.0, scale=10),
            lambda r: _num_lab(r, 'Hb', 75, 160, 1, 'g/dL', '12.0-16.0', 12.0, 16.0, scale=10),
            lambda r: _num_lab(r, 'Platelets', 90, 420, 0, 'x10^9/L', '150-400', 150, 400)],
    'eucr': [lambda r: _num_lab(r, 'Na+', 128, 148, 0, 'mmol/L', '135-145', 135, 145),
             lambda r: _num_lab(r, 'K+', 30, 58, 1, 'mmol/L', '3.5-5.0', 3.5, 5.0, scale=10),
             lambda r: _num_lab(r, 'Urea', 20, 140, 1, 'mmol/L', '2.5-7.1', 2.5, 7.1, scale=10),
             lambda r: _num_lab(r, 'Creatinine', 55, 190, 0, 'umol/L', '60-110', 60, 110)],
    'fbs': [lambda r: _num_lab(r, 'FBS', 42, 160, 1, 'mmol/L', '3.9-5.6', 3.9, 5.6, scale=10)],
}


def _num_lab(r, test, lo, hi, dp, unit, ref, ref_lo, ref_hi, scale=1):
    raw = r.randint(lo, hi) / scale
    value = f'{raw:.{dp}f}'
    flag = 'H' if raw > ref_hi else ('L' if raw < ref_lo else None)
    return test, value, unit, ref, flag


def write_lab(doc: Doc, page: Page, panel: str):
    for maker in LABS[panel]:
        test, value, unit, ref, flag = maker(doc.rng)
        if unit:
            sep = '' if unit == '%' else ' '
            text = f'{test}: {value}{sep}{unit} ({ref})' + (f' {flag}' if flag else '')
        else:
            text = f'{test}: {value}'
        n = page.add(text, doc.body_role, indent=1)
        page.item('lab_result', text, n, {'test': test, 'value': value, 'unit': unit,
                                          'referenceRange': ref, 'flag': flag})


# ---------------------------------------------------------------------------------------------------------------
# Clinical content: conditions with traps.

def pick_conditions(doc: Doc, count=1):
    return doc.rng.sample(sorted(CONDITIONS), count)


def med_plan(doc: Doc, cond: str, limit=3):
    meds = list(CONDITIONS[cond][1])
    doc.rng.shuffle(meds)
    return meds[:doc.rng.randint(1, min(limit, len(meds)))]


def trap_meds(doc: Doc):
    """Lookalike or strength traps: two medicines that are easy to confuse, on the same page."""
    r = doc.rng.random()
    if r < 0.18:
        pair = doc.rng.choice(LOOKALIKE_PAIRS)
        doc.traps.append('lookalike')
        return list(pair), f'lookalike:{MEDS[pair[0]][0].lower()}/{MEDS[pair[1]][0].lower()}'
    if r < 0.36:
        pair = doc.rng.choice(STRENGTH_PAIRS)
        doc.traps.append('strength')
        return list(pair), f'strength:{MEDS[pair[0]][1]}/{MEDS[pair[1]][1]}'
    return [], None


def negations(doc: Doc, page: Page, cond: str):
    """Suspected, ruled out, history and family history diagnoses: none of them is a current diagnosis."""
    r = doc.rng
    if r.random() < 0.45:
        other = r.choice(['Malaria', 'Typhoid', 'PUD', 'UTI', 'Pneumonia'])
        status = r.choice(['suspected', 'ruled_out'])
        if other.lower() not in cond:
            write_diagnosis(doc, page, other, status, trap='negation')
            doc.traps.append('negation')
    if r.random() < 0.3:
        write_diagnosis(doc, page, r.choice(['DM', 'HTN', 'Asthma']), 'family_history', trap='negation')
        doc.traps.append('negation')
    past = r.choice(['PUD', 'TB', 'Asthma'])
    if r.random() < 0.2 and past.lower() not in cond:
        write_diagnosis(doc, page, past, 'history', trap='negation')


def clinic_visit(doc: Doc, page: Page, visit: int):
    r = doc.rng
    page.add(f'Date: {doc.date(visit * 14)}   Clinic: {r.choice(["GOPD", "MOPD", "Medical OPD"])}', doc.body_role, gap=10)
    cond = pick_conditions(doc)[0]
    names, _, labs, complaint = CONDITIONS[cond]
    write_note(doc, page, complaint, label='C/O')
    write_vitals_line(doc, page, r.sample(['blood_pressure', 'pulse', 'temperature'], 2), prefix='O/E: ')
    write_vitals_line(doc, page, r.sample(['respiratory_rate', 'oxygen_saturation', 'weight'], 2))
    if visit == 0:
        write_allergy(doc, page)
    write_diagnosis(doc, page, r.choice(names), 'confirmed')
    negations(doc, page, cond)
    page.add('Rx:', doc.body_role)
    traps, trap = trap_meds(doc)
    for key in traps:
        write_medicine(doc, page, key, 'new', trap=trap)
    planned = [key for key in med_plan(doc, cond) if key not in traps]
    for key in planned:
        write_medicine(doc, page, key, 'new')
    stop = r.choice(['metf', 'amlo5', 'ibu', 'hctz'])
    if r.random() < 0.3 and stop not in traps + planned:
        write_medicine(doc, page, stop, 'stopped', status_word='stopped', trap='negation')
        doc.traps.append('negation')
    write_note(doc, page, r.choice(['Review in 2/52', 'Review in 1/52 with results', 'Return if symptoms persist',
                                    'Counselled on drug adherence']), label='Plan:')
    page.add(f'Signed: {doc.prescriber}', 'small')


def outpatient_card(doc: Doc, page: Page):
    letterhead(doc, page, 'OUTPATIENT CARD')
    if page.number == 1:
        identity_block(doc, page)
    else:
        continuation_identity(doc, page)
    clinic_visit(doc, page, page.number - 1)


def prescription(doc: Doc, page: Page):
    letterhead(doc, page, 'PRESCRIPTION FORM')
    if page.number == 1:
        identity_block(doc, page)
    else:
        continuation_identity(doc, page)
    date = doc.date((page.number - 1) * 30)
    page.add(f'Date: {date}', doc.body_role)
    cond = pick_conditions(doc)[0]
    write_diagnosis(doc, page, doc.rng.choice(CONDITIONS[cond][0]), 'confirmed', label='Diagnosis:')
    if page.number == 1:
        write_allergy(doc, page)
    page.add('Rx', 'heading')
    keys = []
    traps, trap = trap_meds(doc)
    keys += [(k, trap) for k in traps]
    keys += [(k, None) for k in med_plan(doc, cond, limit=3) if k not in traps]
    extra = pick_conditions(doc)[0]
    keys += [(k, None) for k in med_plan(doc, extra, limit=2) if k not in [x for x, _ in keys]]
    rx = {'prescriberAsWritten': doc.prescriber, 'dateAsWritten': date}
    for index, (key, item_trap) in enumerate(keys, start=1):
        write_medicine(doc, page, key, 'new', numbered=index, prescription=rx, trap=item_trap)
    page.add(f'Prescriber: {doc.prescriber}', doc.body_role, gap=12)
    page.add('Pharmacy use only: dispensed ____', 'small')


def discharge_summary(doc: Doc, page: Page):
    r = doc.rng
    letterhead(doc, page, 'DISCHARGE SUMMARY')
    if page.number == 1:
        identity_block(doc, page)
    else:
        continuation_identity(doc, page)
    cond = doc.__dict__.setdefault('main_cond', pick_conditions(doc)[0])
    names, meds, labs, complaint = CONDITIONS[cond]
    sections = discharge_sections(doc)
    for section in sections[page.number - 1]:
        if section == 'admission':
            page.add(f'Admitted: {doc.date(0)}   Discharged: {doc.date(5)}', doc.body_role)
            write_note(doc, page, f'{complaint}', label='Presenting complaint:')
            write_allergy(doc, page)
            write_diagnosis(doc, page, r.choice(names), 'confirmed', label='Final diagnosis:')
            negations(doc, page, cond)
        elif section == 'vitals':
            page.add('Vitals on admission:', 'heading')
            write_vitals_line(doc, page, ['blood_pressure', 'pulse', 'temperature'])
            write_vitals_line(doc, page, ['respiratory_rate', 'oxygen_saturation'])
        elif section == 'treatment':
            page.add('Treatment given:', 'heading')
            for key in (['artes', 'ceftr', 'genta'] if r.random() < 0.5 else ['ceftr', 'artes'])[:2]:
                write_medicine(doc, page, key, 'past')
            write_note(doc, page, r.choice(['IV fluids 0.9% saline 1L 8hrly', 'Transfused 1 unit of blood',
                                            'Tepid sponging for fever']))
        elif section == 'labs':
            page.add('Investigations:', 'heading')
            for panel in (labs or ['pcv'])[:2]:
                write_lab(doc, page, panel)
        elif section == 'discharge_meds':
            page.add('Medications on discharge:', 'heading')
            traps, trap = trap_meds(doc)
            for key in traps:
                write_medicine(doc, page, key, 'new', trap=trap)
            planned = [key for key in med_plan(doc, cond) if key not in traps]
            for key in planned:
                write_medicine(doc, page, key, 'new')
            stop = r.choice(['ibu', 'diclo', 'metf'])
            if r.random() < 0.4 and stop not in traps + planned:
                write_medicine(doc, page, stop, 'stopped', status_word='stopped',
                               trap='negation')
                doc.traps.append('negation')
        elif section == 'followup':
            page.add('Follow up:', 'heading')
            write_note(doc, page, r.choice(['MOPD in 2/52', 'GOPD in 1/52 with FBC', 'Clinic review in 4/52']))
            write_note(doc, page, r.choice(['Advised plenty of oral fluids', 'Complete the full course of drugs',
                                            'Return to ER if fever recurs']))
            page.add(f'Discharging doctor: {doc.prescriber}', 'small', gap=10)


def discharge_sections(doc: Doc):
    if 'sections' not in doc.__dict__:
        plan = {1: [['admission', 'vitals', 'treatment', 'discharge_meds', 'followup']],
                2: [['admission', 'vitals', 'labs'], ['treatment', 'discharge_meds', 'followup']],
                3: [['admission', 'vitals'], ['labs', 'treatment'], ['discharge_meds', 'followup']],
                4: [['admission'], ['vitals', 'labs'], ['treatment', 'discharge_meds'], ['followup']]}
        doc.sections = plan[doc.n_pages]
    return doc.sections


def lab_report(doc: Doc, page: Page):
    r = doc.rng
    letterhead(doc, page, 'LABORATORY REPORT')
    if page.number == 1:
        identity_block(doc, page)
        page.add(f'Requested by: {doc.prescriber}   Date: {doc.date(0)}', doc.body_role)
        write_note(doc, page, r.choice(['fever x5/7', 'routine check', 'pre-op screening', '?anaemia']),
                   label='Clinical details:')
    else:
        continuation_identity(doc, page)
    panels_by_page = doc.__dict__.setdefault('lab_pages', lab_plan(doc))
    for panel in panels_by_page[page.number - 1]:
        page.add({'mp': 'MALARIA PARASITE', 'mrdt': 'MALARIA RDT', 'widal': 'WIDAL TEST', 'pcv': 'HAEMATOLOGY',
                  'fbc': 'FULL BLOOD COUNT', 'eucr': 'E/U/Cr', 'fbs': 'BLOOD SUGAR'}[panel], 'heading', gap=8)
        write_lab(doc, page, panel)
    if page.number == doc.n_pages:
        if r.random() < 0.4:
            write_note(doc, page, r.choice(['Repeat FBC in 1/52', 'Please correlate clinically']), label='Comment:')
        page.add(f'Lab scientist: {r.choice(["M. Testscientist", "L. Samplelab"])}', 'small', gap=10)


def lab_plan(doc: Doc):
    panels = ['mp', 'mrdt', 'widal', 'pcv', 'fbc', 'eucr', 'fbs']
    doc.rng.shuffle(panels)
    per = max(1, min(3, len(panels) // doc.n_pages))
    plan = [panels[i * per:(i + 1) * per] for i in range(doc.n_pages)]
    return [p if p else ['pcv'] for p in plan]


def referral_letter(doc: Doc, page: Page):
    r = doc.rng
    letterhead(doc, page, 'REFERRAL LETTER')
    cond = doc.__dict__.setdefault('main_cond', pick_conditions(doc)[0])
    names, meds, labs, complaint = CONDITIONS[cond]
    if page.number == 1:
        page.add(f'Date: {doc.date(0)}', doc.body_role)
        target = r.choice(REFERRAL_TARGETS)
        page.add(f'To: The Consultant, {target}', doc.body_role)
        identity_block(doc, page)
        page.add('Dear Colleague,', doc.body_role, gap=6)
        n = page.add(f'Kindly see the above named patient with {complaint}.', doc.body_role)
        page.item('note', complaint, n, {'text': complaint})
        write_diagnosis(doc, page, r.choice(names), 'confirmed', label='Working diagnosis:')
        negations(doc, page, cond)
        write_allergy(doc, page)
        page.add('Currently on:', doc.body_role)
        traps, trap = trap_meds(doc)
        if len(traps) == 2 and r.random() < 0.5:
            write_two_medicines(doc, page, traps[0], traps[1], 'current', trap=trap)
        else:
            for key in traps:
                write_medicine(doc, page, key, 'current', trap=trap)
        for key in med_plan(doc, cond, limit=2):
            if key not in traps:
                write_medicine(doc, page, key, 'current')
        write_note(doc, page, f'Refer to {target} for specialist review')
        if doc.n_pages == 1:
            write_vitals_line(doc, page, ['blood_pressure', 'pulse'], prefix='Last vitals: ')
            page.add(f'Yours faithfully, {doc.prescriber}', doc.body_role, gap=10)
    else:
        continuation_identity(doc, page)
        if page.number == 2:
            page.add('Recent vitals:', 'heading')
            write_vitals_line(doc, page, ['blood_pressure', 'pulse', 'temperature'])
            write_vitals_line(doc, page, ['oxygen_saturation', 'weight'])
            page.add('Recent results:', 'heading')
            for panel in (labs or ['pcv'])[:2]:
                write_lab(doc, page, panel)
        else:
            page.add('Additional history:', 'heading')
            write_diagnosis(doc, page, r.choice(['HTN', 'Asthma', 'PUD', 'SCD']), 'history', trap='negation')
            if r.random() < 0.5:
                write_diagnosis(doc, page, r.choice(['DM', 'HTN']), 'family_history', trap='negation')
            if r.random() < 0.5:
                write_medicine(doc, page, r.choice(['metf', 'ibu', 'hctz']), 'stopped', status_word='stopped',
                               trap='negation')
            write_note(doc, page, r.choice(['Patient lives alone', 'Non-smoker, no alcohol']))
        if page.number == doc.n_pages:
            page.add(f'Yours faithfully, {doc.prescriber}', doc.body_role, gap=10)


def vitals_chart(doc: Doc, page: Page):
    r = doc.rng
    letterhead(doc, page, 'OBSERVATION / VITAL SIGNS CHART')
    if page.number == 1:
        identity_block(doc, page)
        page.add(f'Ward: {r.choice(["Female Medical", "Male Medical", "Paediatrics", "Ward 4"])}', doc.body_role)
    else:
        continuation_identity(doc, page)
    page.add(f'Day {page.number}: {doc.date(page.number - 1)}', 'heading', gap=6)
    for hour in r.sample(['06:00', '10:00', '14:00', '18:00', '22:00', '02:00'], r.randint(3, 5)):
        measures = ['blood_pressure', 'pulse', 'temperature', 'respiratory_rate']
        if r.random() < 0.5:
            measures.append('oxygen_saturation')
        write_vitals_line(doc, page, measures, prefix=f'{hour}  ', with_units=False)
    if page.number == 1:
        write_vitals_line(doc, page, ['weight'], prefix='Admission ', with_units=True)
    if r.random() < 0.5:
        write_note(doc, page, r.choice(['Tepid sponging done', 'Doctor informed of high temp', 'Patient comfortable']),
                   label='Nurse note:')
    if r.random() < 0.35:
        write_medicine(doc, page, r.choice(['pcm', 'ceftr', 'artes']), 'current', status_word='given')
    page.add(f'Charted by: {doc.nurse}', 'small', gap=6)


KIND_WRITERS = {'outpatient_card': outpatient_card, 'prescription': prescription,
                'discharge_summary': discharge_summary, 'lab_report': lab_report,
                'referral_letter': referral_letter, 'vitals_chart': vitals_chart}


# ---------------------------------------------------------------------------------------------------------------
# Rendering

_font_cache: dict = {}


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    key = (name, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(os.path.join(FONT_DIR, FONTS[name]), size,
                                              layout_engine=ImageFont.Layout.BASIC)
    return _font_cache[key]


@dataclass
class Style:
    difficulty: str
    typed_font: str
    hand_font: str
    body_size: int
    ink: tuple
    paper: tuple
    mode: str


def make_style(rng: random.Random, difficulty: str) -> Style:
    typed = rng.choice(['sans', 'sans', 'mono'])
    hand = rng.choice(HAND_FONTS)
    if difficulty == 'handwritten':
        return Style(difficulty, typed, hand, 30, (20, 40, 140), (250, 247, 236), 'RGB')
    if difficulty == 'faint_scan':
        return Style(difficulty, typed, hand, 27, (120,), (238,), 'L')
    return Style(difficulty, typed, hand, 27, (15,), (250,), 'L')


def role_font(style: Style, role: str, rng: random.Random):
    if role == 'title':
        return font('sans_bold' if style.typed_font == 'sans' else 'mono_bold', 40)
    if role == 'heading':
        return font('sans_bold' if style.typed_font == 'sans' else 'mono_bold', 30)
    if role == 'small':
        return font(style.typed_font, 21)
    if role == 'hand':
        return font(style.hand_font, style.body_size + 6 + rng.randint(-2, 2))
    return font(style.typed_font, style.body_size)


def layout_page(page: Page, style: Style, rng: random.Random):
    """Positions every line; returns [(line, font, x, y, angle)]. The footer line sits at the foot of the page."""
    placed = []
    y = MARGIN_TOP
    avail = PAGE_W - 2 * MARGIN_X
    for line in page.lines:
        if line.role == 'footer':
            placed.append((line, font('sans', 18), MARGIN_X, PAGE_H - 70, 0.0))
            continue
        f = role_font(style, line.role, rng)
        while f.getlength(line.text) > avail - line.indent * 40 and f.size > 14:
            f = font(_font_name(f), f.size - 1)
        y += line.gap
        x = MARGIN_X + line.indent * 40
        angle = 0.0
        if line.role == 'hand':
            x += rng.randint(-6, 10)
            y += rng.randint(-3, 4)
            angle = rng.uniform(-1.2, 1.2)
        placed.append((line, f, x, y, angle))
        y += int(f.size * (1.55 if line.role != 'title' else 1.4))
    if y > PAGE_H - 90:
        raise AssertionError(f'page {page.number} overflows ({y}px)')
    return placed


def _font_name(f: ImageFont.FreeTypeFont) -> str:
    base = os.path.basename(f.path)
    return next(name for name, file in FONTS.items() if file == base)


def draw_raster(page: Page, style: Style, rng: random.Random) -> Image.Image:
    placed = layout_page(page, style, rng)
    img = Image.new(style.mode, (PAGE_W, PAGE_H), style.paper if style.mode == 'RGB' else style.paper[0])
    for line, f, x, y, angle in placed:
        left, top, right, bottom = f.getbbox(line.text)
        mask = Image.new('L', (int(right - left) + 16, int(bottom - top) + 16), 0)
        ImageDraw.Draw(mask).text((8 - left, 8 - top), line.text, font=f, fill=255)
        if angle:
            mask = mask.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        ink = style.ink if line.role == 'hand' or style.mode == 'L' else (15, 15, 15)
        if style.mode == 'RGB' and line.role != 'hand':
            ink = (25, 25, 25)
        color = ink if style.mode == 'RGB' else ink[0]
        layer = Image.new(style.mode, mask.size, color)
        img.paste(layer, (int(x), int(y)), mask)
        bbox = mask.getbbox() or (0, 0, mask.size[0], mask.size[1])
        line.box = [x + bbox[0], y + bbox[1], x + bbox[2], y + bbox[3]]
    return degrade(img, page, style, rng)


def degrade(img: Image.Image, page: Page, style: Style, rng: random.Random) -> Image.Image:
    d = style.difficulty
    if d == 'faint_scan':
        img = img.filter(ImageFilter.GaussianBlur(0.7))
        img = add_noise(img, rng, 10)
    elif d in ('skewed_noisy_scan', 'handwritten_noisy'):
        angle = rng.choice([-1, 1]) * rng.uniform(1.0, 3.5)
        img = img.rotate(angle, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=250)
        rotate_boxes(page, angle)
        img = img.filter(ImageFilter.GaussianBlur(0.8))
        img = add_noise(img, rng, 28)
        draw = ImageDraw.Draw(img)
        for _ in range(500):
            cx, cy = rng.randrange(PAGE_W), rng.randrange(PAGE_H)
            r = rng.choice([1, 1, 2, 3])
            draw.ellipse([cx, cy, cx + r, cy + r], fill=rng.randint(40, 140))
        # A dark scanner edge along one side.
        edge = rng.randint(8, 22)
        draw.rectangle([0, 0, edge, PAGE_H], fill=60)
    for line in page.lines:
        if line.box is not None:
            l, t, r, b = line.box
            line.box = {'left': _frac(l / PAGE_W), 'top': _frac(t / PAGE_H),
                        'width': _frac((r - l) / PAGE_W), 'height': _frac((b - t) / PAGE_H)}
    return img


def add_noise(img: Image.Image, rng: random.Random, strength: int) -> Image.Image:
    noise = Image.frombytes('L', img.size, rng.randbytes(img.size[0] * img.size[1]))
    noise = noise.point(lambda v: v * strength // 255)
    if img.mode == 'RGB':
        noise = Image.merge('RGB', (noise, noise, noise))
    return ImageChops.subtract(img, noise)


def rotate_boxes(page: Page, angle: float):
    """Boxes follow the page when it is rotated about its centre (PIL rotates counter-clockwise)."""
    cx, cy = PAGE_W / 2, PAGE_H / 2
    a = math.radians(angle)
    cos, sin = math.cos(a), math.sin(a)
    for line in page.lines:
        if line.box is None:
            continue
        l, t, r, b = line.box
        xs, ys = [], []
        for x, y in ((l, t), (r, t), (l, b), (r, b)):
            dx, dy = x - cx, y - cy
            xs.append(cx + dx * cos + dy * sin)
            ys.append(cy - dx * sin + dy * cos)
        line.box = [max(0, min(xs)), max(0, min(ys)), min(PAGE_W, max(xs)), min(PAGE_H, max(ys))]


def _frac(v: float) -> float:
    return round(max(0.0, min(1.0, v)), 4)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=False, compress_level=6)
    return buf.getvalue()


def scanned_pdf_bytes(images: list[Image.Image]) -> bytes:
    buf = io.BytesIO()
    first = images[0].convert('RGB') if images[0].mode == 'RGB' else images[0]
    rest = [im for im in images[1:]]
    first.save(buf, format='PDF', save_all=True, append_images=rest, resolution=DPI, quality=88,
               title='Fictional test document', author='HID OCR accuracy kit', producer=KIT_VERSION,
               creator=KIT_VERSION, creationDate=FIXED_PDF_DATE, modDate=FIXED_PDF_DATE)
    return buf.getvalue()


_rl_registered: set = set()


def typed_pdf_bytes(pages: list[Page], style: Style, rng: random.Random) -> bytes:
    """A born-digital PDF (clean typed): real text drawn by reportlab, laid out exactly as the raster pages."""
    for name, file in FONTS.items():
        if name not in _rl_registered:
            pdfmetrics.registerFont(TTFont(f'kit-{name}', os.path.join(FONT_DIR, file)))
            _rl_registered.add(name)
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle('Fictional test document')
    c.setAuthor('HID OCR accuracy kit')
    c.setCreator(KIT_VERSION)
    c.setProducer(KIT_VERSION)
    scale = A4[0] / PAGE_W
    for page in pages:
        placed = layout_page(page, style, rng)
        for line, f, x, y, _ in placed:
            name = _font_name(f)
            left, top, right, bottom = f.getbbox(line.text)
            ascent, _descent = f.getmetrics()
            c.setFont(f'kit-{name}', f.size * scale)
            c.setFillGray(0.05)
            c.drawString(x * scale, A4[1] - (y + ascent) * scale, line.text)
            line.box = {'left': _frac((x + left) / PAGE_W), 'top': _frac((y + top) / PAGE_H),
                            'width': _frac((right - left) / PAGE_W), 'height': _frac((bottom - top) / PAGE_H)}
        c.showPage()
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------------------------

def doc_rng(seed: int, index: int) -> random.Random:
    digest = hashlib.sha256(f'{KIT_VERSION}:{seed}:{index}'.encode()).digest()
    return random.Random(int.from_bytes(digest[:16], 'big'))


def build_document(seed: int, index: int):
    rng = doc_rng(seed, index)
    kind = DOC_KINDS[(index - 1) % len(DOC_KINDS)]
    difficulty = rng.choices(DIFFICULTIES, DIFFICULTY_WEIGHTS)[0]
    is_pdf = rng.random() < PDF_SHARE[kind]
    n_pages = rng.randint(2, 4) if is_pdf else 1
    if kind == 'referral_letter':
        n_pages = min(n_pages, 3)
    doc = Doc(rng, kind, difficulty, n_pages)
    pages = []
    for number in range(1, n_pages + 1):
        page = Page(number)
        KIND_WRITERS[kind](doc, page)
        page.add(FOOTER, 'footer')
        pages.append(page)
    style = make_style(rng, difficulty)
    doc_id = f'D{index:03d}'
    if is_pdf:
        file_name = f'{doc_id}-{kind}.pdf'
        media = 'application/pdf'
        if difficulty == 'clean_typed':
            data = typed_pdf_bytes(pages, style, rng)
        else:
            data = scanned_pdf_bytes([draw_raster(page, style, rng) for page in pages])
    else:
        file_name = f'{doc_id}-{kind}.png'
        media = 'image/png'
        data = png_bytes(draw_raster(pages[0], style, rng))
    if media == 'image/png' and len(data) > 4_500_000:
        raise AssertionError(f'{file_name} is over the 4.5 MB synchronous Textract budget')
    items = []
    for page in pages:
        for item in page.items:
            items.append({'id': f'{doc_id}-i{len(items) + 1:02d}', **item})
    hand = difficulty.startswith('handwritten')
    key = {
        'docId': doc_id,
        'file': file_name,
        'mediaType': media,
        'pages': n_pages,
        'documentKind': kind,
        'difficulty': difficulty,
        'traps': sorted(set(doc.traps)),
        'fictional': True,
        'identity': doc.identity,
        'text': [{'page': page.number, 'lines': [
            {'n': n, 'text': line.text, 'handwritten': hand and line.role == 'hand', 'box': line.box}
            for n, line in enumerate(page.lines, start=1)]} for page in pages],
        'items': items,
    }
    return key, file_name, data


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def requirement_versions():
    return {'pillow': PIL.__version__, 'reportlab': reportlab.Version}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Generate the fictional paper-reading launch check set.')
    parser.add_argument('--seed', type=int, default=20261103)
    parser.add_argument('--count', type=int, default=200)
    parser.add_argument('--out', required=True, help='output directory (documents/ and keys/ are written in it)')
    parser.add_argument('--check-against', help='directory holding committed keys.jsonl and manifest.json')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args(argv)
    if args.count < 1 or args.count > 999:
        parser.error('--count must be 1-999')
    docs_dir = os.path.join(args.out, 'documents')
    keys_dir = os.path.join(args.out, 'keys')
    os.makedirs(docs_dir, exist_ok=True)
    os.makedirs(keys_dir, exist_ok=True)
    key_lines = []
    files = {}
    for index in range(1, args.count + 1):
        key, file_name, data = build_document(args.seed, index)
        with open(os.path.join(docs_dir, file_name), 'wb') as handle:
            handle.write(data)
        files[file_name] = sha256(data)
        key_lines.append(json.dumps(key, sort_keys=True, ensure_ascii=False, separators=(',', ':')))
        if not args.quiet and index % 25 == 0:
            print(f'generated {index}/{args.count}', file=sys.stderr)
    keys_text = '\n'.join(key_lines) + '\n'
    with open(os.path.join(keys_dir, 'keys.jsonl'), 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(keys_text)
    manifest = {'kitVersion': KIT_VERSION, 'seed': args.seed, 'count': args.count,
                'generator': requirement_versions(), 'keysSha256': sha256(keys_text.encode('utf-8')),
                'files': files}
    manifest_text = json.dumps(manifest, indent=2, sort_keys=True) + '\n'
    with open(os.path.join(keys_dir, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(manifest_text)
    pages = sum(json.loads(line)['pages'] for line in key_lines)
    if not args.quiet:
        print(f'wrote {args.count} fictional documents ({pages} pages) to {docs_dir}', file=sys.stderr)
    if args.check_against:
        return check_against(args.check_against, keys_text, manifest)
    return 0


def check_against(directory: str, keys_text: str, manifest: dict) -> int:
    with open(os.path.join(directory, 'keys.jsonl'), encoding='utf-8') as handle:
        committed_keys = handle.read()
    with open(os.path.join(directory, 'manifest.json'), encoding='utf-8') as handle:
        committed = json.load(handle)
    problems = []
    if committed.get('seed') != manifest['seed'] or committed.get('count') != manifest['count']:
        problems.append('seed or count differs from the committed set')
    if committed_keys != keys_text:
        problems.append('answer keys differ from the committed keys')
    for name, digest in manifest['files'].items():
        if committed.get('files', {}).get(name) != digest:
            problems.append(f'{name} differs from the committed manifest')
    if committed.get('generator') != manifest['generator']:
        print(f"note: library versions differ from the committed set ({committed.get('generator')} vs "
              f"{manifest['generator']}); install requirements.txt", file=sys.stderr)
    if problems:
        for problem in problems[:20]:
            print(f'MISMATCH: {problem}', file=sys.stderr)
        return 1
    print('OK: regenerated set is identical to the committed keys and manifest', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
