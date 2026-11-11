#!/usr/bin/env python3
"""Hand-labelled first pass (Lekan) for tools/ocr-accuracy-kit: draws L001-L020 and writes keys/keys.jsonl.

All content is fictional: invented names, "Demo" facilities, DH-TEST folder numbers, and the footer
"FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT" on every page.

Each page is drawn from the same `lines` list that goes into the key's `text`, so every drawn line is exactly the
key's line, and every item's asWritten is checked to be on the lines it names. Regenerate (from anywhere) with:
    python3 tools/ocr-accuracy-kit/sets/lekan-first-pass/make_pages.py
then seal again:
    cd tools/ocr-accuracy-kit && node label.mjs seal --keys sets/lekan-first-pass/keys \
        --docs sets/lekan-first-pass/documents --name lekan-first-pass

Needs Pillow and reportlab (tools/ocr-accuracy-kit/requirements.txt). Output is deterministic for a given
Pillow / reportlab version.
"""
import argparse
import io
import json
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FOOTER = 'FICTIONAL TEST DOCUMENT - NOT A REAL PATIENT'
W, H = 1240, 1754
MAX_BYTES = 300 * 1024

FIELD_ORDER = {
    'medicine': ['name', 'strength', 'form', 'route', 'frequency', 'duration', 'status'],
    'diagnosis': ['name', 'status'],
    'allergy': ['substance', 'reaction', 'severity', 'noKnownAllergies'],
    'lab_result': ['test', 'value', 'unit', 'referenceRange', 'flag'],
    'vital': ['measure', 'value', 'unit'],
    'note': ['text'],
}


def kit_dir():
    return os.environ.get('KIT') or os.path.abspath(os.path.join(HERE, '..', '..'))


def fields(kind, **kw):
    order = FIELD_ORDER[kind]
    unknown = set(kw) - set(order)
    assert not unknown, unknown
    return {name: kw.get(name) for name in order}


class Doc:
    """One document: its pages' lines (with a drawing role each) and its labelled items."""

    def __init__(self, doc_id, file, media, kind, difficulty, pages, default_role='body'):
        self.doc_id, self.file, self.media = doc_id, file, media
        self.kind, self.difficulty = kind, difficulty
        self.pages = [[] for _ in range(pages)]
        self.roles = [[] for _ in range(pages)]
        self.default_role = default_role
        self.items = []
        self.identity = None

    def line(self, page, text, role=None):
        if text == FOOTER:
            role = 'footer'
        self.pages[page - 1].append(text)
        self.roles[page - 1].append(role or self.default_role)
        return len(self.pages[page - 1])

    def item(self, kind, page, lines, as_written, prescription=None, trap=None, **kw):
        joined = '\n'.join(self.pages[page - 1][n - 1] for n in lines)
        assert as_written in joined, (self.doc_id, as_written, joined)
        f = fields(kind, **kw)
        if trap is None:
            # The kit marks every not-confirmed diagnosis and every stopped medicine as a negation trap (never a past one).
            if kind == 'diagnosis' and f['status'] != 'confirmed':
                trap = 'negation'
            if kind == 'medicine' and f['status'] == 'stopped':
                trap = 'negation'
        # As in the kit, prescriber and date only on new medicines in a prescription document.
        if kind == 'medicine' and (self.kind != 'prescription' or f['status'] != 'new'):
            prescription = None
        if kind == 'medicine' and f['status'] == 'stopped':
            assert prescription is None, (self.doc_id, as_written, 'no prescription on a stopped medicine')
        self.items.append({'id': f'{self.doc_id}-i{len(self.items) + 1:02d}', 'kind': kind, 'page': page,
                           'lines': lines, 'asWritten': as_written, 'fields': f,
                           'prescription': prescription, 'trap': trap})

    # Shorthands: add a line and the items read from it.
    def li(self, page, line_text, kind, as_written=None, role=None, **kw):
        n = self.line(page, line_text, role)
        self.item(kind, page, [n], as_written if as_written is not None else line_text, **kw)
        return n

    def set_identity(self, page, lines, name=None, dob=None, folder=None, sex=None):
        assert page == 1, 'identity is labelled on the first page only'
        self.identity = {'page': page, 'lines': lines, 'nameAsWritten': name, 'dateOfBirthAsWritten': dob,
                         'folderNumberAsWritten': folder, 'sexAsWritten': sex}

    def key(self):
        traps = sorted({item['trap'].split(':')[0] for item in self.items if item['trap']})
        return {
            'docId': self.doc_id, 'file': self.file, 'mediaType': self.media, 'pages': len(self.pages),
            'documentKind': self.kind, 'difficulty': self.difficulty, 'fictional': True,
            'identity': self.identity,
            'text': [{'page': i + 1, 'lines': [{'n': n + 1, 'text': t, 'handwritten': role == 'hand'}
                                               for n, (t, role) in enumerate(zip(lines, roles))]}
                     for i, (lines, roles) in enumerate(zip(self.pages, self.roles))],
            'items': self.items,
            'traps': traps,
        }


def med(d, page, line_text, as_written=None, rx=None, trap=None, role=None, **kw):
    return d.li(page, line_text, 'medicine', as_written, role=role, prescription=rx, trap=trap, **kw)


def lab_row(d, page, test, value, unit, ref, flag, widths=(14, 9, 11, 13)):
    """A table row: asWritten is the whole row (as generate.py and L002 do)."""
    text = f'{test:<{widths[0]}}{value:<{widths[1]}}{(unit or ""):<{widths[2]}}{(ref or ""):<{widths[3]}}{flag or ""}'
    text = text.rstrip()
    d.li(page, text, 'lab_result', role='mono', test=test, value=value, unit=unit, referenceRange=ref, flag=flag)


TABLE_HEAD = 'Test          Result   Unit       Ref. range   Flag'


# ============================================================================================================
# L001-L003 (first three, unchanged pages; their drawing code is kept as first written)

def build_l001():
    d = Doc('L001', 'L001-outpatient_card.png', 'image/png', 'outpatient_card', 'handwritten', 1, 'hand')
    rx = {'prescriberAsWritten': 'Dr A. Example', 'dateAsWritten': '11/11/2026'}
    d.line(1, 'DEMO CLINIC - OUTPATIENT CARD', 'title')
    n = d.line(1, 'Name: Bola Testperson   Age: 52yrs   Sex: M   Folder No: DH-TEST-0153')
    d.set_identity(1, [n], 'Bola Testperson', '52yrs', 'DH-TEST-0153', 'M')
    n = d.line(1, 'c/o itchy rash x2/7, headache')
    d.item('note', 1, [n], 'itchy rash x2/7, headache', text='itchy rash x2/7, headache')
    n = d.line(1, 'BP 168/102   P 88/min')
    d.item('vital', 1, [n], 'BP 168/102', measure='blood_pressure', value='168/102', unit=None)
    d.item('vital', 1, [n], 'P 88/min', measure='pulse', value='88', unit='/min')
    n = d.line(1, 'Hx: HTN')
    d.item('diagnosis', 1, [n], 'Hx: HTN', name='HTN', status='history')
    n = d.line(1, 'Dx: Urticaria')
    d.item('diagnosis', 1, [n], 'Urticaria', name='Urticaria', status='confirmed')
    n = d.line(1, 'No evidence of typhoid')
    d.item('diagnosis', 1, [n], 'No evidence of typhoid', name='typhoid', status='ruled_out')
    n = d.line(1, '?UTI')
    d.item('diagnosis', 1, [n], '?UTI', name='UTI', status='suspected')
    n = d.line(1, 'Allergy: Sulphonamides - itching (mild)')
    d.item('allergy', 1, [n], 'Allergy: Sulphonamides - itching (mild)', substance='Sulphonamides',
           reaction='itching', severity='mild', noKnownAllergies=False)
    trap = 'lookalike:hydroxyzine/hydralazine'
    n = d.line(1, 'Tab Hydroxyzine 25mg nocte x5/7')
    d.item('medicine', 1, [n], 'Tab Hydroxyzine 25mg nocte x5/7', rx, trap, name='Hydroxyzine', strength='25mg',
           form='Tab', route=None, frequency='nocte', duration='x5/7', status='new')
    n = d.line(1, 'Tab Hydralazine 25mg tds')
    d.item('medicine', 1, [n], 'Tab Hydralazine 25mg tds', rx, trap, name='Hydralazine', strength='25mg',
           form='Tab', route=None, frequency='tds', duration=None, status='new')
    n = d.line(1, 'Tab Nifedipine 20mg bd (stopped)')
    d.item('medicine', 1, [n], 'Tab Nifedipine 20mg bd (stopped)', name='Nifedipine', strength='20mg',
           form='Tab', route=None, frequency='bd', duration=None, status='stopped')
    n = d.line(1, 'Urine m/c/s')
    d.item('note', 1, [n], 'Urine m/c/s', text='Urine m/c/s')
    n = d.line(1, 'Review in 1/52')
    d.item('note', 1, [n], 'Review in 1/52', text='Review in 1/52')
    d.line(1, 'Dr A. Example  11/11/2026')
    d.line(1, FOOTER)
    return d


def draw_l001(d, path):
    rng = random.Random(1001)
    img = Image.new('L', (W, H), 250)
    g = ImageDraw.Draw(img)
    kit = kit_dir()
    hand = ImageFont.truetype(os.path.join(kit, 'fonts', 'Kalam-Regular.ttf'), 40)
    printed = ImageFont.truetype(os.path.join(kit, 'fonts', 'PT_Sans-Web-Bold.ttf'), 40)
    small = ImageFont.truetype(os.path.join(kit, 'fonts', 'PT_Sans-Web-Regular.ttf'), 24)
    # faint ruled card lines
    for y in range(210, H - 120, 92):
        g.line([(60, y + 60), (W - 60, y + 60)], fill=215, width=2)
    y = 70
    for i, text in enumerate(d.pages[0]):
        if i == 0:
            font, x, fill = printed, 60, 30
        elif text == FOOTER:
            font, x, fill = small, 60, 60
            y = H - 90
        else:
            font, x, fill = hand, 80 + rng.randint(-12, 12), rng.choice([20, 35, 50])
        width = g.textlength(text, font=font)
        if width > W - x - 50:  # shrink to fit
            size = int(font.size * (W - x - 50) / width)
            font = font.font_variant(size=size)
        # draw on a layer and rotate slightly for a handwritten look
        layer = Image.new('L', (W, 90), 0)
        ImageDraw.Draw(layer).text((x, 10), text, font=font, fill=255)
        if font is hand or font.path.endswith('Kalam-Regular.ttf'):
            layer = layer.rotate(rng.uniform(-0.8, 0.8), resample=Image.BICUBIC, center=(x, 45))
        img.paste(Image.new('L', (W, 90), fill), (0, y - 10), layer)
        y += 92 if i else 140
    img.save(path, optimize=True)


def build_l002():
    d = Doc('L002', 'L002-lab_report.jpg', 'image/jpeg', 'lab_report', 'clean_typed', 1)
    d.line(1, 'DEMO HOSPITAL - LABORATORY')
    d.line(1, 'HAEMATOLOGY AND PARASITOLOGY REPORT')
    n1 = d.line(1, 'Name: Ada Example   DOB: 14/03/1991   Sex: Female')
    n2 = d.line(1, 'Folder No: DH-TEST-0207   Lab No: LAB-TEST-0091')
    d.set_identity(1, [n1, n2], 'Ada Example', '14/03/1991', 'DH-TEST-0207', 'Female')
    d.line(1, 'Requested by: Dr T. Testperson   Received: 09/11/2026')
    n = d.line(1, 'Clinical details: fever x4/7')
    d.item('note', 1, [n], 'fever x4/7', text='fever x4/7')
    n = d.line(1, 'Vitals: BP 118/76   PR 104 b/min   Temp 38.6C   SpO2 97%')
    d.item('vital', 1, [n], 'BP 118/76', measure='blood_pressure', value='118/76', unit=None)
    d.item('vital', 1, [n], 'PR 104 b/min', measure='pulse', value='104', unit='b/min')
    d.item('vital', 1, [n], 'Temp 38.6C', measure='temperature', value='38.6', unit='C')
    d.item('vital', 1, [n], 'SpO2 97%', measure='oxygen_saturation', value='97', unit='%')
    n = d.line(1, 'Weight: 64kg')
    d.item('vital', 1, [n], 'Weight: 64kg', measure='weight', value='64', unit='kg')
    d.line(1, 'MALARIA PARASITE')
    n = d.line(1, 'MP (thick film): Seen (++)')
    d.item('lab_result', 1, [n], 'MP (thick film): Seen (++)', test='MP (thick film)', value='Seen (++)',
           unit=None, referenceRange=None, flag=None)
    d.line(1, 'FULL BLOOD COUNT (FBC)')
    d.line(1, 'Test         Result   Unit       Ref. range   Flag')
    rows = [('PCV', '29', '%', '36-46', 'L'), ('Hb', '9.6', 'g/dL', '12.0-16.0', 'L'),
            ('WBC', '12.4', 'x10^9/L', '4.0-11.0', 'H'), ('Neutrophils', '78', '%', '40-75', 'H'),
            ('Lymphocytes', '18', '%', '20-45', 'L'), ('Platelets', '142', 'x10^9/L', '150-400', 'L'),
            ('MCV', '84', 'fL', '80-100', None)]
    for test, value, unit, ref, flag in rows:
        text = f'{test:<13}{value:<9}{unit:<11}{ref:<13}{flag or ""}'.rstrip()
        n = d.line(1, text)
        d.item('lab_result', 1, [n], text, test=test, value=value, unit=unit, referenceRange=ref, flag=flag)
    n = d.line(1, 'Comment: Malaria parasites seen; mild anaemia. Repeat PCV in 1/52.')
    d.item('note', 1, [n], 'Malaria parasites seen; mild anaemia. Repeat PCV in 1/52.',
           text='Malaria parasites seen; mild anaemia. Repeat PCV in 1/52.')
    d.line(1, 'Checked by: B. Testscientist (MLS)   10/11/2026')
    d.line(1, FOOTER)
    return d


def draw_l002(d, path):
    kit = kit_dir()
    bold = ImageFont.truetype(os.path.join(kit, 'fonts', 'PT_Sans-Web-Bold.ttf'), 36)
    body = ImageFont.truetype(os.path.join(kit, 'fonts', 'PT_Sans-Web-Regular.ttf'), 28)
    mono = ImageFont.truetype(os.path.join(kit, 'fonts', 'CourierPrime-Regular.ttf'), 28)
    monob = ImageFont.truetype(os.path.join(kit, 'fonts', 'CourierPrime-Bold.ttf'), 28)
    img = Image.new('L', (W, H), 255)
    g = ImageDraw.Draw(img)
    y = 70
    lines = d.pages[0]
    table_start = lines.index('Test         Result   Unit       Ref. range   Flag')
    for i, text in enumerate(lines):
        if i in (0, 1) or text in ('MALARIA PARASITE', 'FULL BLOOD COUNT (FBC)'):
            font = bold if i == 0 else body.font_variant(size=30)
            if i == 0:
                g.text((W // 2 - g.textlength(text, font=font) // 2, y), text, font=font, fill=0)
            else:
                g.text((80, y + 14), text, font=bold.font_variant(size=30), fill=0)
                y += 14
        elif table_start <= i < table_start + 8:
            g.text((100, y), text, font=monob if i == table_start else mono, fill=0)
        elif text == FOOTER:
            y = H - 100
            g.text((80, y), text, font=body.font_variant(size=24), fill=60)
        else:
            g.text((80, y), text, font=body, fill=0)
        if i == 1:
            g.line([(60, y + 50), (W - 60, y + 50)], fill=0, width=2)
            y += 20
        y += 52
    img.save(path, quality=80, optimize=True)


def build_l003():
    d = Doc('L003', 'L003-discharge_summary.pdf', 'application/pdf', 'discharge_summary', 'clean_typed', 2)
    d.line(1, 'DEMO HOSPITAL')
    d.line(1, 'DISCHARGE SUMMARY')
    n = d.line(1, 'Name: Chidi Testperson   DOB: 02/07/1968   Sex: Male   Folder No: DH-TEST-0318')
    d.set_identity(1, [n], 'Chidi Testperson', '02/07/1968', 'DH-TEST-0318', 'Male')
    d.line(1, 'Admitted: 01/11/2026   Discharged: 08/11/2026   Ward: Male Medical')
    n = d.line(1, 'Diagnosis: Community-acquired pneumonia')
    d.item('diagnosis', 1, [n], 'Community-acquired pneumonia', name='Community-acquired pneumonia', status='confirmed')
    n = d.line(1, 'Secondary: T2DM (poorly controlled)')
    d.item('diagnosis', 1, [n], 'T2DM (poorly controlled)', name='T2DM', status='confirmed')
    n = d.line(1, 'FHx: Hypertension (father)')
    d.item('diagnosis', 1, [n], 'FHx: Hypertension (father)', name='Hypertension', status='family_history')
    n = d.line(1, 'Allergy: Ceftriaxone - anaphylaxis (severe)')
    d.item('allergy', 1, [n], 'Allergy: Ceftriaxone - anaphylaxis (severe)', substance='Ceftriaxone',
           reaction='anaphylaxis', severity='severe', noKnownAllergies=False)
    n = d.line(1, 'Presenting complaint: cough and fever x5/7')
    d.item('note', 1, [n], 'cough and fever x5/7', text='cough and fever x5/7')
    n = d.line(1, 'On admission: T 39.1C   RR 28/min   SpO2 89% on air')
    d.item('vital', 1, [n], 'T 39.1C', measure='temperature', value='39.1', unit='C')
    d.item('vital', 1, [n], 'RR 28/min', measure='respiratory_rate', value='28', unit='/min')
    d.item('vital', 1, [n], 'SpO2 89%', measure='oxygen_saturation', value='89', unit='%')
    n = d.line(1, 'CXR: right lower lobe consolidation')
    d.item('note', 1, [n], 'CXR: right lower lobe consolidation', text='CXR: right lower lobe consolidation')
    n = d.line(1, 'WBC: 15.8 x10^9/L (4.0-11.0) H')
    d.item('lab_result', 1, [n], 'WBC: 15.8 x10^9/L (4.0-11.0) H', test='WBC', value='15.8', unit='x10^9/L',
           referenceRange='4.0-11.0', flag='H')
    n = d.line(1, 'FBS: 11.2 mmol/L (3.9-6.1) H')
    d.item('lab_result', 1, [n], 'FBS: 11.2 mmol/L (3.9-6.1) H', test='FBS', value='11.2', unit='mmol/L',
           referenceRange='3.9-6.1', flag='H')
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - DISCHARGE SUMMARY (continued) - page 2 of 2')
    d.line(2, 'Name: Chidi Testperson   Folder No: DH-TEST-0318')
    d.line(2, 'Discharge medication:')
    n = d.line(2, 'Tab Azithromycin 500mg od x3/7')
    d.item('medicine', 2, [n], 'Tab Azithromycin 500mg od x3/7', name='Azithromycin', strength='500mg', form='Tab',
           route=None, frequency='od', duration='x3/7', status='new')
    n = d.line(2, 'Tab Metformin 1g bd - continue')
    d.item('medicine', 2, [n], 'Tab Metformin 1g bd - continue', name='Metformin', strength='1g', form='Tab',
           route=None, frequency='bd', duration=None, status='current')
    n = d.line(2, 'Insulin glargine 10 units SC nocte (new)')
    d.item('medicine', 2, [n], 'Insulin glargine 10 units SC nocte (new)', name='Insulin glargine',
           strength='10 units', form=None, route='SC', frequency='nocte', duration=None, status='new')
    n = d.line(2, 'Tab Glibenclamide 5mg od (stopped)')
    d.item('medicine', 2, [n], 'Tab Glibenclamide 5mg od (stopped)', name='Glibenclamide', strength='5mg',
           form='Tab', route=None, frequency='od', duration=None, status='stopped')
    n = d.line(2, 'Tab Paracetamol 1g tds prn')
    d.item('medicine', 2, [n], 'Tab Paracetamol 1g tds prn', name='Paracetamol', strength='1g', form='Tab',
           route=None, frequency='tds prn', duration=None, status='new')
    n = d.line(2, 'Note: Do not give ceftriaxone or other cephalosporins.')
    d.item('note', 2, [n], 'Do not give ceftriaxone or other cephalosporins.',
           text='Do not give ceftriaxone or other cephalosporins.')
    n = d.line(2, 'Follow-up: Medical OPD in 2/52 with FBS')
    d.item('note', 2, [n], 'Medical OPD in 2/52 with FBS', text='Medical OPD in 2/52 with FBS')
    d.line(2, 'Dr K. Example (Medical Registrar)   08/11/2026')
    d.line(2, FOOTER)
    return d


def draw_l003(d, path):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(path, pagesize=A4, invariant=1, pageCompression=0)
    c.setTitle('Fictional test document')
    width, height = A4
    for lines in d.pages:
        y = height - 60
        for i, text in enumerate(lines):
            if text == FOOTER:
                c.setFont('Helvetica-Oblique', 9)
                c.drawString(50, 40, text)
                continue
            if i == 0:
                c.setFont('Helvetica-Bold', 15)
            elif text in ('DISCHARGE SUMMARY', 'Discharge medication:'):
                c.setFont('Helvetica-Bold', 12)
            else:
                c.setFont('Helvetica', 11)
            c.drawString(50, y, text)
            y -= 24 if i else 30
        c.showPage()
    c.save()


# ============================================================================================================
# L004-L020: content. Roles: title, heading, body (printed), mono (printed table), hand (handwriting), small,
# footer. `handwritten` in the key is true exactly for the lines drawn in a handwriting font.

def build_l004():
    """Handwritten prescription; look-alike chlorpromazine / chlorpropamide; NKDA."""
    d = Doc('L004', 'L004-prescription.png', 'image/png', 'prescription', 'handwritten', 1, 'hand')
    rx = {'prescriberAsWritten': 'Dr F. Sample', 'dateAsWritten': '03/11/2026'}
    look = 'lookalike:chlorpromazine/chlorpropamide'
    d.line(1, 'DEMO CLINIC', 'title')
    d.line(1, 'PRESCRIPTION FORM', 'heading')
    n1 = d.line(1, 'Name: Musa Demo   Age: 46yrs   Sex: M')
    n2 = d.line(1, 'Folder No: DH-TEST-0412   Date: 03/11/2026')
    d.set_identity(1, [n1, n2], 'Musa Demo', '46yrs', 'DH-TEST-0412', 'M')
    d.li(1, 'Dx: Schizophrenia', 'diagnosis', 'Schizophrenia', name='Schizophrenia', status='confirmed')
    d.li(1, 'Dx: T2DM', 'diagnosis', 'T2DM', name='T2DM', status='confirmed')
    d.li(1, 'Allergies: NKDA', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    d.line(1, 'Rx', 'heading')
    med(d, 1, 'Tab Chlorpromazine 100mg nocte', rx=rx, trap=look, name='Chlorpromazine', strength='100mg',
        form='Tab', route=None, frequency='nocte', duration=None, status='new')
    med(d, 1, 'Tab Chlorpropamide 250mg od', rx=rx, trap=look, name='Chlorpropamide', strength='250mg',
        form='Tab', route=None, frequency='od', duration=None, status='new')
    med(d, 1, 'Tab Benzhexol 2mg bd', rx=rx, name='Benzhexol', strength='2mg', form='Tab', route=None,
        frequency='bd', duration=None, status='new')
    med(d, 1, 'Tab Metformin 500mg bd - continue', name='Metformin', strength='500mg', form='Tab', route=None,
        frequency='bd', duration=None, status='current')
    d.li(1, 'Review in 2/52', 'note', text='Review in 2/52')
    d.line(1, 'Dr F. Sample   03/11/2026')
    d.line(1, FOOTER)
    return d


def build_l005():
    """Handwritten, noisy outpatient card; strength trap amlodipine 5mg / losartan 50mg; FHx, past history, D/C."""
    d = Doc('L005', 'L005-outpatient_card.jpg', 'image/jpeg', 'outpatient_card', 'handwritten_noisy', 1, 'hand')
    rx = {'prescriberAsWritten': 'Dr O. Demo', 'dateAsWritten': '05/11/2026'}
    st = 'strength:5mg/50mg'
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'MEDICAL OUTPATIENT CLINIC - CONTINUATION CARD', 'heading')
    n1 = d.line(1, 'Name: Grace Testperson   Sex: F   DOB: 21/05/1961')
    n2 = d.line(1, 'Folder No: DH-TEST-0577')
    d.set_identity(1, [n1, n2], 'Grace Testperson', '21/05/1961', 'DH-TEST-0577', 'F')
    d.line(1, 'Date: 05/11/2026   MOPD')
    d.li(1, 'c/o headache, dizziness x1/52', 'note', 'headache, dizziness x1/52', text='headache, dizziness x1/52')
    n = d.line(1, 'BP 172/104   P 84   Wt 78kg')
    d.item('vital', 1, [n], 'BP 172/104', measure='blood_pressure', value='172/104', unit=None)
    d.item('vital', 1, [n], 'P 84', measure='pulse', value='84', unit=None)
    d.item('vital', 1, [n], 'Wt 78kg', measure='weight', value='78', unit='kg')
    d.li(1, 'Past history of PUD', 'diagnosis', name='PUD', status='history')
    d.li(1, 'FHx: DM (mother)', 'diagnosis', name='DM', status='family_history')
    d.li(1, 'Dx: HTN - poorly controlled', 'diagnosis', 'HTN - poorly controlled', name='HTN', status='confirmed')
    d.li(1, 'Drug allergy: Nil known', 'allergy', substance=None, reaction=None, severity=None,
         noKnownAllergies=True)
    med(d, 1, 'Tab Amlodipine 5mg od - continue', trap=st, name='Amlodipine', strength='5mg', form='Tab',
        route=None, frequency='od', duration=None, status='current')
    med(d, 1, 'Tab Losartan 50mg od (new)', rx=rx, trap=st, name='Losartan', strength='50mg', form='Tab',
        route=None, frequency='od', duration=None, status='new')
    med(d, 1, 'Tab Methyldopa 250mg tds - D/C', name='Methyldopa', strength='250mg', form='Tab', route=None,
        frequency='tds', duration=None, status='stopped')
    d.li(1, 'E/U/Cr, FBS', 'note', text='E/U/Cr, FBS')
    d.li(1, 'Review in 4/52', 'note', text='Review in 4/52')
    d.line(1, 'Dr O. Demo   05/11/2026')
    d.line(1, FOOTER)
    return d


def build_l006():
    """Typed prescription; look-alike carbamazepine / carbimazole; Nil known allergies."""
    d = Doc('L006', 'L006-prescription.png', 'image/png', 'prescription', 'clean_typed', 1)
    rx = {'prescriberAsWritten': 'Dr N. Testdoctor', 'dateAsWritten': '06/11/2026'}
    look = 'lookalike:carbamazepine/carbimazole'
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'OUTPATIENT PRESCRIPTION', 'heading')
    n1 = d.line(1, 'Patient: Halima Example   DOB: 09/09/1984   Sex: Female')
    n2 = d.line(1, 'Folder No: DH-TEST-0640   Clinic: GOPD')
    d.set_identity(1, [n1, n2], 'Halima Example', '09/09/1984', 'DH-TEST-0640', 'Female')
    d.line(1, 'Date: 06/11/2026')
    d.li(1, 'Diagnosis: Epilepsy', 'diagnosis', 'Epilepsy', name='Epilepsy', status='confirmed')
    d.li(1, 'Diagnosis: Thyrotoxicosis', 'diagnosis', 'Thyrotoxicosis', name='Thyrotoxicosis', status='confirmed')
    d.li(1, 'Allergies: Nil known', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    d.line(1, 'Rx:', 'heading')
    med(d, 1, '1. Tab Carbamazepine 200mg bd x30/7', 'Tab Carbamazepine 200mg bd x30/7', rx=rx, trap=look,
        name='Carbamazepine', strength='200mg', form='Tab', route=None, frequency='bd', duration='x30/7',
        status='new')
    med(d, 1, '2. Tab Carbimazole 5mg tds x30/7', 'Tab Carbimazole 5mg tds x30/7', rx=rx, trap=look,
        name='Carbimazole', strength='5mg', form='Tab', route=None, frequency='tds', duration='x30/7', status='new')
    med(d, 1, '3. Tab Propranolol 40mg bd x30/7', 'Tab Propranolol 40mg bd x30/7', rx=rx, name='Propranolol',
        strength='40mg', form='Tab', route=None, frequency='bd', duration='x30/7', status='new')
    med(d, 1, '4. Tab Folic acid 5mg od x30/7', 'Tab Folic acid 5mg od x30/7', rx=rx, name='Folic acid',
        strength='5mg', form='Tab', route=None, frequency='od', duration='x30/7', status='new')
    d.li(1, 'Note: Do not stop carbamazepine suddenly.', 'note', 'Do not stop carbamazepine suddenly.',
         text='Do not stop carbamazepine suddenly.')
    d.line(1, 'Prescriber: Dr N. Testdoctor   06/11/2026')
    d.line(1, FOOTER)
    return d


def build_l007():
    """Faint scan of a typed clinic note; Query, r/o, No evidence of; 8hrly; D/C."""
    d = Doc('L007', 'L007-outpatient_card.jpg', 'image/jpeg', 'outpatient_card', 'faint_scan', 1)
    rx = {'prescriberAsWritten': 'Dr P. Testperson', 'dateAsWritten': '07/11/2026'}
    d.line(1, 'DEMO CLINIC', 'title')
    d.line(1, 'GENERAL OUTPATIENT CLINIC NOTE', 'heading')
    n = d.line(1, 'Name: Emeka Demo   Age: 29yrs   Sex: Male   Folder No: DH-TEST-0733')
    d.set_identity(1, [n], 'Emeka Demo', '29yrs', 'DH-TEST-0733', 'Male')
    d.line(1, 'Date: 07/11/2026')
    d.li(1, 'C/O: fever, cough x5/7', 'note', 'fever, cough x5/7', text='fever, cough x5/7')
    n = d.line(1, 'O/E: T 38.9C   RR 26/min   SpO2 94%')
    d.item('vital', 1, [n], 'T 38.9C', measure='temperature', value='38.9', unit='C')
    d.item('vital', 1, [n], 'RR 26/min', measure='respiratory_rate', value='26', unit='/min')
    d.item('vital', 1, [n], 'SpO2 94%', measure='oxygen_saturation', value='94', unit='%')
    d.li(1, 'Assessment: Query pneumonia', 'diagnosis', 'Query pneumonia', name='pneumonia', status='suspected')
    d.li(1, 'r/o PTB', 'diagnosis', name='PTB', status='suspected')
    n = d.line(1, 'No evidence of malaria (mRDT negative)')
    d.item('diagnosis', 1, [n], 'No evidence of malaria', name='malaria', status='ruled_out')
    d.item('lab_result', 1, [n], 'mRDT negative', test='mRDT', value='negative', unit=None, referenceRange=None,
           flag=None)
    d.li(1, 'Allergy: Penicillin - urticaria (moderate)', 'allergy', substance='Penicillin', reaction='urticaria',
         severity='moderate', noKnownAllergies=False)
    d.li(1, 'Plan: CXR, sputum AFB x3', 'note', 'CXR, sputum AFB x3', text='CXR, sputum AFB x3')
    med(d, 1, 'Tab Azithromycin 500mg od x3/7', rx=rx, name='Azithromycin', strength='500mg', form='Tab',
        route=None, frequency='od', duration='x3/7', status='new')
    med(d, 1, 'Tab Paracetamol 1g 8hrly x3/7', rx=rx, name='Paracetamol', strength='1g', form='Tab', route=None,
        frequency='8hrly', duration='x3/7', status='new')
    med(d, 1, 'Tab Cotrimoxazole 960mg bd - D/C', name='Cotrimoxazole', strength='960mg', form='Tab', route=None,
        frequency='bd', duration=None, status='stopped')
    d.li(1, 'Review in 3/7 with results', 'note', text='Review in 3/7 with results')
    d.line(1, 'Dr P. Testperson   07/11/2026')
    d.line(1, FOOTER)
    return d


def build_l008():
    """Handwritten, faint prescription with NO patient identity on the page; stat, prn, 8hrly."""
    d = Doc('L008', 'L008-prescription.jpg', 'image/jpeg', 'prescription', 'handwritten_faint', 1, 'hand')
    rx = {'prescriberAsWritten': 'Dr S. Example', 'dateAsWritten': '08/11/2026'}
    d.line(1, 'DEMO CLINIC - EMERGENCY ROOM', 'title')
    d.line(1, 'Date: 08/11/2026')
    d.li(1, 'Dx: Acute exacerbation of asthma', 'diagnosis', 'Acute exacerbation of asthma',
         name='Acute exacerbation of asthma', status='confirmed')
    n = d.line(1, 'SpO2 91%   RR 32')
    d.item('vital', 1, [n], 'SpO2 91%', measure='oxygen_saturation', value='91', unit='%')
    d.item('vital', 1, [n], 'RR 32', measure='respiratory_rate', value='32', unit=None)
    med(d, 1, 'Neb Salbutamol 2.5mg stat', rx=rx, name='Salbutamol', strength='2.5mg', form='Neb', route=None,
        frequency='stat', duration=None, status='new')
    med(d, 1, 'Inj Hydrocortisone 200mg IV stat', rx=rx, name='Hydrocortisone', strength='200mg', form='Inj',
        route='IV', frequency='stat', duration=None, status='new')
    med(d, 1, 'Tab Prednisolone 40mg od x5/7', rx=rx, name='Prednisolone', strength='40mg', form='Tab', route=None,
        frequency='od', duration='x5/7', status='new')
    med(d, 1, 'Tab Aminophylline 100mg 8hrly x5/7', rx=rx, name='Aminophylline', strength='100mg', form='Tab',
        route=None, frequency='8hrly', duration='x5/7', status='new')
    med(d, 1, 'Salbutamol inhaler 100mcg 2 puffs prn', rx=rx, name='Salbutamol', strength='100mcg',
        form='inhaler', route=None, frequency='prn', duration=None, status='new')
    d.li(1, 'Return if breathless', 'note', text='Return if breathless')
    d.line(1, 'Dr S. Example')
    d.line(1, FOOTER)
    return d


def build_l009():
    """Skewed, darkened scan of a typed card; strength trap folic acid 5mg / atenolol 50mg; NKDA; r/o."""
    d = Doc('L009', 'L009-outpatient_card.jpg', 'image/jpeg', 'outpatient_card', 'skewed_noisy_scan', 1)
    rx = {'prescriberAsWritten': 'Dr M. Demo', 'dateAsWritten': '09/11/2026'}
    st = 'strength:5mg/50mg'
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'FAMILY MEDICINE CLINIC', 'heading')
    n1 = d.line(1, 'Name: Ifeoma Testperson   Age: 67yrs   Sex: F')
    n2 = d.line(1, 'Hosp No: DH-TEST-0918')
    d.set_identity(1, [n1, n2], 'Ifeoma Testperson', '67yrs', 'DH-TEST-0918', 'F')
    d.line(1, 'Date: 09/11/2026')
    d.li(1, 'C/O: easy fatigability, palpitations x3/12', 'note', 'easy fatigability, palpitations x3/12',
         text='easy fatigability, palpitations x3/12')
    n = d.line(1, 'BP 148/92 mmHg   PR 96 b/min   Wt 58kg')
    d.item('vital', 1, [n], 'BP 148/92 mmHg', measure='blood_pressure', value='148/92', unit='mmHg')
    d.item('vital', 1, [n], 'PR 96 b/min', measure='pulse', value='96', unit='b/min')
    d.item('vital', 1, [n], 'Wt 58kg', measure='weight', value='58', unit='kg')
    d.li(1, 'Dx: Iron deficiency anaemia', 'diagnosis', 'Iron deficiency anaemia', name='Iron deficiency anaemia',
         status='confirmed')
    d.li(1, 'Hx: HTN', 'diagnosis', name='HTN', status='history')
    d.li(1, 'r/o GI bleed', 'diagnosis', name='GI bleed', status='suspected')
    d.li(1, 'NKDA', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    d.li(1, 'PCV: 24% (36-46) L', 'lab_result', test='PCV', value='24', unit='%', referenceRange='36-46', flag='L')
    med(d, 1, 'Tab Ferrous sulphate 200mg tds x1/12', rx=rx, name='Ferrous sulphate', strength='200mg', form='Tab',
        route=None, frequency='tds', duration='x1/12', status='new')
    med(d, 1, 'Tab Folic acid 5mg od', rx=rx, trap=st, name='Folic acid', strength='5mg', form='Tab', route=None,
        frequency='od', duration=None, status='new')
    med(d, 1, 'Tab Atenolol 50mg od - continue', trap=st, name='Atenolol', strength='50mg', form='Tab', route=None,
        frequency='od', duration=None, status='current')
    med(d, 1, 'Tab Ibuprofen 400mg tds (stopped)', name='Ibuprofen', strength='400mg', form='Tab', route=None,
        frequency='tds', duration=None, status='stopped')
    d.li(1, 'Stool for occult blood x3', 'note', text='Stool for occult blood x3')
    d.li(1, 'Review in 2/52', 'note', text='Review in 2/52')
    d.line(1, 'Dr M. Demo   09/11/2026')
    d.line(1, FOOTER)
    return d


def build_l010():
    """Typed parasitology report: MP, species, density, mRDT, PCV."""
    d = Doc('L010', 'L010-lab_report.png', 'image/png', 'lab_report', 'clean_typed', 1)
    d.line(1, 'DEMO LABORATORY', 'title')
    d.line(1, 'PARASITOLOGY REPORT', 'heading')
    n1 = d.line(1, 'Name: Tunde Example   Age: 8yrs   Sex: M')
    n2 = d.line(1, 'Folder No: DH-TEST-1006   Lab No: LAB-TEST-1006')
    d.set_identity(1, [n1, n2], 'Tunde Example', '8yrs', 'DH-TEST-1006', 'M')
    d.line(1, 'Requested by: Dr C. Testperson (Paediatrics)   Date: 10/11/2026')
    d.li(1, 'Clinical details: fever, vomiting x2/7', 'note', 'fever, vomiting x2/7', text='fever, vomiting x2/7')
    d.line(1, 'MALARIA PARASITE', 'heading')
    d.li(1, 'MP (thick film): Seen (+++)', 'lab_result', test='MP (thick film)', value='Seen (+++)', unit=None,
         referenceRange=None, flag=None)
    d.li(1, 'Species (thin film): P. falciparum', 'lab_result', test='Species (thin film)', value='P. falciparum',
         unit=None, referenceRange=None, flag=None)
    d.li(1, 'Parasite density: 48,000/uL', 'lab_result', test='Parasite density', value='48,000', unit='/uL',
         referenceRange=None, flag=None)
    d.line(1, 'MALARIA RDT', 'heading')
    d.li(1, 'mRDT (HRP2): Positive', 'lab_result', test='mRDT (HRP2)', value='Positive', unit=None,
         referenceRange=None, flag=None)
    d.line(1, 'HAEMATOLOGY', 'heading')
    d.li(1, 'PCV: 27% (30-40) L', 'lab_result', test='PCV', value='27', unit='%', referenceRange='30-40', flag='L')
    d.li(1, 'Comment: Heavy parasitaemia. Please correlate clinically.', 'note',
         'Heavy parasitaemia. Please correlate clinically.', text='Heavy parasitaemia. Please correlate clinically.')
    d.line(1, 'Scientist: M. Testscientist (MLS)   10/11/2026', 'small')
    d.line(1, FOOTER)
    return d


def build_l011():
    """Faint scan: Widal and an FBC table (whole-row asWritten); ?Typhoid in clinical details."""
    d = Doc('L011', 'L011-lab_report.jpg', 'image/jpeg', 'lab_report', 'faint_scan', 1)
    d.line(1, 'DEMO HOSPITAL - LABORATORY', 'title')
    d.line(1, 'SEROLOGY AND HAEMATOLOGY REPORT', 'heading')
    n1 = d.line(1, 'Name: Blessing Demo   DOB: 30/01/1999   Sex: Female')
    n2 = d.line(1, 'Folder No: DH-TEST-1121')
    d.set_identity(1, [n1, n2], 'Blessing Demo', '30/01/1999', 'DH-TEST-1121', 'Female')
    d.line(1, 'Requested by: GOPD   Collected: 10/11/2026')
    d.li(1, 'Clinical details: ?Typhoid fever', 'diagnosis', '?Typhoid fever', name='Typhoid fever',
         status='suspected')
    d.line(1, 'WIDAL TEST', 'heading')
    for test, value in (('S. typhi O', '1/160'), ('S. typhi H', '1/80'), ('S. paratyphi A O', '1/40')):
        d.li(1, f'{test}: {value}', 'lab_result', test=test, value=value, unit=None, referenceRange=None, flag=None)
    d.line(1, 'FULL BLOOD COUNT', 'heading')
    d.line(1, TABLE_HEAD, 'mono')
    for row in (('WBC', '13.2', 'x10^9/L', '4.0-11.0', 'H'), ('Neutrophils', '81', '%', '40-75', 'H'),
                ('Hb', '11.8', 'g/dL', '12.0-16.0', 'L'), ('Platelets', '210', 'x10^9/L', '150-400', None),
                ('ESR', '48', 'mm/hr', '0-20', 'H')):
        lab_row(d, 1, *row)
    d.li(1, 'Comment: Interpret Widal with caution; blood culture advised.', 'note',
         'Interpret Widal with caution; blood culture advised.',
         text='Interpret Widal with caution; blood culture advised.')
    d.line(1, 'Checked by: L. Samplelab', 'small')
    d.line(1, FOOTER)
    return d


def build_l012():
    """Typed chemistry report (born-digital PDF): E/U/Cr table and blood sugars."""
    d = Doc('L012', 'L012-lab_report.pdf', 'application/pdf', 'lab_report', 'clean_typed', 1)
    d.line(1, 'DEMO LABORATORY', 'title')
    d.line(1, 'CLINICAL CHEMISTRY REPORT', 'heading')
    n = d.line(1, 'Name: Yusuf Testperson   DOB: 12/12/1958   Sex: M   Folder No: DH-TEST-1240')
    d.set_identity(1, [n], 'Yusuf Testperson', '12/12/1958', 'DH-TEST-1240', 'M')
    d.line(1, 'Requested by: Dr A. Example (MOPD)   Received: 10/11/2026')
    d.li(1, 'Clinical details: T2DM, HTN on follow-up', 'note', 'T2DM, HTN on follow-up',
         text='T2DM, HTN on follow-up')
    d.line(1, 'E/U/Cr', 'heading')
    d.line(1, TABLE_HEAD, 'mono')
    for row in (('Na+', '138', 'mmol/L', '135-145', None), ('K+', '5.6', 'mmol/L', '3.5-5.0', 'H'),
                ('Cl-', '101', 'mmol/L', '98-107', None), ('HCO3-', '22', 'mmol/L', '22-29', None),
                ('Urea', '9.8', 'mmol/L', '2.5-7.1', 'H'), ('Creatinine', '162', 'umol/L', '60-110', 'H')):
        lab_row(d, 1, *row)
    d.line(1, 'BLOOD SUGAR', 'heading')
    d.li(1, 'FBS: 8.4 mmol/L (3.9-5.6) H', 'lab_result', test='FBS', value='8.4', unit='mmol/L',
         referenceRange='3.9-5.6', flag='H')
    d.li(1, '2HPP: 12.1 mmol/L (<7.8) H', 'lab_result', test='2HPP', value='12.1', unit='mmol/L',
         referenceRange='<7.8', flag='H')
    d.li(1, 'Comment: Raised creatinine and potassium; repeat in 2/52.', 'note',
         'Raised creatinine and potassium; repeat in 2/52.', text='Raised creatinine and potassium; repeat in 2/52.')
    d.line(1, 'Scientist: B. Testscientist   10/11/2026', 'small')
    d.line(1, FOOTER)
    return d


def build_l013():
    """Handwritten side-lab result slip: PCV, MP, mRDT, urine, blood group, RBS (no ranges written)."""
    d = Doc('L013', 'L013-lab_report.png', 'image/png', 'lab_report', 'handwritten', 1, 'hand')
    d.line(1, 'DEMO CLINIC - SIDE LABORATORY', 'title')
    d.line(1, 'LAB RESULT SLIP', 'heading')
    n1 = d.line(1, 'Name: Amaka Testperson   Age: 24yrs   Sex: F')
    n2 = d.line(1, 'Folder: DH-TEST-1313   Ward: Antenatal')
    d.set_identity(1, [n1, n2], 'Amaka Testperson', '24yrs', 'DH-TEST-1313', 'F')
    d.line(1, 'Date: 10/11/2026')
    d.li(1, 'PCV: 31%', 'lab_result', test='PCV', value='31', unit='%', referenceRange=None, flag=None)
    d.li(1, 'MP: not seen', 'lab_result', test='MP', value='not seen', unit=None, referenceRange=None, flag=None)
    d.li(1, 'mRDT: Neg', 'lab_result', test='mRDT', value='Neg', unit=None, referenceRange=None, flag=None)
    d.li(1, 'Urine protein: +', 'lab_result', test='Urine protein', value='+', unit=None, referenceRange=None,
         flag=None)
    d.li(1, 'Urine glucose: nil', 'lab_result', test='Urine glucose', value='nil', unit=None, referenceRange=None,
         flag=None)
    d.li(1, 'Blood group: O Rh D positive', 'lab_result', test='Blood group', value='O Rh D positive', unit=None,
         referenceRange=None, flag=None)
    d.li(1, 'RBS: 5.2 mmol/L', 'lab_result', test='RBS', value='5.2', unit='mmol/L', referenceRange=None,
         flag=None)
    d.line(1, 'sgd: J. Samplelab')
    d.line(1, FOOTER)
    return d


def build_l014():
    """Skewed, noisy two-page scanned lab report (PDF): FBC table, MP, E/U/Cr table, FBS."""
    d = Doc('L014', 'L014-lab_report.pdf', 'application/pdf', 'lab_report', 'skewed_noisy_scan', 2)
    d.line(1, 'DEMO HOSPITAL - LABORATORY', 'title')
    d.line(1, 'LABORATORY REPORT', 'heading')
    n1 = d.line(1, 'Name: Femi Example   DOB: 04/04/1975   Sex: Male')
    n2 = d.line(1, 'Folder No: DH-TEST-1414   Lab No: LAB-TEST-1414')
    d.set_identity(1, [n1, n2], 'Femi Example', '04/04/1975', 'DH-TEST-1414', 'Male')
    d.line(1, 'Requested by: Dr K. Example (Male Medical)   Date: 10/11/2026')
    d.li(1, 'Clinical details: fever, reduced urine output', 'note', 'fever, reduced urine output',
         text='fever, reduced urine output')
    d.line(1, 'FULL BLOOD COUNT', 'heading')
    d.line(1, TABLE_HEAD, 'mono')
    for row in (('WBC', '16.4', 'x10^9/L', '4.0-11.0', 'H'), ('Neutrophils', '85', '%', '40-75', 'H'),
                ('Lymphocytes', '11', '%', '20-45', 'L'), ('Hb', '8.9', 'g/dL', '13.0-17.0', 'L'),
                ('PCV', '27', '%', '40-50', 'L'), ('Platelets', '98', 'x10^9/L', '150-400', 'L')):
        lab_row(d, 1, *row)
    d.line(1, 'MALARIA PARASITE', 'heading')
    d.li(1, 'MP: Not seen', 'lab_result', test='MP', value='Not seen', unit=None, referenceRange=None, flag=None)
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - LABORATORY (continued) - page 2 of 2', 'title')
    d.line(2, 'Name: Femi Example   Folder No: DH-TEST-1414')
    d.line(2, 'E/U/Cr', 'heading')
    d.line(2, TABLE_HEAD, 'mono')
    for row in (('Na+', '131', 'mmol/L', '135-145', 'L'), ('K+', '6.1', 'mmol/L', '3.5-5.0', 'H'),
                ('HCO3-', '16', 'mmol/L', '22-29', 'L'), ('Urea', '21.4', 'mmol/L', '2.5-7.1', 'H'),
                ('Creatinine', '488', 'umol/L', '60-110', 'H')):
        lab_row(d, 2, *row)
    d.line(2, 'BLOOD SUGAR', 'heading')
    d.li(2, 'FBS: 4.6 mmol/L (3.9-5.6)', 'lab_result', test='FBS', value='4.6', unit='mmol/L',
         referenceRange='3.9-5.6', flag=None)
    d.li(2, 'Comment: Hyperkalaemia - doctor informed by phone.', 'note', 'Hyperkalaemia - doctor informed by phone.',
         text='Hyperkalaemia - doctor informed by phone.')
    d.line(2, 'Scientist: M. Testscientist   10/11/2026', 'small')
    d.line(2, FOOTER)
    return d


def build_l015():
    """Typed two-page discharge summary (born-digital PDF): severe malaria; No evidence of; Past history of."""
    d = Doc('L015', 'L015-discharge_summary.pdf', 'application/pdf', 'discharge_summary', 'clean_typed', 2)
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'DISCHARGE SUMMARY', 'heading')
    n = d.line(1, 'Name: Kemi Demo   DOB: 18/08/1990   Sex: Female   Folder No: DH-TEST-1515')
    d.set_identity(1, [n], 'Kemi Demo', '18/08/1990', 'DH-TEST-1515', 'Female')
    d.line(1, 'Admitted: 02/11/2026   Discharged: 06/11/2026   Ward: Female Medical')
    d.li(1, 'Diagnosis: Severe malaria (cerebral)', 'diagnosis', 'Severe malaria (cerebral)', name='Severe malaria',
         status='confirmed')
    d.li(1, 'No evidence of meningitis (CSF normal)', 'diagnosis', 'No evidence of meningitis', name='meningitis',
         status='ruled_out')
    d.li(1, 'Past history of PTB (treated 2019)', 'diagnosis', 'Past history of PTB', name='PTB', status='history')
    d.li(1, 'Allergies: NKDA', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    d.li(1, 'Presenting complaint: fever, confusion x2/7', 'note', 'fever, confusion x2/7',
         text='fever, confusion x2/7')
    n = d.line(1, 'On admission: T 39.8C   BP 96/58   PR 122/min')
    d.item('vital', 1, [n], 'T 39.8C', measure='temperature', value='39.8', unit='C')
    d.item('vital', 1, [n], 'BP 96/58', measure='blood_pressure', value='96/58', unit=None)
    d.item('vital', 1, [n], 'PR 122/min', measure='pulse', value='122', unit='/min')
    d.line(1, 'Investigations:', 'heading')
    d.li(1, 'MP: Seen (++++)', 'lab_result', test='MP', value='Seen (++++)', unit=None, referenceRange=None, flag=None)
    d.li(1, 'mRDT: Positive', 'lab_result', test='mRDT', value='Positive', unit=None, referenceRange=None, flag=None)
    d.li(1, 'PCV: 21% (36-46) L', 'lab_result', test='PCV', value='21', unit='%', referenceRange='36-46', flag='L')
    d.li(1, 'RBS: 3.1 mmol/L (3.9-7.8) L', 'lab_result', test='RBS', value='3.1', unit='mmol/L',
         referenceRange='3.9-7.8', flag='L')
    d.line(1, 'Treatment given:', 'heading')
    med(d, 1, 'Inj Artesunate 120mg IV 12hrly x3 doses', name='Artesunate', strength='120mg', form='Inj', route='IV',
        frequency='12hrly', duration='x3 doses', status='past')
    d.li(1, 'Transfused 1 unit packed cells', 'note', text='Transfused 1 unit packed cells')
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - DISCHARGE SUMMARY (continued) - page 2 of 2', 'title')
    d.line(2, 'Name: Kemi Demo   Folder No: DH-TEST-1515')
    d.line(2, 'Discharge medication:', 'heading')
    med(d, 2, 'Tab Artemether/Lumefantrine 80/480mg bd x3/7', name='Artemether/Lumefantrine', strength='80/480mg',
        form='Tab', route=None, frequency='bd', duration='x3/7', status='new')
    med(d, 2, 'Tab Paracetamol 1g qds prn', name='Paracetamol', strength='1g', form='Tab', route=None,
        frequency='qds prn', duration=None, status='new')
    med(d, 2, 'Tab Ferrous sulphate 200mg tds x1/12', name='Ferrous sulphate', strength='200mg', form='Tab',
        route=None, frequency='tds', duration='x1/12', status='new')
    med(d, 2, 'Tab Folic acid 5mg od x1/12', name='Folic acid', strength='5mg', form='Tab', route=None,
        frequency='od', duration='x1/12', status='new')
    d.li(2, 'Follow-up: Medical OPD in 1/52 with PCV', 'note', 'Medical OPD in 1/52 with PCV',
         text='Medical OPD in 1/52 with PCV')
    d.line(2, 'Dr T. Testperson (Medical Registrar)   06/11/2026')
    d.line(2, FOOTER)
    return d


def build_l016():
    """Faint three-page scanned discharge summary (PDF): DKA; Query; FHx; continue / D/C / previously on."""
    d = Doc('L016', 'L016-discharge_summary.pdf', 'application/pdf', 'discharge_summary', 'faint_scan', 3)
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'DISCHARGE SUMMARY', 'heading')
    n1 = d.line(1, 'Name: Sola Testperson   DOB: 23/02/1955   Sex: Male')
    n2 = d.line(1, 'Folder No: DH-TEST-1616')
    d.set_identity(1, [n1, n2], 'Sola Testperson', '23/02/1955', 'DH-TEST-1616', 'Male')
    d.line(1, 'Admitted: 28/10/2026   Discharged: 07/11/2026   Ward: Male Medical')
    d.li(1, 'Diagnosis: Diabetic ketoacidosis', 'diagnosis', 'Diabetic ketoacidosis', name='Diabetic ketoacidosis',
         status='confirmed')
    d.li(1, 'Secondary: Type 2 diabetes mellitus', 'diagnosis', 'Type 2 diabetes mellitus',
         name='Type 2 diabetes mellitus', status='confirmed')
    d.li(1, 'Secondary: Hypertension', 'diagnosis', 'Hypertension', name='Hypertension', status='confirmed')
    d.li(1, 'Query diabetic nephropathy', 'diagnosis', name='diabetic nephropathy', status='suspected')
    d.li(1, 'FHx: T2DM (both parents)', 'diagnosis', name='T2DM', status='family_history')
    d.li(1, 'Allergy: Cotrimoxazole - Stevens-Johnson syndrome (severe)', 'allergy', substance='Cotrimoxazole',
         reaction='Stevens-Johnson syndrome', severity='severe', noKnownAllergies=False)
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - DISCHARGE SUMMARY (continued) - page 2 of 3', 'title')
    d.line(2, 'Name: Sola Testperson   Folder No: DH-TEST-1616')
    d.li(2, 'Presenting complaint: polyuria, vomiting, drowsiness x3/7', 'note',
         'polyuria, vomiting, drowsiness x3/7', text='polyuria, vomiting, drowsiness x3/7')
    n = d.line(2, 'On admission: BP 104/66   PR 118 b/min   RR 32/min   T 37.2C')
    d.item('vital', 2, [n], 'BP 104/66', measure='blood_pressure', value='104/66', unit=None)
    d.item('vital', 2, [n], 'PR 118 b/min', measure='pulse', value='118', unit='b/min')
    d.item('vital', 2, [n], 'RR 32/min', measure='respiratory_rate', value='32', unit='/min')
    d.item('vital', 2, [n], 'T 37.2C', measure='temperature', value='37.2', unit='C')
    d.line(2, 'Investigations:', 'heading')
    d.li(2, 'RBS: 28.6 mmol/L (3.9-7.8) H', 'lab_result', test='RBS', value='28.6', unit='mmol/L',
         referenceRange='3.9-7.8', flag='H')
    d.li(2, 'Urine ketones: +++', 'lab_result', test='Urine ketones', value='+++', unit=None, referenceRange=None,
         flag=None)
    d.li(2, 'K+: 3.1 mmol/L (3.5-5.0) L', 'lab_result', test='K+', value='3.1', unit='mmol/L',
         referenceRange='3.5-5.0', flag='L')
    d.li(2, 'Creatinine: 142 umol/L (60-110) H', 'lab_result', test='Creatinine', value='142', unit='umol/L',
         referenceRange='60-110', flag='H')
    d.li(2, 'HbA1c: 11.2% (<6.5) H', 'lab_result', test='HbA1c', value='11.2', unit='%', referenceRange='<6.5',
         flag='H')
    d.line(2, 'Treatment given:', 'heading')
    med(d, 2, 'Inj Soluble insulin 0.1 units/kg/hr IV infusion', name='Soluble insulin', strength='0.1 units/kg/hr',
        form='Inj', route='IV', frequency='infusion', duration=None, status='past')
    med(d, 2, 'Inj Ceftriaxone 1g IV od x5/7', name='Ceftriaxone', strength='1g', form='Inj', route='IV',
        frequency='od', duration='x5/7', status='past')
    d.line(2, FOOTER)

    d.line(3, 'DEMO HOSPITAL - DISCHARGE SUMMARY (continued) - page 3 of 3', 'title')
    d.line(3, 'Name: Sola Testperson   Folder No: DH-TEST-1616')
    d.line(3, 'Discharge medication:', 'heading')
    med(d, 3, 'Inj Premixed insulin 70/30 20 units SC bd (new)', name='Premixed insulin 70/30', strength='20 units',
        form='Inj', route='SC', frequency='bd', duration=None, status='new')
    med(d, 3, 'Tab Metformin 1g bd - continue', name='Metformin', strength='1g', form='Tab', route=None,
        frequency='bd', duration=None, status='current')
    med(d, 3, 'Tab Lisinopril 10mg od - continue', name='Lisinopril', strength='10mg', form='Tab', route=None,
        frequency='od', duration=None, status='current')
    med(d, 3, 'Tab Atorvastatin 20mg nocte (new)', name='Atorvastatin', strength='20mg', form='Tab', route=None,
        frequency='nocte', duration=None, status='new')
    med(d, 3, 'Tab Glibenclamide 5mg od - D/C', name='Glibenclamide', strength='5mg', form='Tab', route=None,
        frequency='od', duration=None, status='stopped')
    med(d, 3, 'Previously on Tab Hydrochlorothiazide 25mg od', name='Hydrochlorothiazide', strength='25mg',
        form='Tab', route=None, frequency='od', duration=None, status='past')
    d.li(3, 'Note: Check feet daily; diabetic diet.', 'note', 'Check feet daily; diabetic diet.',
         text='Check feet daily; diabetic diet.')
    d.li(3, 'Follow-up: Diabetes clinic in 2/52 with FBS', 'note', 'Diabetes clinic in 2/52 with FBS',
         text='Diabetes clinic in 2/52 with FBS')
    d.line(3, 'Dr H. Demo (Senior Registrar)   07/11/2026')
    d.line(3, FOOTER)
    return d


def build_l017():
    """Handwritten, noisy two-page discharge summary (scanned PDF); sex not written; r/o; D/C means discharge."""
    d = Doc('L017', 'L017-discharge_summary.pdf', 'application/pdf', 'discharge_summary', 'handwritten_noisy', 2,
            'hand')
    d.line(1, 'DEMO HOSPITAL - MATERNITY', 'title')
    d.line(1, 'DISCHARGE SUMMARY', 'heading')
    n = d.line(1, 'Name: Ruth Example   Age: 31yrs   Folder: DH-TEST-1717')
    d.set_identity(1, [n], 'Ruth Example', '31yrs', 'DH-TEST-1717', None)
    d.line(1, 'Adm: 01/11/2026   D/C: 07/11/2026')
    d.li(1, 'Dx: Severe pre-eclampsia', 'diagnosis', 'Severe pre-eclampsia', name='Severe pre-eclampsia',
         status='confirmed')
    d.li(1, 'Delivered by C/S 02/11/2026', 'note', text='Delivered by C/S 02/11/2026')
    d.li(1, 'r/o HELLP syndrome', 'diagnosis', name='HELLP syndrome', status='suspected')
    d.li(1, 'NKDA', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    n = d.line(1, 'On adm: BP 178/112   P 96')
    d.item('vital', 1, [n], 'BP 178/112', measure='blood_pressure', value='178/112', unit=None)
    d.item('vital', 1, [n], 'P 96', measure='pulse', value='96', unit=None)
    d.li(1, 'Urine protein: +++', 'lab_result', test='Urine protein', value='+++', unit=None, referenceRange=None,
         flag=None)
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - MATERNITY   page 2', 'title')
    d.line(2, 'Name: Ruth Example   Folder: DH-TEST-1717')
    d.line(2, 'Given on ward:')
    med(d, 2, 'Inj MgSO4 4g IV stat', name='MgSO4', strength='4g', form='Inj', route='IV', frequency='stat',
        duration=None, status='past')
    med(d, 2, 'Inj Hydralazine 5mg IV stat', name='Hydralazine', strength='5mg', form='Inj', route='IV',
        frequency='stat', duration=None, status='past')
    d.line(2, 'Discharge drugs:')
    med(d, 2, 'Tab Methyldopa 500mg tds - continue', name='Methyldopa', strength='500mg', form='Tab', route=None,
        frequency='tds', duration=None, status='current')
    med(d, 2, 'Tab Nifedipine 20mg bd x2/52', name='Nifedipine', strength='20mg', form='Tab', route=None,
        frequency='bd', duration='x2/52', status='new')
    med(d, 2, 'Tab Ferrous sulphate 200mg bd', name='Ferrous sulphate', strength='200mg', form='Tab', route=None,
        frequency='bd', duration=None, status='new')
    med(d, 2, 'Tab Aspirin 75mg od (stopped)', name='Aspirin', strength='75mg', form='Tab', route=None,
        frequency='od', duration=None, status='stopped')
    d.li(2, 'At D/C: BP 138/88', 'vital', 'BP 138/88', measure='blood_pressure', value='138/88', unit=None)
    d.li(2, 'PCV: 30%', 'lab_result', test='PCV', value='30', unit='%', referenceRange=None, flag=None)
    d.li(2, 'Review PNC 1/52', 'note', text='Review PNC 1/52')
    d.line(2, 'Dr E. Testperson   07/11/2026')
    d.line(2, FOOTER)
    return d


def build_l018():
    """Typed one-page referral letter: Query; Past history of; Nil known; current meds; stopped."""
    d = Doc('L018', 'L018-referral_letter.png', 'image/png', 'referral_letter', 'clean_typed', 1)
    d.line(1, 'DEMO CLINIC', 'title')
    d.line(1, 'REFERRAL LETTER', 'heading')
    d.line(1, 'Date: 10/11/2026')
    d.line(1, 'To: The Consultant Psychiatrist, Demo Hospital')
    n = d.line(1, 'Re: Joy Testperson   DOB: 15/07/1993   Sex: F   Folder No: DH-TEST-1818')
    d.set_identity(1, [n], 'Joy Testperson', '15/07/1993', 'DH-TEST-1818', 'F')
    d.line(1, 'Dear Colleague,')
    d.li(1, 'Kindly see the above named with insomnia and low mood x3/12.', 'note', 'insomnia and low mood x3/12',
         text='insomnia and low mood x3/12')
    d.li(1, 'Working diagnosis: Depression', 'diagnosis', 'Depression', name='Depression', status='confirmed')
    d.li(1, 'Query bipolar affective disorder', 'diagnosis', name='bipolar affective disorder', status='suspected')
    d.li(1, 'Past history of seizures', 'diagnosis', name='seizures', status='history')
    d.li(1, 'Allergies: Nil known', 'allergy', substance=None, reaction=None, severity=None, noKnownAllergies=True)
    d.line(1, 'Currently on:', 'heading')
    med(d, 1, 'Tab Amitriptyline 25mg nocte', name='Amitriptyline', strength='25mg', form='Tab', route=None,
        frequency='nocte', duration=None, status='current')
    med(d, 1, 'Tab Carbamazepine 200mg bd', name='Carbamazepine', strength='200mg', form='Tab', route=None,
        frequency='bd', duration=None, status='current')
    med(d, 1, 'Tab Diazepam 5mg nocte x5/7 (stopped)', name='Diazepam', strength='5mg', form='Tab', route=None,
        frequency='nocte', duration='x5/7', status='stopped')
    n = d.line(1, 'Last vitals: BP 122/78   PR 76 b/min')
    d.item('vital', 1, [n], 'BP 122/78', measure='blood_pressure', value='122/78', unit=None)
    d.item('vital', 1, [n], 'PR 76 b/min', measure='pulse', value='76', unit='b/min')
    d.li(1, 'Refer to Psychiatry for specialist review', 'note', text='Refer to Psychiatry for specialist review')
    d.line(1, 'Yours faithfully,')
    d.line(1, 'Dr G. Example (Medical Officer)')
    d.line(1, FOOTER)
    return d


def build_l019():
    """Skewed two-page scanned referral (PDF): look-alike carbimazole / carbamazepine (current); No evidence of; FHx."""
    d = Doc('L019', 'L019-referral_letter.pdf', 'application/pdf', 'referral_letter', 'skewed_noisy_scan', 2)
    look = 'lookalike:carbamazepine/carbimazole'
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'REFERRAL LETTER', 'heading')
    d.line(1, 'Date: 09/11/2026')
    d.line(1, 'To: The Consultant, Endocrine Unit, Demo Hospital')
    n = d.line(1, 'Name: Peter Demo   Age: 58yrs   Sex: M   Folder No: DH-TEST-1919')
    d.set_identity(1, [n], 'Peter Demo', '58yrs', 'DH-TEST-1919', 'M')
    d.line(1, 'Dear Colleague,')
    d.li(1, 'Kindly review with weight loss, palpitations, heat intolerance x4/12.', 'note',
         'weight loss, palpitations, heat intolerance x4/12', text='weight loss, palpitations, heat intolerance x4/12')
    d.li(1, 'Working diagnosis: Thyrotoxicosis', 'diagnosis', 'Thyrotoxicosis', name='Thyrotoxicosis',
         status='confirmed')
    d.li(1, 'No evidence of heart failure', 'diagnosis', name='heart failure', status='ruled_out')
    d.li(1, 'FHx: Thyroid disease (sister)', 'diagnosis', name='Thyroid disease', status='family_history')
    d.li(1, 'Allergy: Aspirin - wheeze', 'allergy', substance='Aspirin', reaction='wheeze', severity=None,
         noKnownAllergies=False)
    d.line(1, 'Currently on:', 'heading')
    med(d, 1, 'Tab Carbimazole 10mg tds', trap=look, name='Carbimazole', strength='10mg', form='Tab', route=None,
        frequency='tds', duration=None, status='current')
    med(d, 1, 'Tab Carbamazepine 200mg bd', trap=look, name='Carbamazepine', strength='200mg', form='Tab',
        route=None, frequency='bd', duration=None, status='current')
    med(d, 1, 'Tab Propranolol 40mg tds', name='Propranolol', strength='40mg', form='Tab', route=None,
        frequency='tds', duration=None, status='current')
    d.line(1, FOOTER)

    d.line(2, 'DEMO HOSPITAL - REFERRAL (continued) - page 2 of 2', 'title')
    d.line(2, 'Name: Peter Demo   Folder No: DH-TEST-1919')
    d.line(2, 'Recent vitals:', 'heading')
    n = d.line(2, 'BP 152/70   PR 118 b/min   Wt 61kg')
    d.item('vital', 2, [n], 'BP 152/70', measure='blood_pressure', value='152/70', unit=None)
    d.item('vital', 2, [n], 'PR 118 b/min', measure='pulse', value='118', unit='b/min')
    d.item('vital', 2, [n], 'Wt 61kg', measure='weight', value='61', unit='kg')
    d.line(2, 'Recent results:', 'heading')
    d.li(2, 'TSH: <0.01 mIU/L (0.4-4.0) L', 'lab_result', test='TSH', value='<0.01', unit='mIU/L',
         referenceRange='0.4-4.0', flag='L')
    d.li(2, 'Free T4: 48 pmol/L (12-22) H', 'lab_result', test='Free T4', value='48', unit='pmol/L',
         referenceRange='12-22', flag='H')
    d.li(2, 'FBS: 5.1 mmol/L (3.9-5.6)', 'lab_result', test='FBS', value='5.1', unit='mmol/L',
         referenceRange='3.9-5.6', flag=None)
    d.li(2, 'Thyroid USS: diffuse goitre, no nodules', 'note', text='Thyroid USS: diffuse goitre, no nodules')
    d.li(2, 'Refer to Endocrine Unit for specialist review', 'note',
         text='Refer to Endocrine Unit for specialist review')
    d.line(2, 'Yours faithfully, Dr R. Testperson')
    d.line(2, FOOTER)
    return d


def build_l020():
    """Handwritten vital signs chart: one vital per span, units only where written."""
    d = Doc('L020', 'L020-vitals_chart.jpg', 'image/jpeg', 'vitals_chart', 'handwritten', 1, 'hand')
    d.line(1, 'DEMO HOSPITAL', 'title')
    d.line(1, 'OBSERVATION / VITAL SIGNS CHART', 'heading')
    n1 = d.line(1, 'Name: Ngozi Testperson   Age: 40yrs   Sex: F')
    n2 = d.line(1, 'Folder No: DH-TEST-2020   Ward: Female Medical')
    d.set_identity(1, [n1, n2], 'Ngozi Testperson', '40yrs', 'DH-TEST-2020', 'F')
    d.line(1, 'Day 1: 10/11/2026')
    rows = [('06:00', '150/96', '104', '38.4', '24', None), ('10:00', '142/90', '98', '38.0', '22', '96%'),
            ('14:00', '138/88', '92', '37.6', '20', None), ('18:00', '136/84', '88', '37.4', '20', '98%'),
            ('22:00', '130/82', '86', '37.1', '18', None)]
    for hour, bp, p, t, rr, spo2 in rows:
        spans = [(f'BP {bp}', 'blood_pressure', bp, None), (f'P {p}', 'pulse', p, None),
                 (f'T {t}', 'temperature', t, None), (f'RR {rr}', 'respiratory_rate', rr, None)]
        if spo2:
            spans.append((f'SpO2 {spo2}', 'oxygen_saturation', spo2.rstrip('%'), '%'))
        n = d.line(1, f'{hour}  ' + '   '.join(span for span, *_ in spans))
        for span, measure, value, unit in spans:
            d.item('vital', 1, [n], span, measure=measure, value=value, unit=unit)
    d.li(1, 'Admission Wt 72kg', 'vital', 'Wt 72kg', measure='weight', value='72', unit='kg')
    d.li(1, 'Nurse note: Tepid sponging done at 06:00', 'note', 'Tepid sponging done at 06:00',
         text='Tepid sponging done at 06:00')
    med(d, 1, 'Tab Paracetamol 1g given 06:00', 'Tab Paracetamol 1g', name='Paracetamol', strength='1g', form='Tab',
        route=None, frequency=None, duration=None, status='current')
    d.line(1, 'Charted by: N. Samplenurse')
    d.line(1, FOOTER)
    return d


# ============================================================================================================
# Drawing for L004-L020

FONT_FILES = {'sans': 'PT_Sans-Web-Regular.ttf', 'sans_bold': 'PT_Sans-Web-Bold.ttf',
              'mono': 'CourierPrime-Regular.ttf', 'mono_bold': 'CourierPrime-Bold.ttf',
              'kalam': 'Kalam-Regular.ttf', 'indie': 'IndieFlower-Regular.ttf', 'patrick': 'PatrickHand-Regular.ttf'}


def font(name, size):
    return ImageFont.truetype(os.path.join(kit_dir(), 'fonts', FONT_FILES[name]), size)


# Per-document look: the handwriting font, ink and paper, and what the "scanner" did to the page.
STYLES = {
    'L004': dict(hand='indie', mode='RGB', paper=(250, 247, 236), ink=(25, 45, 140), effects=[]),
    'L005': dict(hand='patrick', mode='L', paper=(246,), ink=(30,), effects=['skew', 'blur', 'noise', 'specks']),
    'L006': dict(mode='L', paper=(255,), ink=(0,), effects=[]),
    'L007': dict(mode='L', paper=(238,), ink=(125,), effects=['blur', 'light_noise']),
    'L008': dict(hand='kalam', mode='L', paper=(242,), ink=(140,), effects=['blur', 'light_noise']),
    'L009': dict(mode='L', paper=(212,), ink=(12,), effects=['skew', 'blur', 'noise', 'specks', 'edge']),
    'L010': dict(mode='L', paper=(255,), ink=(0,), effects=[]),
    'L011': dict(mode='L', paper=(236,), ink=(130,), effects=['blur', 'light_noise']),
    'L012': dict(effects=[]),  # born-digital PDF
    'L013': dict(hand='patrick', mode='RGB', paper=(248, 248, 240), ink=(20, 20, 30), effects=[]),
    'L014': dict(mode='L', paper=(244,), ink=(20,), effects=['skew', 'blur', 'noise', 'specks', 'edge']),
    'L015': dict(effects=[]),  # born-digital PDF
    'L016': dict(mode='L', paper=(236,), ink=(135,), effects=['blur', 'light_noise']),
    'L017': dict(hand='kalam', mode='L', paper=(240,), ink=(35,), effects=['skew', 'blur', 'noise', 'specks']),
    'L018': dict(mode='L', paper=(255,), ink=(0,), effects=[]),
    'L019': dict(mode='L', paper=(226,), ink=(15,), effects=['skew', 'blur', 'noise', 'specks', 'edge']),
    'L020': dict(hand='indie', mode='RGB', paper=(250, 250, 244), ink=(20, 30, 120), effects=['slight_skew']),
}

SIZES = {'title': 40, 'heading': 30, 'body': 28, 'mono': 25, 'hand': 36, 'small': 22}


def role_font(style, role, scale):
    size = max(16, int(SIZES[role] * scale))
    if role == 'title':
        return font('sans_bold', size)
    if role == 'heading':
        return font('sans_bold', size)
    if role == 'mono':
        return font('mono', size)
    if role == 'hand':
        return font(style['hand'], size)
    return font('sans', size)


def layout(lines, roles, style, rng):
    """[(text, role, font, x, y, angle)], shrinking every size until the page fits above the footer."""
    scale = 1.0
    while True:
        placed, y = [], 70
        for text, role in zip(lines, roles):
            if role == 'footer':
                placed.append((text, role, font('sans', 20), 70, H - 70, 0.0))
                continue
            f = role_font(style, role, scale)
            x = 70 + (30 if role in ('body', 'hand', 'mono', 'small') else 0)
            while f.getlength(text) > W - x - 60 and f.size > 14:
                f = f.font_variant(size=f.size - 1)
            angle = 0.0
            if role == 'hand':
                x += rng.randint(-8, 14)
                angle = rng.uniform(-1.3, 1.3)
            if role == 'heading':
                y += 8
            placed.append((text, role, f, x, y + (rng.randint(-3, 4) if role == 'hand' else 0), angle))
            y += int(f.size * (1.55 if role != 'mono' else 1.45))
        if y <= H - 110:
            return placed
        scale -= 0.04


def draw_raster_page(doc, index, style, rng):
    lines, roles = doc.pages[index], doc.roles[index]
    mode = style['mode']
    paper = style['paper'] if mode == 'RGB' else style['paper'][0]
    img = Image.new(mode, (W, H), paper)
    for text, role, f, x, y, angle in layout(lines, roles, style, rng):
        left, top, right, bottom = f.getbbox(text)
        mask = Image.new('L', (int(right - left) + 16, int(bottom - top) + 16), 0)
        ImageDraw.Draw(mask).text((8 - left, 8 - top), text, font=f, fill=255)
        if angle:
            mask = mask.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
        if role == 'hand':
            ink = style['ink']
        elif mode == 'RGB':
            ink = (25, 25, 25)
        else:
            ink = style['ink'] if 'light_noise' in style['effects'] else (min(style['ink'][0], 40),)
            if role == 'footer':
                ink = (max(ink[0], 70),) if 'light_noise' not in style['effects'] else ink
        color = ink if mode == 'RGB' else ink[0]
        img.paste(Image.new(mode, mask.size, color), (int(x), int(y)), mask)
    return degrade(img, style, rng)


def add_noise(img, rng, strength):
    noise = Image.frombytes('L', img.size, rng.randbytes(img.size[0] * img.size[1]))
    noise = noise.point(lambda v: v * strength // 255)
    if img.mode == 'RGB':
        noise = Image.merge('RGB', (noise, noise, noise))
    return ImageChops.subtract(img, noise)


def degrade(img, style, rng):
    effects = style['effects']
    fill = style['paper'] if img.mode == 'RGB' else style['paper'][0]
    if 'skew' in effects:
        img = img.rotate(rng.choice([-1, 1]) * rng.uniform(1.2, 2.8), resample=Image.Resampling.BICUBIC,
                         fillcolor=fill)
    if 'slight_skew' in effects:
        img = img.rotate(rng.choice([-1, 1]) * rng.uniform(0.5, 1.0), resample=Image.Resampling.BICUBIC,
                         fillcolor=fill)
    if 'blur' in effects:
        img = img.filter(ImageFilter.GaussianBlur(0.75))
    if 'noise' in effects:
        img = add_noise(img, rng, 22)
    if 'light_noise' in effects:
        img = add_noise(img, rng, 9)
    if 'specks' in effects:
        g = ImageDraw.Draw(img)
        for _ in range(400):
            cx, cy = rng.randrange(W), rng.randrange(H)
            r = rng.choice([1, 1, 2, 3])
            g.ellipse([cx, cy, cx + r, cy + r], fill=rng.randint(50, 140))
    if 'edge' in effects:
        ImageDraw.Draw(img).rectangle([0, 0, rng.randint(8, 20), H], fill=55)
    return img


def save_raster(doc, style, path, rng):
    pages = [draw_raster_page(doc, i, style, rng) for i in range(len(doc.pages))]
    if doc.media == 'image/png':
        assert len(pages) == 1
        img = pages[0]
        buf = io.BytesIO()
        img.save(buf, format='PNG', optimize=True)
        if buf.tell() > MAX_BYTES and img.mode == 'RGB':
            buf = io.BytesIO()
            img.quantize(colors=128, method=Image.Quantize.MEDIANCUT).save(buf, format='PNG', optimize=True)
        with open(path, 'wb') as out:
            out.write(buf.getvalue())
    elif doc.media == 'image/jpeg':
        assert len(pages) == 1
        img = pages[0]
        for quality in (72, 62, 52, 42):
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=quality, optimize=True)
            if buf.tell() <= MAX_BYTES:
                break
        with open(path, 'wb') as out:
            out.write(buf.getvalue())
    else:
        first, rest = pages[0], pages[1:]
        for quality in (60, 50, 40):
            buf = io.BytesIO()
            first.save(buf, format='PDF', save_all=True, append_images=rest, resolution=150, quality=quality,
                       title='Fictional test document', author='lekan-first-pass',
                       creationDate=FIXED_DATE, modDate=FIXED_DATE)
            if buf.tell() <= MAX_BYTES:
                break
        with open(path, 'wb') as out:
            out.write(buf.getvalue())


def save_typed_pdf(doc, path, rng):
    """Born-digital PDF: real text drawn with the kit's own fonts, laid out as the raster pages."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    for name, file in FONT_FILES.items():
        if f'lk-{name}' not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(f'lk-{name}', os.path.join(kit_dir(), 'fonts', file)))
    by_file = {file: name for name, file in FONT_FILES.items()}
    c = canvas.Canvas(path, pagesize=A4, invariant=1, pageCompression=1)
    c.setTitle('Fictional test document')
    scale = A4[0] / W
    style = {'hand': 'kalam'}
    for lines, roles in zip(doc.pages, doc.roles):
        for text, role, f, x, y, _ in layout(lines, roles, style, rng):
            ascent, _ = f.getmetrics()
            c.setFont(f'lk-{by_file[os.path.basename(f.path)]}', f.size * scale)
            c.setFillGray(0.3 if role == 'footer' else 0.05)
            c.drawString(x * scale, A4[1] - (y + ascent) * scale, text)
        c.showPage()
    c.save()


FIXED_DATE = __import__('time').strptime('2026-11-11', '%Y-%m-%d')


def draw_generic(doc, path):
    rng = random.Random(int(doc.doc_id[1:]) * 7919)
    style = STYLES[doc.doc_id]
    if doc.media == 'application/pdf' and doc.difficulty == 'clean_typed':
        save_typed_pdf(doc, path, rng)
    else:
        save_raster(doc, style, path, rng)


BUILDERS = [(build_l001, draw_l001), (build_l002, draw_l002), (build_l003, draw_l003)] + [
    (b, draw_generic) for b in (build_l004, build_l005, build_l006, build_l007, build_l008, build_l009, build_l010,
                                build_l011, build_l012, build_l013, build_l014, build_l015, build_l016, build_l017,
                                build_l018, build_l019, build_l020)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', default=HERE, help='the set folder (default: the folder this script is in)')
    args = ap.parse_args()
    docs_dir = os.path.join(args.set, 'documents')
    keys_dir = os.path.join(args.set, 'keys')
    os.makedirs(docs_dir, exist_ok=True)
    os.makedirs(keys_dir, exist_ok=True)
    built = [(build(), draw) for build, draw in BUILDERS]
    wanted = {doc.file for doc, _ in built}
    for name in os.listdir(docs_dir):  # drop files from an earlier naming so the folder matches the keys
        if name not in wanted:
            os.remove(os.path.join(docs_dir, name))
    with open(os.path.join(keys_dir, 'keys.jsonl'), 'w', encoding='utf-8', newline='\n') as out:
        for doc, draw in built:
            for lines in doc.pages:
                assert lines.count(FOOTER) == 1, doc.doc_id
            for item in doc.items:
                assert item['fields'].get('status') != 'stopped' or item['prescription'] is None
            path = os.path.join(docs_dir, doc.file)
            draw(doc, path)
            size = os.path.getsize(path)
            assert size <= MAX_BYTES, (doc.file, size)
            out.write(json.dumps(doc.key(), ensure_ascii=True, separators=(',', ':')) + '\n')
    for doc, _ in built:
        print(doc.file, os.path.getsize(os.path.join(docs_dir, doc.file)), 'bytes')


if __name__ == '__main__':
    main()
