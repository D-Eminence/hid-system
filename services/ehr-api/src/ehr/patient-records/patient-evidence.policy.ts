import { evidence, type Evidence, type OriginHint, type SourceKind } from './patient-evidence.types';

/**
 * The patient chat's second layer of protection. The patient evidence query
 * (PATIENT_EVIDENCE_QUERY) already leaves these rows and fields out; this
 * policy runs over every record of the patient's snapshot (local records, Lab
 * results and documents) before any of it reaches the AI, the search index,
 * saved history or the source viewer, so a query regression or an older Lab
 * image still cannot leak. Each kept record is rebuilt with evidence(), so its
 * content and hash cover only the cleaned data. It is never applied to the
 * staff chat, which keeps full access to its one patient.
 */

/** The text a Lab result being corrected carries instead of its values. */
export const LAB_CORRECTING = 'The lab is correcting this result.';

export interface PatientProfileInput {
  firstName?: unknown; lastName?: unknown; fullName?: unknown; dateOfBirth?: unknown; gender?: unknown;
}

const ALLOWED_ORDER_STATUSES = new Set(['active', 'on_hold', 'completed']);
export const VITAL_FIELDS = ['recorded_at', 'height_cm', 'weight_kg', 'temperature_c', 'pulse_bpm', 'respiratory_rate',
  'systolic_mmhg', 'diastolic_mmhg', 'oxygen_saturation_percent', 'source'] as const;
const LAB_VALUE_FIELDS = ['resultType', 'numericValue', 'textValue', 'unit', 'referenceRange', 'recordedFlag', 'revisionKind', 'releasedAt', 'verification'];

/**
 * The fields each kind may carry to the patient chat. Kinds not listed keep
 * their fields as today, less any internal (`_`-prefixed) key.
 */
export const PATIENT_FIELDS: Partial<Record<SourceKind, readonly string[]>> = {
  note: ['noteType', 'text', 'signedAt'],
  encounter: ['type', 'startedAt', 'endedAt', 'status'],
  diagnosis: ['codeSystem', 'code', 'condition', 'clinicalStatus', 'verificationStatus', 'onsetAt', 'abatementAt'],
  prescription: ['medication', 'doseQuantity', 'doseUnit', 'route', 'frequency', 'startsOn', 'endsOn', 'status'],
  investigation: ['test', 'codeSystem', 'code', 'status'],
  vital: VITAL_FIELDS,
  lab_result: ['test', 'codeSystem', 'code', 'specimen', 'resultType', 'numericValue', 'textValue', 'unit', 'referenceRange',
    'recordedFlag', 'revisionKind', 'collectedAt', 'releasedAt', 'verification', 'correctionPending', 'status'],
  profile: ['ageYears', 'sex'],
};

/**
 * Free text written by people, the only fields identifiers are removed from.
 * Codes, test and medicine names, units and dates are never rewritten.
 */
const FREE_TEXT_FIELDS: Partial<Record<SourceKind, readonly string[]>> = {
  note: ['text'], document: ['text'], attachment: ['text'],
  import: ['record', 'notes', 'structuredData', 'transcriptionText'],
  import_version: ['record', 'notes', 'structuredData', 'transcriptionText'],
  health_profile: ['medical_notes', 'medicalNotes'],
};
const FREE_TEXT_TITLES = new Set<SourceKind>(['note', 'import', 'import_version']);

/*
 * Sensitive tests, conditions and medicines (S4). Until the clinician
 * "Discussed with the patient" mark exists, these are left out of the patient
 * chat outright: hiding is the safe direction. The list is a default for Ola
 * to approve (D7, D10). Fragments use only syntax that means the same in a
 * JavaScript RegExp and a PostgreSQL ARE (letters, digits, [], [^], ?, *, +,
 * {m,n}, |, (?:), and one look-ahead, (?!ydophila)), so the SQL filter and
 * this policy agree. The condition and medicine lists, read only here, keep
 * to the same syntax. They never contain a quote or a backslash.
 */
/*
 * The initialisms of the test list. Each is also matched however its letters
 * are set apart: by dots, hyphens, spaces or any other mark, or by nothing
 * ("R.V.S.", "C.D.4", "H-I-V", "V D R L"). dottedInitialism makes that form,
 * and initialismForm lets only digits follow it ("H.I.V1", "C.D.4 count").
 * Letters after a set-apart form are not read, so "Hb value", "Hb (venous)",
 * "HC volume" and "HS vWF" are shown: they are not H-B-V, H-C-V or H-S-V.
 * Only the plain fragments below take letters ("HIVAb", "CD4count"), so
 * "C.D4count" is shown. Ola's call as clinical owner (#258, 26 and 27 Nov
 * 2026). RVST (retroviral screening test) and PMTCT, as a test name, joined
 * the list in Ola's second list of 27 Nov. SGBV and GBV (sexual and
 * gender-based violence) and GNID (Gram-negative intracellular diplococci,
 * gonorrhoea on a Gram stain) joined in Ola's fourth list. lab-api's copy
 * (patient-results.service.ts) makes the forms the same way from the same
 * list, so the test pattern stays one string in both.
 */
export const SENSITIVE_TEST_INITIALISMS = [
  'hiv', 'aids', 'rvs', 'rvst', 'cd4', 'vl', 'hbv', 'hcv', 'hsv', 'hpv', 'vdrl', 'rpr', 'tpha', 'sti', 'std', 'hcg', 'bhcg', 'upt',
  'psa', 'afp', 'cea', 'phq', 'brca', 'pmtct', 'gbv', 'sgbv', 'gnid',
] as const;
/** An initialism with any run of marks that are not letters or digits, or none, between its letters: 'rvs' gives 'r[^a-z0-9]*v[^a-z0-9]*s'. */
export const dottedInitialism = (letters: string): string => [...letters].join('[^a-z0-9]*');
/** dottedInitialism, then digits only: 'hiv' gives 'h[^a-z0-9]*i[^a-z0-9]*v[0-9]*'. */
export const initialismForm = (letters: string): string => `${dottedInitialism(letters)}[0-9]*`;
/*
 * The test list. It is also read in a diagnosis's name (SENSITIVE_CONDITION
 * below). Where a name has two or more parts, any run of marks that are not
 * letters or digits may set them apart, or none: '[^a-z0-9]*' ("Viral load",
 * "Viral-Load", "CA 19-9", "CA.19.9", "Hep B/C", "HBs Ag", "Tumour-markers").
 * A plain initialism may take a plural s ("STIs", "VLs").
 */
export const SENSITIVE_TEST_FRAGMENTS = [
  // "Anti" or "rapid" may be glued to HIV or HCV ("AntiHIV", "RapidHCV"), and a kit's name to HIV ("UnigoldHIV"). Each
  // is listed by name, never as '[a-z]*hiv', which would hide "Archive".
  '(?:anti|rapid)?hiv[a-z0-9]*', '(?:unigold|statpak|oraquick|determine)hiv[a-z0-9]*', 'aids', 'rvs', 'retro[^a-z0-9]*vir[a-z]*',
  'cd[^a-z0-9]*4[a-z0-9]*', 'viral[^a-z0-9]*loa?ds?',
  'hepatit[a-z]*', 'hbsag', 'hbe[^a-z0-9]*ag', 'anti[^a-z0-9]*hbc', 'hbc[^a-z0-9]*ab', 'hbv[a-z]*', '(?:anti|rapid)?hcv[a-z]*',
  // 'chlam' is not read in "Chlamydophila", a cause of pneumonia: '(?!ydophila)' looks ahead, the same in SQL as here.
  'syph[a-z]*', 'vdrls?', 'rprs?', 'tphas?', 'treponem[a-z]*', 'chlam(?!ydophila)[a-z]*', 'gonor[a-z]*', 'gonococc[a-z]*',
  'herpes', 'hsv[a-z0-9]*', 'trich?omon[a-z]*', 'stis?', 'stds?',
  '(?:beta|b|urine|serum)?hcgs?', 'upts?',
  '[ft]?psas?', 'afps?', 'ceas?', 'ca[^a-z0-9]*125', 'ca[^a-z0-9]*19[^a-z0-9]*9', 'ca[^a-z0-9]*15[^a-z0-9]*3', 'tumou?r[^a-z0-9]*markers?',
  // Pap smear: a Pap or Paps smear or test with any marks or none between ("Paps smear", "PAPS-test"), Papanicolaou, and
  // "Pap" alone, in tests and diagnoses ("Abnormal Pap", "Pap: ASCUS"; Ola's fifth list, #258, 27 Nov 2026). "Paps"
  // alone is a test word only (the list below): in a diagnosis, PAPS is primary antiphospholipid syndrome and PAPs the
  // pulmonary artery pressures (Ola's fourth list).
  'biops[a-z]*', 'histolog[a-z]*', 'histopath[a-z]*', 'cytolog[a-z]*', 'paps?[^a-z0-9]*(?:smears?|tests?)', 'papanicolaou[a-z]*',
  'pap',
  'karyotyp[a-z]*', 'brca[0-9]*s?', 'genetic[a-z]*', 'genotyp[a-z]*',
  'phq[^a-z0-9]*[0-9]*', 'gad[^a-z0-9]*[27]', 'psych[a-z]*',
  // GAD only as the anxiety scales GAD-2 and GAD-7 ("G.A.D.-7"): a 2 or 7 with no digit after it. Plain "GAD", "GAD65"
  // and "Anti-GAD65 antibody" are diabetes antibody tests and stay shown, so 'gad' is not in the initialisms above.
  'g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[27]',
  // Shorthand as clinicians write it: VL (viral load); Hb electrophoresis is the genotype test.
  'vls?', 'hb[^a-z0-9]*electrophoresis', 'ha?emoglobin[^a-z0-9]*electrophoresis',
  // The same tests written out in full, as LOINC display names and lab menus write them.
  'prostate[^a-z0-9]*specific', '[a-z]*fetoprotein', 'carcino[^a-z0-9]*embryonic', 'cancer[^a-z0-9]*(?:ag|antigen|screen[a-z]*)',
  'chorionic', 'choriogonadotrop[a-z]*', 'human[^a-z0-9]*immuno[^a-z0-9]*deficiency',
  // Hep A to Hep E, with any marks or none ("Hep A", "Hep-B", "HepC", "Hep. B s Ag").
  'hep[^a-z0-9]*[abcde](?:[^a-z0-9]*[sec])?(?:[^a-z0-9]*a[gb])?',
  'hbs[^a-z0-9]*ag',
  // HIV rapid-test kits named alone: Determine, Uni-Gold and Stat-Pak are the three tests of Nigeria's serial HIV
  // algorithm, and OraQuick is sold for self-testing. A facility's own test is ordered by its name only (0155), so
  // its name is all that can hide it. A false match hides a test the patient could have seen: the safe side.
  // "Determine" may run on into letters or digits ("DetermineHIV"); the two parts of the other names may be set apart
  // by any marks or none ("Uni.Gold", "Stat-Pak", "Ora Quick", "UniGold"), and "Stat Pack" is a common misspelling.
  'determine[a-z0-9]*', 'uni[^a-z0-9]*gold', 'stat[^a-z0-9]*pac?k', 'ora[^a-z0-9]*quick',
  // Names that were missed (Ola, #258, 27 Nov 2026). Hepatitis B markers:
  'hbs[^a-z0-9]*ab', 'anti[^a-z0-9]*hbs', 'hbe[^a-z0-9]*ab', 'anti[^a-z0-9]*hbe', 'hbc[^a-z0-9]*igm', 'hbc[^a-z0-9]*ag',
  // Syphilis (TPPA, T. pallidum, FTA-ABS), chlamydia and gonorrhoea together (CT/NG, NG/CT, CT/GC, GC/CT), and HPV.
  // TP-PA takes only a space, dot or hyphen, so "TP & PA" and "TP/PA", two tests side by side, are shown:
  'tppas?', 'tp[ .-]?pa', 't[^a-z0-9]*pallidum', 'fta[^a-z0-9]*abs', 'ct[^a-z0-9]*(?:ng|gc)', '(?:ng|gc)[^a-z0-9]*ct',
  'hpv[a-z0-9]*',
  // Cancer pathology (FNA, FNAC, IHC, ER/PR, HER2 or HER2neu, frozen section) and tumour markers written out (alpha
  // feto, foeto or foto protein):
  'fnac?s?', 'ihcs?', 'er[^a-z0-9]*pr', 'her[^a-z0-9]*2(?:[^a-z0-9]*neu)?', 'frozen[^a-z0-9]*sections?',
  'alpha[^a-z0-9]*fo?e?to[^a-z0-9]*proteins?', 'ca[^a-z0-9]*72[^a-z0-9]*4',
  // HIV programme tests: early infant diagnosis (EID), recency testing, and the Double Check Gold and INSTI kits:
  'eids?', 'recency', 'double[^a-z0-9]*check[^a-z0-9]*gold', 'insti',
  // Panels that include these tests, drug screens and paternity tests. An antenatal, prenatal, ANC, booking or
  // obstetric panel may have up to three words between its first and last words ("ANC booking profile", "Antenatal
  // care panel"), each set apart by marks; with none between, the two may run together ("Bookingbloods").
  'pre[^a-z0-9]*marital',
  '(?:(?:ante|pre)[^a-z0-9]*natal|anc|booking|obstetric[a-z]*)(?:[^a-z0-9]+(?:[a-z0-9]+[^a-z0-9]+){0,3})?'
    + '(?:profiles?|panels?|screen[a-z]*|tests?|investigations?|labs?|bloods?|booking)',
  'drugs?[^a-z0-9]*(?:(?:of[^a-z0-9]*)?abuse(?:[^a-z0-9]*(?:screen[a-z]*|panels?))?|screen[a-z]*)', 'urine[^a-z0-9]*drug[a-z]*', 'paternity',
  // Ola's second list (#258, 27 Nov 2026). First, every name of a national lab test that the list already hid by
  // another of its names: bone marrow aspirate (BMA), "Cervical smear" (and cervical screening) and the LOINC name
  // "... in Cervix by Cyto stain" (Pap smear), the TORCH screen (its herpes antibodies) and "T helper cell count" (CD4).
  // "Serum PT" and the sickling tests are in the test-only list below.
  // Bone marrow (or BM) aspirate, aspiration, trephine or biopsy: Ola's third list (#258, 27 Nov 2026). BMAT (aspirate
  // and trephine) and BMB (biopsy): Ola's fourth list.
  '(?:bone[^a-z0-9]*marrow|bm)[^a-z0-9]*(?:aspirat[a-z]*|trephines?|biops[a-z]*)', 'bmas?', 'bmats?', 'bmbs?',
  'cervi(?:cal|x)[^a-z0-9]*(?:smears?|screen[a-z]*)', 'cyto[^a-z0-9]*stain[a-z]*', 'torch', 't[^a-z0-9]*helper',
  // A wet mount or prep is hidden only when it is vaginal (for Trichomonas), Ola's third list: vaginal, HVS or high
  // vaginal (swab) just before it, a saline or KOH wet mount too ("HVS saline wet prep"); vaginal or HVS one or two
  // words before it ("HVS for wet prep", "Vaginal swab wet mount"); or vaginal or HVS after it, up to two words on
  // ("Wet mount (HVS)", "Wet prep of high vaginal swab"). TV (Trichomonas vaginalis) counts as vaginal here, so "TV
  // wet mount" and "Wet prep for TV" stay hidden. A stool, urine, skin, semen or KOH wet mount is shown, and so are
  // "Wet mount", "Wet prep" and "Saline wet mount" alone, which do not say where the sample is from.
  '(?:vaginal|hvs|high[^a-z0-9]*vaginal(?:[^a-z0-9]*swab)?)[^a-z0-9]*(?:(?:saline|koh)[^a-z0-9]*)?wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  '(?:vaginal|hvs|tv)(?:[^a-z0-9]+[a-z]+){1,2}[^a-z0-9]+wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  'tv[^a-z0-9]*wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  'wet[^a-z0-9]*(?:mount|prep[a-z]*)(?:[^a-z0-9]+[a-z]+){0,2}[^a-z0-9]+(?:vaginal|hvs|tv)',
  // Hepatitis misspelt ("Hepititis", "Heptitis", "Hepatatis", but not "Hepatic"); hepatitis A, D and E ("HAV",
  // "anti-HEV", "HDV Ag", "Hep D", "Hep-E"); HBs and HBe antigens set apart ("Hb s Ag", "HBe Ag"), and "Australia antigen".
  'hep[a-z]{0,3}t[aiy]t[aiy]s', '(?:anti)?h[ade]v(?:ab|ag|igg|igm|rna)?', 'hb[^a-z0-9]*s[^a-z0-9]*ag',
  'australia[^a-z0-9]*(?:antigen|ag)',
  // HIV: "H1V" and "HlV" typed for HIV, retro screening or test, p24 antigen, Western blot, LAg avidity, infant DNA PCR,
  // and CrAg and TB-LAM or LF-LAM, which are done almost only in advanced HIV disease, with the other names of those
  // two national tests (LAB-0148 "Cryptococcal antigen", "Cryptococcus sp Ag"; LAB-0034 "Lipoarabinomannan test").
  'h[1l]v[a-z0-9]*', 'retro[^a-z0-9]*(?:screen[a-z]*|tests?)', 'p[^a-z0-9]*24[^a-z0-9]*(?:antigen|ag)', 'western[^a-z0-9]*blots?',
  'lag[^a-z0-9]*avidity', 'infant[^a-z0-9]*dna[^a-z0-9]*pcr', 'cr[^a-z0-9]*ags?', '(?:tb|lf)[^a-z0-9]*lam',
  'cryptococ[a-z]*(?:[^a-z0-9]+[a-z]+)?[^a-z0-9]+(?:antigen|ag)', 'lipoarabinomannan',
  // More advanced HIV disease tests (Ola's third list): AlereLAM and urine LAM ("LAM" alone is in the test-only list);
  // crypto Ag or antigen ("Serum crypto Ag") and CSF crypto...; India ink, LAB-0087 by all its names ("CSF India ink",
  // "India ink for Cryptococcus"). "Cryptosporidium antigen" is shown: crypto must stand apart from the next word.
  '(?:alere|urine)[^a-z0-9]*lam', 'crypto[^a-z0-9]*(?:antigen|ag)', 'csf[^a-z0-9]*crypto[a-z]*', 'india[^a-z0-9]*ink',
  // Other STIs: syphilis misspelt ("Siphilis", "Sifilis"), venereal, a VD screen, GC culture, C. trachomatis,
  // T. vaginalis, human papilloma virus written out, "Clamydia" (Ola's third list) and "Clamidia", and a urethral
  // swab, with any words after it ("Urethral swab for Gram stain"; Ola's fourth list). Ola's fifth list: "Klamydia", a
  // urethral discharge or smear, with any words after it ("Urethral discharge M/C/S"), and a TV antigen ("TV Ag").
  's[iy][pf]h?[iy]l[a-z]*', 'vener[a-z]*', 'v[^a-z0-9]*d[^a-z0-9]*screen[a-z]*', 'gc[^a-z0-9]*cultures?', 'clam[iy]d[a-z]*',
  'klamyd[a-z]*', 'urethral[^a-z0-9]*swabs?', 'urethral[^a-z0-9]*(?:discharges?|smears?)', 'tv[^a-z0-9]*(?:antigen|ag)',
  '(?:c[^a-z0-9]*)?trachomatis', 't[^a-z0-9]*vaginalis', 'human[^a-z0-9]*papilloma[^a-z0-9]*vir[a-z]*',
  // Pregnancy screening: NIPT, the triple and quadruple tests, PAPP-A.
  'nipts?', 'triple[^a-z0-9]*tests?', 'quad(?:ruple)?[^a-z0-9]*(?:screen[a-z]*|tests?)', 'papp[^a-z0-9]*a',
  // Cancer: immunohistochemistry, fine needle aspiration, hormone receptors (oestrogen, progesterone, ER status), Ki-67,
  // CA 27.29, cytopathology, BCR-ABL, Bence Jones protein (and BJP), cell block, liquid-based cytology (LBC), cancer and
  // malignancy screens. Flow cytometry alone is not hidden: it also counts reticulocytes and platelets (Ola's third list).
  'immuno[^a-z0-9]*histochem[a-z]*', 'fine[^a-z0-9]*needle[^a-z0-9]*aspirat[a-z]*', 'o?estrogen[^a-z0-9]*receptors?',
  'progesterone[^a-z0-9]*receptors?', 'hormone[^a-z0-9]*receptors?[^a-z0-9]*status', 'er[^a-z0-9]*status', 'ki[^a-z0-9]*67',
  'ca[^a-z0-9]*27[^a-z0-9]*29', 'cytopath[a-z]*', 'bcr[^a-z0-9]*abl[0-9]*',
  'bence[^a-z0-9]*jones?', 'bjps?', 'cell[^a-z0-9]*blocks?', 'lbcs?', 'malignan[a-z]*[^a-z0-9]*screen[a-z]*',
  // Cervical cancer screening by VIA: VIA/VILI, VIA and VILI, VILI, and a VIA screen. VIA alone, and "Glucose via test
  // strip", are shown. Written out (Ola's fourth list): visual inspection (with) acetic acid or Lugol's iodine. The "s"
  // of Lugol's comes after its own marks or not at all, so a long run of marks stays fast (Ola's fifth list). Also from
  // the fifth list: VIAA, colposcopy, and the cervical sample kits ThinPrep and SurePath.
  'via[^a-z0-9]*(?:and[^a-z0-9]*)?vili', 'vili', 'via[^a-z0-9]*screen[a-z]*', 'viaa', 'colposcop[a-z]*', 'thin[^a-z0-9]*prep',
  'sure[^a-z0-9]*path',
  'visual[^a-z0-9]*inspection[^a-z0-9]*(?:with[^a-z0-9]*)?(?:acetic[^a-z0-9]*acid|lugol(?:[^a-z0-9]*s)?[^a-z0-9]*iodine)',
  // Ola's third list (#258, 27 Nov 2026). Tumour markers: HE4, ROMA, NSE, Cyfra 21-1, SCC antigen, CA 242,
  // chromogranin (A), immunophenotyping, a leukaemia or lymphoma panel, free light chains. Beta-2 microglobulin is shown.
  // The same written out, and more (Ola's fourth list): neuron-specific enolase, squamous cell carcinoma antigen,
  // cytokeratin 19 fragment, free kappa or lambda (ratio, light chains), a leukaemia or lymphoma screen. Ola's fifth
  // list: the kappa/lambda ratio, SPEP (serum protein electrophoresis) and immunofixation, the myeloma tests.
  'he[^a-z0-9]*4', 'roma', 'nse', 'cyfra(?:[^a-z0-9]*21[^a-z0-9]*1)?', 'scc[^a-z0-9]*(?:antigen|ag)', 'ca[^a-z0-9]*242',
  'chromogranin(?:[^a-z0-9]*a)?', 'immuno[^a-z0-9]*phenotyp[a-z]*', '(?:leuka?emia|lymphoma)[^a-z0-9]*(?:panels?|screen[a-z]*)',
  'free[^a-z0-9]*light[^a-z0-9]*chains?', 'neurone?[^a-z0-9]*specific[^a-z0-9]*enolase',
  'squamous[^a-z0-9]*cell[^a-z0-9]*carcinoma[^a-z0-9]*(?:antigen|ag)', 'cytokeratin[^a-z0-9]*19[^a-z0-9]*fragments?',
  'free[^a-z0-9]*(?:kappa|lambda)', 'kappa[^a-z0-9]*lambda[^a-z0-9]*ratios?', 'spep', 'immuno[^a-z0-9]*fixation',
  // HIV programme tests: PrEP labs, screening, monitoring or baseline (never "prep" alone, so "KOH prep" is shown); ART
  // (baseline) monitoring or labs, and ART baseline (tests); HAART monitoring; PEP labs or baseline; HTS, VCT and PITC
  // (HIV testing services, counselling and testing) as whole words. "ART baseline" alone, "HAART monitoring" and "PEP
  // labs" are Ola's fifth list.
  'prep[^a-z0-9]*(?:labs?|screen[a-z]*|monitoring|baseline)',
  'art[^a-z0-9]*(?:(?:baseline[^a-z0-9]*)?(?:monitoring|labs?)|baseline(?:[^a-z0-9]*tests?)?)', 'haart[^a-z0-9]*monitoring',
  'pep[^a-z0-9]*(?:labs?|baseline)',
  'hts', 'vct', 'pitc',
  // Relationship and assault tests: maternity (DNA) tests, sibling and kinship DNA tests, rape kit, forensic swabs. And,
  // in tests and diagnoses (Ola's fourth list): sexual assault, abuse or violence ("Child sexual abuse"); rape, raped or
  // rapes as whole words ("Grape juice" and "Rapeseed oil" are shown). SGBV and GBV are in the initialisms.
  'maternity[^a-z0-9]*(?:dna(?:[^a-z0-9]*tests?)?|tests?)', 'sibling[^a-z0-9]*dna', 'dna[^a-z0-9]*(?:relationship|kinship)',
  'kinship[^a-z0-9]*(?:dna|tests?|analysis)', 'sexual[^a-z0-9]*(?:assaults?|abuse|violence)', 'rape[^a-z0-9]*kits?', 'rape[sd]?',
  'forensic[^a-z0-9]*swabs?',
  // Ola's fifth list, in tests and diagnoses: sexual assaults, sexually assaulted or abused, an assault that is sexual
  // ("Assault (sexual)"), indecent assault, defiled and defilement (defile...), sodomy (sodom...), unlawful carnal
  // knowledge, incest, molestation (molest...), (sexual and) gender-based violence, intimate partner violence,
  // domestic violence, a semen detection test; DSH (deliberate self-harm) and MDD (major depressive disorder) as
  // plain initialisms.
  'sexually[^a-z0-9]*(?:assaulted|abused)', 'assaults?[^a-z0-9]*sexual', 'indecent[^a-z0-9]*assaults?', 'defile[a-z]*', 'sodom[a-z]*',
  'unlawful[^a-z0-9]*carnal[^a-z0-9]*knowledge', 'incest(?:uous)?', 'molest[a-z]*', 'gender[^a-z0-9]*based[^a-z0-9]*violence',
  'intimate[^a-z0-9]*partner[^a-z0-9]*violence', 'domestic[^a-z0-9]*violence', 'semen[^a-z0-9]*detection', 'dsh', 'mdd',
  // The initialisms above in every form ("H.I.V", "C.D.4", "H-I-V1", "V D R L"): initialismForm.
  ...SENSITIVE_TEST_INITIALISMS.map(initialismForm),
] as const;
/*
 * Test wording only. These join the test pattern after the list above but are
 * never read in a diagnosis's name: SENSITIVE_CONDITION is built from
 * SENSITIVE_TEST_FRAGMENTS and the condition list, not from these. So a
 * patient's own "Sickle cell disease" is judged as before (it is shown), while
 * the genotype tests are hidden. A pregnancy test is hidden by "preg" as a
 * word ("Preg test"), by pregnan... and by its misspellings ("Pregancy",
 * "Prenancy", "Pragnancy"), but "Pregnenolone" and "Pregabalin level" are
 * shown; the condition list has 'pregnan[a-z]*' and the misspellings too. A
 * medicine is never read with the test pattern, so "Pregabalin" as a
 * prescription is judged by the medicine list alone.
 */
const SENSITIVE_TEST_ONLY_FRAGMENTS = [
  // Pregnancy tests, and "Serum PT" or "Urine PT" (LAB-0027, and a urine pregnancy test). "PT" alone is shown: to every
  // clinician it is prothrombin time ("PT/INR", "PT & APTT", "Clotting screen: PT, APTT"), though the national code
  // list also gives it as another name of the urine pregnancy test, LAB-0080 (Ola's third list, #258, 27 Nov 2026).
  'preg', 'pregnan[a-z]*', 'pr[ae]g?n?[ae]n?cy[a-z]*', '(?:serum|urine)[^a-z0-9]*p[^a-z0-9]*t',
  // LAM alone, as a test name, is the urine TB LAM test of advanced HIV disease. In a diagnosis it means other things
  // (the lactational amenorrhoea method of family planning), so it is a test word only. So is "Paps" alone ("PAPs"): in
  // a diagnosis it can be primary antiphospholipid syndrome or the pulmonary artery pressures. "Pap" alone is in the
  // shared list above (Ola's fifth list).
  'lam', 'paps',
  // Genotype tests: sickling or Sickledex (alone, or as a prep or test); a sickle cell test, screen or status; a
  // solubility test with sickle or Hb S before it, up to five words apart ("Hemoglobin S [Presence] in Blood by
  // Solubility test"), but not "Solubility test" alone; Hb typing, electrophoresis, variants, HPLC and pattern; a
  // haemoglobinopathy screen or test.
  'sickl(?:ing|edex)(?:[^a-z0-9]*(?:preps?|tests?))?', 'sickl[a-z]*[^a-z0-9]*(?:cell[^a-z0-9]*)?(?:tests?|screen[a-z]*|status)',
  '(?:sickl[a-z]*|h(?:a?emoglobin|gb|b)[^a-z0-9]*s)(?:[^a-z0-9]+[a-z]+){0,5}[^a-z0-9]*solubility',
  'hgb[^a-z0-9]*electrophoresis', 'hb[^a-z0-9]*typing', 'h(?:a?emoglobin|gb|b)[^a-z0-9]*(?:variants?|hplc|pattern)',
  'ha?emoglobinopath[a-z]*[^a-z0-9]*(?:screen[a-z]*|tests?)',
  // A dried blood spot (DBS), as a test name: the infant HIV test ("DBS PCR").
  'dbs(?:[^a-z0-9]*pcr)?',
  // Mental health and drug tests by their test names (the condition list has its own words for the conditions):
  // depression and anxiety screens, EPDS, HADS, a mental status exam; toxicology and urine drug screens, UDS, DOA,
  // and a screen or test for one drug.
  '(?:depression|anxiety)[^a-z0-9]*screen[a-z]*', 'epds', 'hads', 'mental[^a-z0-9]*status', 'tox(?:icology)?[^a-z0-9]*screen[a-z]*',
  'urine[^a-z0-9]*tox(?:icology)?', 'uds', 'doas?',
  '(?:cannabis|thc|opiates?|cocaine|amphetamines?|benzodiazepines?)[^a-z0-9]*(?:screen[a-z]*|tests?)',
  // Psychiatric drug levels as test names (Ola's third list): a lithium level or assay, and clozapine (or a clozapine
  // level). Lithium and clozapine as medicines are judged by the medicine list, which does not name them. Ola's fifth
  // list: lithium only when a test word follows it, level, assay, concentration or moles, or serum or plasma ("Lithium
  // (serum)", "Lithium [Moles/volume] in Serum or Plasma"), and a lithium carbonate level; and "Li level" and "Serum Li"
  // as whole words. Serum, plasma or blood before lithium no longer counts: it read the lithium heparin tube as a
  // lithium test ("Plasma (lithium heparin)", "Troponin I (plasma lithium heparin)"). So "Serum lithium" and "Lithium"
  // alone are shown: misses Ola accepts.
  'lithium[^a-z0-9]*(?:serum|plasma|levels?|assay|concentrations?|moles)', 'lithium[^a-z0-9]*carbonate[^a-z0-9]*levels?',
  'li[^a-z0-9]*levels?', 'serum[^a-z0-9]*li', 'clozapine(?:[^a-z0-9]*levels?)?',
] as const;
/*
 * LOINC codes of the same tests, matched when the code system is LOINC
 * (http://loinc.org), whatever the display text. Only codes whose meaning is
 * certain are listed: HIV 1+2 Ab/Ag and HIV 1 Ab (75622-1, 56888-1, 7917-8,
 * 68961-2), HIV 1 RNA viral load (20447-9), CD4 count (24467-3), HBsAg
 * (5196-1, 5195-3), HCV Ab (16128-1, 13955-0), hCG (2106-3, 21198-7, 2119-6),
 * PSA (2857-1, 35741-8), AFP (1834-1, 19176-1), CEA (2039-6), CA-125 (10334-1);
 * HIV 1+2 Ab and HIV 1 Ab by other methods (7918-6, 29893-5, 31201-7, 5221-7),
 * HIV 1 RNA viral load by other methods (10351-5, 25836-8), hCG in serum
 * (2118-8, 19080-2). Identical to SENSITIVE_LOINC_CODES in lab-api's
 * patient-results.service.ts.
 */
export const SENSITIVE_LOINC_CODES = [
  '75622-1', '56888-1', '7917-8', '68961-2', '20447-9', '24467-3', '5196-1', '5195-3', '16128-1', '13955-0',
  '2106-3', '21198-7', '2119-6', '2857-1', '35741-8', '1834-1', '19176-1', '2039-6', '10334-1',
  '7918-6', '29893-5', '31201-7', '5221-7', '10351-5', '25836-8', '2118-8', '19080-2',
] as const;
/** LOINC as a code system: its name or URL ("http://loinc.org"), or its OID (2.16.840.1.113883.6.1, also as "urn:oid:..."). Same in SQL and JS. */
export const LOINC_SYSTEM_SQL_PATTERN = '(loinc|(^|[^0-9.])2[.]16[.]840[.]1[.]113883[.]6[.]1($|[^0-9.]))';
/** The SQL list form of SENSITIVE_LOINC_CODES, for `in (...)` in patient-only SQL. Codes hold only digits and a hyphen. */
export const SENSITIVE_LOINC_SQL_LIST = SENSITIVE_LOINC_CODES.map(code => `'${code}'`).join(',');
const CANCER_SITES = 'breast|prostate|cervix|cervical|cx|colon|rectum|rectal|colorectal|lung|liver|stomach|gastric|ovary|ovarian'
  + '|uterus|uterine|endometrium|endometrial|bladder|pancreas|pancreatic|oesophagus|esophagus|thyroid|kidney|renal|skin|bone|brain'
  + '|testis|testicular|penis|penile|vulva|vulval|oral|tongue|larynx|nasopharynx|head[^a-z0-9]*and[^a-z0-9]*neck';
/**
 * The initialisms of the condition list below, each also matched in every form, as the test list's are (initialismForm).
 * PMTCT is in the test list's initialisms, which the condition pattern reads too. GUD (genital ulcer disease) and HEI
 * (HIV-exposed infant) joined in Ola's third list (#258, 27 Nov 2026). Ola's fourth list took PID out: it is ambiguous,
 * and a prolapsed intervertebral disc is a very common meaning ("Lumbar PID", "PID L4/L5"); pelvic inflammatory
 * disease written out stays hidden. STI stays hidden (in the test list) although it can mean a soft tissue injury,
 * because the sexually transmitted infection is the more stigmatized meaning. The fourth list added AHD, PCP, NGU and
 * the pregnancy shorthand; the fifth list keeps those as plain initialisms only (the condition list below), so
 * letters set apart are not read as them: "a pH of 7.1", "a PH" and "a HD" are shown. It took PROM out: in a
 * diagnosis it is as often the passive range of motion ("Reduced PROM right shoulder", "AROM/PROM restricted").
 */
export const SENSITIVE_CONDITION_INITIALISMS = ['rvd', 'rvi', 'plwha', 'plhiv', 'anc', 'ptsd', 'ocd', 'adhd', 'gud', 'hei'] as const;
/**
 * The cancer sites "Ca" may be set apart from by any one to three marks ("Ca/Cx", "Ca.breast", "Ca (breast)", "Ca:
 * prostate"). Renal, kidney, bone and liver are left out: there Ca is mostly calcium ("Ca/renal stones", "Low Ca,
 * renal failure", "Ca/bone"; Ola's fifth list). With spaces or hyphens only, every site is read ("Ca renal").
 */
const CANCER_SITES_AFTER_MARKS = CANCER_SITES.split('|').filter(site => !['renal', 'kidney', 'bone', 'liver'].includes(site)).join('|');
/*
 * Where a condition's name has two or more words, any run of marks that are
 * not letters or digits may set them apart, or none, as in the test list
 * ("Self-harm", "Post/natal", "Genital/warts"). Two forms take narrower marks
 * (Ola's third, fourth and fifth lists): "Ca" and a cancer site, and C
 * section. So "Renal (Ca) stones" and "Grade C. Section 2" are shown.
 */
export const SENSITIVE_CONDITION_FRAGMENTS = [
  'cancers?', '[a-z]*carcinoma[a-z]*', 'malignan[a-z]*', 'neoplas[a-z]*', '[a-z]*lymphoma[a-z]*', 'leuka?emia[a-z]*', '[a-z]*sarcoma[a-z]*',
  'metasta[a-z]*', 'tumou?rs?', 'depress[a-z]*', 'schizo[a-z]*', 'bipolar', 'psychos[a-z]*', 'psychotic', 'suicid[a-z]*',
  'self[^a-z0-9]*harm', 'anxiety', 'substance', 'addict[a-z]*',
  // The display text is checked whatever the code system, so each group SENSITIVE_ICD10 (and SENSITIVE_ICD11_GROUPS)
  // hides by code is named here too. Pregnancy and its care (O, Z32-Z36); 'pregnan[a-z]*' is here because the test
  // list's pregnancy test names are for tests only:
  'pregnan[a-z]*', 'gestation[a-z]*', 'ante[^a-z0-9]*natal', 'anc', 'post[^a-z0-9]*natal', 'post[^a-z0-9]*partum', 'puerper[a-z]*',
  // Gravida and para name their prefixes ("Primigravida", "Grand multipara"), and a bare "Para" needs its number ("Para
  // 2"), so "Para-aortic" and "Para ovarian cyst" are shown. Gravida-para shorthand: "G2P1", "G3 P2". The -parous
  // words describe the woman, not a pregnancy, and are shown ("Uterine fibroids, nulliparous"; Ola's fifth list).
  'obstetric[a-z]*', '(?:(?:grand[^a-z0-9]*)?multi|primi|nulli|secundi)?gravid[a-z]*',
  '(?:(?:grand[^a-z0-9]*)?multi|primi|nulli|secundi)parae?', 'para[^a-z0-9]*[0-9]+', 'g[0-9]+[^a-z0-9]*p[0-9]+',
  'miscarri[a-z]*', 'abortion[a-z]*', '(?:pre[^a-z0-9]*)?eclamp[a-z]*',
  // C section takes one space, slash, dot or hyphen between, or none ("C-section", "C/Section", "C.Section", "Csection"),
  // so "Grade C. Section 2" is shown. "C/S" alone is shown: it is also culture and sensitivity. Ola's fifth list:
  // caesarean and its common misspellings (cesarean, caesarian, caeserean, ceaserean, ceasarean, cesarian), with or
  // without section after; prev, previous, post, emergency or elective then CS, C/S, C.S or LSCS ("Previous CS", "Post
  // C/S", "Emergency LSCS"); LSCS, EMCS and ELCS as plain initialisms (below).
  'hyperemesis', 'placenta[a-z]*', 'hydatidiform', 'trimester', 'labou?r', 'c[ /.-]?section',
  'c(?:a|e|ae|ea)s(?:a|e|ea|ae)r(?:ea|ia|ai|e|a|i)n(?:[^a-z0-9]*sections?)?',
  '(?:prev|previous|post|emergency|elective)[^a-z0-9]*(?:c[ /.-]?s|lscs)',
  // Pregnancy written in short (Ola's fourth list): stillbirth and breech. Ectopic only next to ruptured, unruptured or
  // tubal ("Ruptured ectopic", "Ectopic (ruptured)"), or as an ectopic pregnancy (pregnan... above): alone it is as
  // often a heartbeat or an organ out of place ("Ventricular ectopic", "Atrial ectopic", "Testis, ectopic"; Ola's fifth
  // list).
  'still[^a-z0-9]*births?', 'breech', '(?:(?:un)?ruptured|tubal)[^a-z0-9]*ectopic', 'ectopic[^a-z0-9]*(?:un)?ruptured',
  // Pregnancy misspelt ("Pregancy", "Pregnency", "Prenancy", "Pragnancy"), as in the test-only list (Ola's third list).
  'pr[ae]g?n?[ae]n?cy[a-z]*',
  // Pregnancy written out (Ola's fifth list): intrauterine fetal death, antepartum and postpartum haemorrhage (also
  // run together: postpartum alone is read above), oligohydramnios and polyhydramnios, malpresentation, transverse lie,
  // cord prolapse, uterine rupture or a ruptured uterus, post-dates, chorioamnionitis, salpingitis, tubo-ovarian
  // abscess, and (premature, prelabour or preterm prelabour) rupture of (the) membranes, or membrane.
  'intra[^a-z0-9]*uterine[^a-z0-9]*fo?etal[^a-z0-9]*death', '(?:ante|post)[^a-z0-9]*partum[^a-z0-9]*ha?emorrhages?',
  '(?:oligo|poly)[^a-z0-9]*hydramnios', 'mal[^a-z0-9]*presentations?', 'transverse[^a-z0-9]*lie', 'cord[^a-z0-9]*prolapse',
  'uterine[^a-z0-9]*rupture', 'ruptured[^a-z0-9]*uterus', 'post[^a-z0-9]*dates', 'chorio[^a-z0-9]*amnionitis', 'salpingitis',
  'tubo[^a-z0-9]*ovarian[^a-z0-9]*abscess(?:es)?',
  '(?:(?:premature|prelabou?r|preterm(?:[^a-z0-9]*prelabou?r)?)[^a-z0-9]*)?rupture[^a-z0-9]*of[^a-z0-9]*(?:the[^a-z0-9]*)?membranes?',
  // Pregnancy shorthand as plain initialisms only, the letters together (Ola's fifth list): PPROM, PPH, APH, PIH, GDM,
  // IUFD, IUGR, HELLP, SVD (spontaneous vaginal delivery), VBAC, MSB and FSB (macerated and fresh stillbirth), ERPC,
  // LSCS, EMCS and ELCS.
  'pprom', 'pph', 'aph', 'pih', 'gdm', 'iufd', 'iugr', 'hellp', 'svd', 'vbac', 'msb', 'fsb', 'erpc', 'lscs', 'emcs', 'elcs',
  // Neoplasms (C, D00-D09) named without "cancer" or "carcinoma":
  'hepatoma', 'melanoma[a-z]*', 'myeloma[a-z]*', '[a-z]*blastoma[a-z]*', 'glioma[a-z]*', 'astrocytoma[a-z]*', 'seminoma[a-z]*',
  'mesothelioma[a-z]*', 'hodgkin[a-z]*', 'myelodysplas[a-z]*', 'kaposi[a-z]*', 'in[^a-z0-9]*situ',
  // Mental and behavioural disorders (F):
  'mental', 'ptsd', 'post[^a-z0-9]*traumatic', 'obsessive', 'ocd', 'compulsive', 'panic', 'phobi[a-z]*', 'mania', 'manic', 'hypomani[a-z]*',
  'adhd', 'autis[a-z]*', 'dementia', 'personality', 'anorexia[^a-z0-9]*nervosa', 'bulimi[a-z]*', 'eating[^a-z0-9]*disorders?',
  'alcoholi[a-z]*', 'dependence', 'withdrawal', 'intoxication', 'delirium', 'neurosis', 'neurotic', 'catatoni[a-z]*',
  '(?:alcohol|drug|opioid|opiate|heroin|cannabis|cocaine|amphetamine|benzodiazepine)[^a-z0-9]*(?:use|abuse|misuse)',
  // Sexually transmitted infections (A50-A64) named without the infection's own word:
  'genital[^a-z0-9]*warts?', 'condylom[a-z]*', 'anogenital', 'chancroid', 'lymphogranuloma', 'donovanosis',
  'granuloma[^a-z0-9]*inguinale',
  // The syndromes of STI care, and STI written out (Ola's third list): sexually transmitted infection or disease,
  // urethral discharge, genital ulcer (disease), vaginal discharge syndrome, pelvic inflammatory disease and lower
  // abdominal pain syndrome. GUD is in the initialisms above.
  'sexually[^a-z0-9]*transmitted[^a-z0-9]*(?:infections?|diseases?)', 'urethral[^a-z0-9]*discharge',
  'genital[^a-z0-9]*ulcers?(?:[^a-z0-9]*diseases?)?', 'vaginal[^a-z0-9]*discharge[^a-z0-9]*syndromes?',
  'pelvic[^a-z0-9]*inflammatory[^a-z0-9]*diseases?',
  'lower[^a-z0-9]*abdominal[^a-z0-9]*pain[^a-z0-9]*syndromes?',
  // Ola's fourth list: inguinal bubo, scrotal swelling syndrome, urethritis and cervicitis; NGU as a plain initialism.
  // The fifth list: a bubo or buboes alone, penile discharge, genital sores.
  'inguinal[^a-z0-9]*bubo(?:e?s)?', 'bubo(?:e?s)?', 'scrotal[^a-z0-9]*swelling[^a-z0-9]*syndromes?', 'urethritis', 'cervicitis', 'ngu',
  'penile[^a-z0-9]*discharge', 'genital[^a-z0-9]*sores?',
  // Advanced HIV disease (Ola's fourth list): cryptococcal (or crypto) meningitis, Pneumocystis (pneumonia). The fifth
  // list: every cryptococc... word, WHO (clinical) stage 3 or 4 (or III, IV); AHD, PCP and PJP as plain initialisms.
  'crypto(?:coccal)?[^a-z0-9]*meningitis', 'cryptococc[a-z]*', 'pneumocystis', 'ahd', 'pcp', 'pjp',
  'who[^a-z0-9]*(?:clinical[^a-z0-9]*)?stage[^a-z0-9]*(?:3|4|iii|iv)',
  // Shorthand: retroviral disease or infection, people living with HIV (PLWH as a plain initialism, Ola's fifth list;
  // PMTCT is in the test list), and retro or retroviral then positive, pos, reactive, +ve or ve ("Retro +ve",
  // "Retroviral pos"), or a plus sign alone ("Retro +", fifth list). An HIV-exposed infant is hidden by its HIV, and
  // HEI is in the initialisms above.
  'rvd', 'rvi', 'plwha', 'plhiv', 'plwh', 'retro[^a-z0-9]*(?:viral[^a-z0-9]*)?(?:positive|pos|reactive|[+]?ve)',
  'retro[^a-z0-9]*(?:viral[^a-z0-9]*)?[+]',
  // "Ca breast", "Ca. of the cervix", "breast Ca": cancer of a named site. Between "Ca" and the site: spaces or hyphens
  // (a dot after "Ca" too), or one to three other marks for the sites where Ca is not calcium (above).
  `ca[.]?(?:[ -]+of(?:[ -]+the)?)?[ -]+(?:${CANCER_SITES})`, `ca[^a-z0-9]{1,3}(?:${CANCER_SITES_AFTER_MARKS})`,
  `(?:${CANCER_SITES})[ -]+ca`,
  // The condition list's own initialisms in every form ("R.V.D.", "R-V-D", "P-T-S-D"), made as the test list's are.
  ...SENSITIVE_CONDITION_INITIALISMS.map(initialismForm),
] as const;
export const SENSITIVE_MEDICINE_FRAGMENTS = [
  'tenofovir', 'lamivudine', 'emtricitabine', 'dolutegravir', 'efavirenz', 'nevirapine', 'zidovudine', 'abacavir',
  'lopinavir', 'atazanavir', 'darunavir', 'ritonavir', 'raltegravir', 'rilpivirine', 'cabotegravir', 'tld', 'tle',
  'arvs?', 'antiretrovir[a-z]*', 'haart', 'art',
  // Component abbreviations as regimens are written ("TDF/3TC/DTG", "AZT/3TC/NVP"), and brand names.
  'tdf', 'taf', '3tc', 'ftc', 'dtg', 'efv', 'nvp', 'azt', 'zdv', 'abc', 'lpv', 'atv', 'drv', 'ral', 'rpv',
  'truvada', 'atripla', 'kaletra', 'aluvia', 'combivir', 'triomune', 'duovir[a-z]*',
  // Ola's third list (#258, 27 Nov 2026): the other antiretrovirals, and the antivirals for hepatitis B and C.
  // Ribavirin is not listed: in Nigeria it is also the treatment for Lassa fever.
  'didanosine', 'stavudine', 'indinavir', 'nelfinavir', 'saquinavir', 'fosamprenavir', 'tipranavir', 'etravirine', 'doravirine',
  'maraviroc', 'enfuvirtide', 'bictegravir', 'elvitegravir', 'islatravir', 'lenacapavir',
  'entecavir', 'adefovir', 'telbivudine',
  'sofosbuvir', 'daclatasvir', 'ledipasvir', 'velpatasvir', 'voxilaprevir', 'glecaprevir', 'pibrentasvir', 'elbasvir', 'grazoprevir',
  'simeprevir',
  // The HIV prophylaxis tablet of isoniazid, pyridoxine, sulfamethoxazole and trimethoprim (Q-TIB): isoniazid and
  // sulfamethoxazole (or co-trimoxazole) in one name, either first, with at most eight words between ("Isoniazid 300 mg
  // + pyridoxine 25 mg + sulfamethoxazole 800 mg + trimethoprim 160 mg"). Isoniazid alone (TB) and co-trimoxazole
  // alone (infections) are shown.
  'isoniazid(?:[^a-z0-9]+[a-z0-9]+){0,8}[^a-z0-9]+(?:sul(?:f|ph)amethoxazole|co[^a-z0-9]*trimoxazole)',
  '(?:sul(?:f|ph)amethoxazole|co[^a-z0-9]*trimoxazole)(?:[^a-z0-9]+[a-z0-9]+){0,8}[^a-z0-9]+isoniazid',
  'q[^a-z0-9]*tib',
  // Ola's fourth list (#258, 27 Nov 2026). Ravidasvir (hepatitis C); the children's tablets pDTG and pALD; INH and CTX
  // (or co-trimoxazole, or Septrin: Ola's fifth list) joined by +, /, & or "and", either first, with at most three
  // words between for a dose ("INH 300 mg + CTX 960 mg"). The marks around each word and joiner are at most three, so a
  // long run of marks cannot make the check slow. Isoniazid alone and co-trimoxazole alone are still shown, and so are
  // TL, IPT, TPT, 3HP and cotrimoxazole prophylaxis.
  'ravidasvir', 'pdtg', 'pald',
  'inh(?:[^a-z0-9]{1,3}[a-z0-9]+){0,3}(?:[^a-z0-9]{0,3}[+/&][^a-z0-9]{0,3}|[^a-z0-9]{1,3}and[^a-z0-9]{1,3})(?:ctx|co[^a-z0-9]*trimoxazole|septrin)',
  '(?:ctx|co[^a-z0-9]*trimoxazole|septrin)(?:[^a-z0-9]{1,3}[a-z0-9]+){0,3}(?:[^a-z0-9]{0,3}[+/&][^a-z0-9]{0,3}|[^a-z0-9]{1,3}and[^a-z0-9]{1,3})inh',
  // Peginterferon only as alfa or alpha, for hepatitis B and C (Ola's fifth list): pegylated or peg interferon alfa
  // (2a or 2b), Pegasys, PegIntron, Peg-IFN. "Peginterferon beta-1a", for multiple sclerosis, is shown, and so is
  // "Peginterferon" alone.
  'peg[^a-z0-9]*(?:ylated[^a-z0-9]*)?interferon[^a-z0-9]*(?:alf?pha|alfa)(?:[^a-z0-9]*2[ab])?', 'pegasys', 'peg[^a-z0-9]*intron',
  'peg[^a-z0-9]*ifn',
  // PrEP only as oral PrEP, PrEP then TDF, FTC or HIV, pre-exposure prophylaxis, and HIV PEP (kit) (Ola's fifth list).
  // "Prep" alone is as often a bowel, skin or iron preparation ("Klean-Prep", "Skin prep", "Prep H"), so it is shown.
  'oral[^a-z0-9]*prep', 'prep[^a-z0-9]*(?:tdf|ftc|hiv)', 'pre[^a-z0-9]*exposure[^a-z0-9]*prophylaxis', 'hiv[^a-z0-9]*pep(?:[^a-z0-9]*kit)?',
  // Brand names of antiretrovirals and hepatitis B and C antivirals; dapivirine (the vaginal ring); the hepatitis C
  // pairs Sof/Dac and Sof/Vel. The brands from Complera to Yeztugo, dapivirine and the pairs are Ola's fifth list.
  'biktarvy', 'dovato', 'triumeq', 'tivicay', 'viread', 'descovy', 'epivir', 'ziagen', 'odefsey', 'genvoya', 'stribild', 'symtuza',
  'juluca', 'cabenuva', 'apretude', 'epclusa', 'harvoni', 'sovaldi', 'maviret', 'mavyret', 'zepatier', 'vosevi', 'baraclude',
  'vemlidy',
  'complera', 'eviplera', 'isentress', 'prezista', 'reyataz', 'edurant', 'sustiva', 'stocrin', 'viramune', 'retrovir', 'kivexa',
  'epzicom', 'trizivir', 'sunlenca', 'yeztugo',
  'dapivirine', 'sof[^a-z0-9]*(?:dac|vel)',
] as const;
/** ICD-10: HIV (B20-B24, Z21, R75), viral hepatitis (B15-B19), STIs (A50-A64), neoplasms (C, D00-D09), mental health (F), pregnancy (O, Z32-Z36). */
const SENSITIVE_ICD10 = /^(?:B2[0-4]|Z21|R75|B1[5-9]|A5\d|A6[0-4]|C\d\d|D0\d|F\d\d|O\d\d|Z3[2-6])/i;

const jsPattern = (fragments: readonly string[]) => new RegExp(`(?<![a-z0-9])(?:${fragments.join('|')})(?![a-z0-9])`, 'i');
/** The PostgreSQL ARE form of the sensitive test list, for `!~*` in patient-only SQL. */
export const SENSITIVE_TEST_SQL_PATTERN =
  `(^|[^a-z0-9])(?:${[...SENSITIVE_TEST_FRAGMENTS, ...SENSITIVE_TEST_ONLY_FRAGMENTS].join('|')})($|[^a-z0-9])`;
const SENSITIVE_TEST = jsPattern([...SENSITIVE_TEST_FRAGMENTS, ...SENSITIVE_TEST_ONLY_FRAGMENTS]);
const SENSITIVE_CONDITION = jsPattern([...SENSITIVE_TEST_FRAGMENTS, ...SENSITIVE_CONDITION_FRAGMENTS]);
const SENSITIVE_MEDICINE = jsPattern(SENSITIVE_MEDICINE_FRAGMENTS);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const LOINC_CODES = new Set<string>(SENSITIVE_LOINC_CODES);
const LOINC_SYSTEM = new RegExp(LOINC_SYSTEM_SQL_PATTERN, 'i');
/**
 * A facility's own item (0155): code system HID-FACILITY and the item's id, a UUID that means nothing. Only its name
 * can hide it, as lab-api's copy checks names only; a UUID's letter groups ("cd41") are not read as a test's name.
 */
const FACILITY_ITEM_CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSensitiveTest(name: unknown, code?: unknown, codeSystem?: unknown): boolean {
  const facilityItemCode = text(codeSystem).trim().toUpperCase() === 'HID-FACILITY' && FACILITY_ITEM_CODE.test(text(code).trim());
  return SENSITIVE_TEST.test(text(name)) || (!facilityItemCode && SENSITIVE_TEST.test(text(code)))
    || (LOINC_SYSTEM.test(text(codeSystem).trim()) && LOINC_CODES.has(text(code).trim()));
}

/*
 * ICD-11 (MMS, release 2026-01): the groups SENSITIVE_ICD10 hides, as a table of WHO codes and ranges.
 * DRAFT, waiting for the clinical lead: Health ID's named clinical lead confirms these ranges before release
 * (owner decision Q124 A sign-off; Ola's decision 5 on #258). They were read from WHO's 2026-01 release files:
 * the tabular list, the simple tabulation and the 10-to-11 and 11-to-10 maps
 * (https://icdcdn.who.int/static/releasefiles/2026-01/mapping.zip).
 *
 * Each entry of `codes` and `except` is written as WHO writes it and takes in every code under it:
 * - 'QA40', a category: QA40, QA40.x and QA40.xx;
 * - 'KA62.6', a code with a dot: KA62.6 and KA62.6x;
 * - '1C60-1C62.Z', a range: every code whose category (the four characters before the dot) lies between the
 *   two categories, both included. Categories sort as plain text (digits, then letters, Y and Z last), the
 *   order WHO numbers them in.
 * `exactly` lists codes that count alone, without the codes under them.
 */
export interface Icd11SensitiveGroup {
  readonly group: string;
  /** The ICD-10 codes SENSITIVE_ICD10 hides for the same group. */
  readonly icd10: string;
  readonly codes: readonly string[];
  readonly exactly?: readonly string[];
  readonly except?: readonly string[];
}
export const SENSITIVE_ICD11_GROUPS: readonly Icd11SensitiveGroup[] = [
  // Z21 (asymptomatic HIV) is 1C62.0, inside the block. KA62.6 is congenital HIV infection (likely: WHO maps it
  // back to P35, but in ICD-10 practice these infants are coded B20-B24).
  { group: 'HIV disease', icd10: 'B20-B24, Z21', codes: ['1C60-1C62.Z', 'KA62.6'] },
  // MA14.0 alone: the rest of MA14 (MA14.1x: tuberculin, ANA, CRP...) is not about HIV.
  { group: 'Laboratory evidence of HIV', icd10: 'R75', codes: ['MA14.0'] },
  { group: 'Viral hepatitis', icd10: 'B15-B19', codes: ['1E50-1E5Z'] },
  { group: 'Predominantly sexually transmitted infections', icd10: 'A50-A64', codes: ['1A60-1A9Z'] },
  { group: 'Malignant neoplasms, except of lymphoid, haematopoietic or central nervous system tissues',
    icd10: 'C00-C69, C73-C80, C97', codes: ['2B50-2E2Z'] },
  // Likely: the whole block, which also holds what ICD-10 files under D45-D47 (polycythaemia vera, myelodysplastic
  // syndromes, MGUS...). Matching ICD-10 exactly would take those codes out; the clinical lead decides. The groups
  // below hide more codes whose only ICD-10 codes in WHO's 11-to-10 map are shown today; each is named at its group.
  { group: 'Neoplasms of haematopoietic or lymphoid tissues', icd10: 'C81-C96', codes: ['2A20-2B3Z'] },
  // Uncertain: an ICD-11 stem code does not tell a malignant central nervous system tumour from a benign one
  // (C71, D33.0 and D43.0 all map to 2A00.5), so the block is hidden less 2A02.3 and 2A02.4. It still hides codes
  // that WHO maps back only to benign D33 codes, shown in ICD-10: 2A00.21 (mixed neuronal-glial tumours, D33.2) and
  // 2A00.22 (choroid plexus tumours, D33.0 and D33.1). The clinical lead decides whether they go into `except`.
  { group: 'Neoplasms of the central nervous system', icd10: 'C70-C72', codes: ['2A00-2A0Z'], except: ['2A02.3', '2A02.4'] },
  { group: 'In situ neoplasms', icd10: 'D00-D09', codes: ['2E60-2E6Z'] },
  { group: 'Mental, behavioural or neurodevelopmental disorders (chapter 06)', icd10: 'F00-F99', codes: ['6A00-6E8Z'] },
  // Likely: F conditions ICD-11 moved out of chapter 06: sexual dysfunctions and sexual pain (F52), gender
  // incongruence (F64), tic disorders (F95), F98.4, F80.3, Rett syndrome (F84.2), acute stress reaction (F43.0) and
  // F66; and the sleep-wake codes WHO maps back to F51, each alone (chapter 07 also holds G47 conditions such as
  // narcolepsy and sleep apnoea, so neither the chapter nor these categories are taken whole). 7A0Z (insomnia
  // disorders, unspecified) maps back to G47.0 but is where WHO's 10-to-11 map sends F51.0, so it goes with 7A00 and
  // 7A01; if the clinical lead decides insomnia should not follow F51.0, all three go.
  // Hidden here although WHO maps them back only to ICD-10 codes shown today (the clinical lead decides each):
  // HA01.1-HA01.1Z (male erectile dysfunction, N48.4: ICD-10 hid only F52.2, so ICD-11 hides all erectile
  // dysfunction, diabetic and hypertensive included); 7A85 and 7A86 (neurological; only the catch-all F51.9);
  // 8A05.11 (G25.6); QA15.1 (Z70.1).
  { group: 'Mental or behavioural conditions outside chapter 06', icd10: 'F51, F52, F64, F95, F98.4, F80.3, F84.2, F43.0, F66',
    codes: ['HA00-HA0Z', 'HA20-HA2Z', 'HA60-HA6Z', '8A05', '8A07.0', '8A62.2', 'LD90.4', 'QE84', 'QA15.1'],
    exactly: ['7A00', '7A01', '7A0Z', '7A23', '7A25', '7A26', '7A2Y', '7A2Z', '7A85', '7A86', '7A88', '7A8Y', '7A8Z', '7B00.1', '7B00.2',
      '7B01', '7B01.2', '7B01.Y', '7B01.Z', '7B02', '7B02.2', '7B0Y', '7B0Z', '7B2Y', '7B2Z'] },
  { group: 'Pregnancy, childbirth or the puerperium (chapter 18)', icd10: 'O00-O99', codes: ['JA00-JB6Z'] },
  // Pregnancy test, pregnant state, supervision of normal and high-risk pregnancy, antenatal screening. Not QA44
  // (expectant parent pre-birth visit, which maps back only to the block Z30-Z39) or QA46-QA4B (Z37-Z39 and others).
  { group: 'Pregnancy care contacts', icd10: 'Z32-Z36', codes: ['QA40', 'QA41', 'QA42', 'QA43', 'QA45'] },
];
/**
 * An ICD-11 stem code at the start of a part: the category (the chapter, a letter (never I or O), a digit, one more
 * character), then optionally a dot and up to two more characters. The dot may be missing ("1C620" is 1C62.0).
 */
const ICD11_STEM = /^([1-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z])\.?([0-9A-HJ-NP-Z]{0,2})/;
/**
 * A code system naming ICD-10 or ICD-11: "ICD-10", "icd10", "ICD-10-CM", "ICD-11 MMS", "ICD11MMS", or a WHO or HL7 URI.
 * "ICD-10/11" and "ICD 10 / 11" name both.
 */
const ICD10_SYSTEM = /icd[ ._-]*10(?![0-9])|id\.who\.int\/icd\/release\/10(?![0-9])/i;
const ICD11_SYSTEM = /icd[ ._-]*(?:10[ ._-]*\/[ ._-]*)?11(?![0-9])|id\.who\.int\/icd\/(?:release\/11(?![0-9])|entity)/i;
/**
 * Which ICD a diagnosis code system names: 'icd10', 'icd11', 'icd' when it says only "ICD" (or names both, or
 * another revision), or null when it does not contain "ICD" (SNOMED CT, local codes), the same test as before.
 */
export function icdRevision(codeSystem: unknown): 'icd10' | 'icd11' | 'icd' | null {
  const system = text(codeSystem);
  if (!/icd/i.test(system)) return null;
  const ten = ICD10_SYSTEM.test(system), eleven = ICD11_SYSTEM.test(system);
  return ten === eleven ? 'icd' : ten ? 'icd10' : 'icd11';
}
/**
 * The stem codes in an ICD-11 code, cluster or list ("1C62.0", "1A62.2Y&XA6KU8", "5A11/1C62.1", "QE84, 7A00",
 * "HA60 gender incongruence"), in capitals and with the dot put back ("1C620" gives 1C62.0): each part between
 * '&', '/', ',', ';' or spaces that starts in stem form, less extension codes (X...), which never stand alone.
 */
function icd11Stems(code: unknown): string[] {
  return text(code).toUpperCase().split(/[&/,;\s]+/).filter(part => !part.startsWith('X')).flatMap(part => {
    const stem = ICD11_STEM.exec(part);
    return stem ? [stem[2] ? `${stem[1]}.${stem[2]}` : stem[1]!] : [];
  });
}
const covers = (entry: string, stem: string) => {
  const dash = entry.indexOf('-');
  if (dash < 0) return stem === entry || stem.startsWith(entry.includes('.') ? entry : `${entry}.`);
  const category = stem.slice(0, 4);
  return category >= entry.slice(0, 4) && category <= entry.slice(dash + 1, dash + 5);
};
const inGroup = (stem: string, group: Icd11SensitiveGroup) =>
  (group.codes.some(entry => covers(entry, stem)) || (group.exactly ?? []).includes(stem))
  && !(group.except ?? []).some(entry => covers(entry, stem));
/**
 * Whether a diagnosis is sensitive by its code. Both checks run for every code system containing "ICD", whichever
 * revision it names, since the label is free text and often wrong (the staff forms suggest "ICD-10"). The ICD-10
 * check runs exactly as before, on the code as stored, so nothing hidden before is shown now. The ICD-11 table runs
 * on each stem in ICD-11 form. That form has a letter second; every WHO ICD-10, ICD-10-CM and ICD-9 code has a
 * digit second, so no ICD-10 result changes (only an ICD-10-PCS procedure code of section 6A, not a diagnosis,
 * would read as chapter 06 and be hidden, the safe direction). A code in neither form is not sensitive by code;
 * the display text is still checked.
 */
export function isSensitiveDiagnosisCode(code: unknown, codeSystem: unknown): boolean {
  if (!icdRevision(codeSystem)) return false;
  return SENSITIVE_ICD10.test(text(code))
    || icd11Stems(code).some(stem => SENSITIVE_ICD11_GROUPS.some(group => inGroup(stem, group)));
}

function sensitive(record: Evidence): boolean {
  const f = record.fields;
  switch (record.kind) {
    case 'lab_result': case 'investigation': return isSensitiveTest(f.test, f.code, f.codeSystem) || isSensitiveTest(record.title);
    // The display text is checked whatever the code system (ICD-10, ICD-11, SNOMED CT, local); ICD-10 and ICD-11 codes as well.
    case 'diagnosis': return SENSITIVE_CONDITION.test(text(f.condition)) || SENSITIVE_CONDITION.test(record.title)
      || isSensitiveDiagnosisCode(f.code, f.codeSystem);
    case 'prescription': return SENSITIVE_MEDICINE.test(text(f.medication)) || SENSITIVE_MEDICINE.test(record.title);
    default: return false;
  }
}

/** Whole years of age on `today` in Lagos, so the value (and the hash) only changes on the birthday. */
export function ageYears(dateOfBirth: unknown, today: Date): number | null {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(dateOfBirth));
  if (!birth || !Number.isFinite(today.getTime())) return null;
  const lagos = /^(\d{4})-(\d{2})-(\d{2})$/.exec(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(today));
  if (!lagos) return null;
  const y = Number(lagos[1]), m = Number(lagos[2]), d = Number(lagos[3]);
  const by = Number(birth[1]), bm = Number(birth[2]), bd = Number(birth[3]);
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age >= 0 && age < 150 ? age : null;
}
const SEXES = new Set(['female', 'male', 'intersex', 'other', 'unknown']);
export function sex(gender: unknown): string | null {
  return typeof gender === 'string' && SEXES.has(gender) ? gender : null;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (body: string, flags = 'giu') => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/**
 * Names that are also words clinicians capitalise mid-sentence ("next Sunday",
 * "Will review"). Alone they are left as written; next to another name, or in
 * the full name, they are still removed.
 */
const COMMON_WORD_NAMES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', ...MONTHS, 'will']);
/** The written-as-a-name forms of a name (capitalised, in capitals, or as stored if that starts with a capital), case-sensitive. */
const nameForms = (name: string) => [...new Set([name.charAt(0).toLocaleUpperCase() + name.slice(1).toLocaleLowerCase(),
  name.toLocaleUpperCase(), ...(/^\p{Lu}/u.test(name) ? [name] : [])])].map(escape).join('|');
const tokens = (value: unknown) => text(value).trim().split(/\s+/).filter(t => t.length >= 2);
function dateOfBirthPatterns(dateOfBirth: unknown): RegExp[] {
  const birth = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(dateOfBirth));
  if (!birth) return [];
  const [, y, m, d] = birth;
  const dd = `0?${Number(d)}`, mm = `0?${Number(m)}`;
  const month = MONTHS[Number(m) - 1];
  if (!month) return [];
  const name = `${month.slice(0, 3)}(?:${month.slice(3)})?\\.?`;
  const sep = '\\s*[/.-]\\s*', yy = y!.slice(2), year = `(?:${y}|${yy})`;
  const d2 = d!, m2 = m!;
  // Only right after "born", "DOB", "date of birth" or "birthday": forms that clinical numbers can share
  // ("dose 12.3.90", "RR 12 03 1990", "BP 1/12/12"), so they are removed only when they are said to be the birth date.
  const cue = '(?<=(?:born|dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|birth\\s*date|birth\\s*day)[\\s:,.-]*(?:(?:on|is|was)\\s+)?)';
  return [
    // A full date with a four-digit year, a month name, or as stored ("1990-03-12T00:00"): wherever it appears.
    word(`${y}${sep}${mm}${sep}${dd}(?:T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)?`),
    word(`${dd}${sep}${mm}${sep}${y}`),
    word(`${d2}${m2}${y}|${y}${m2}${d2}`),
    word(`${dd}(?:st|nd|rd|th)?(?:\\s*of)?[\\s./-]+${name}[\\s.,/-]+${year}`),
    word(`${name}[\\s./-]*${dd}(?:st|nd|rd|th)?[\\s.,/-]+${year}`),
    // After a birth cue: a two-digit year, plain spaces, month first, or digits run together.
    word(`${cue}(?:${dd}(?:${sep}|\\s+)${mm}(?:${sep}|\\s+)${year}|${mm}(?:${sep}|\\s+)${dd}(?:${sep}|\\s+)${year}`
      + `|${y}\\s+${mm}\\s+${dd}|${d2}${m2}${yy})`),
  ];
}
/**
 * Removes identifiers from free text: Health IDs, phone numbers, 11-digit ID
 * numbers (NIN, BVN), hospital or folder numbers, email addresses, the date of
 * birth and the patient's own name. Clinical values such as `12.5 g/dL`,
 * `120/80` and visit dates are left as they are.
 */
export function redactIdentifiers<T>(value: T, profile: PatientProfileInput): T {
  const first = tokens(profile.firstName), last = tokens(profile.lastName);
  const full = text(profile.fullName).trim().split(/\s+/).filter(Boolean);
  const fullNames = [...new Set([full.join(' '), [...first, ...last].join(' '), [...last, ...first].join(' ')]
    .filter(n => n.length >= 2 && n.includes(' ')))].sort((a, b) => b.length - a.length);
  const surnames = [...new Set(last.length ? last : full.slice(-1).filter(t => t.length >= 2))];
  const given = [...new Set([...first, ...full.slice(0, -1).filter(t => t.length >= 2)])].filter(t => !surnames.includes(t));
  const dob = dateOfBirthPatterns(profile.dateOfBirth);
  const clean = (input: string): string => {
    let s = input
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
      .replace(/(?<![A-Z0-9])HID-[A-HJ-NP-Z2-9]{6,32}(?![A-Z0-9])/gi, '[Health ID removed]')
      // Without the hyphen ("HID AB2CD3EF", "hid ab2cd3ef"): the code must hold a digit, or both be in capitals,
      // so the verb "hid" in "hid tablets" stays.
      .replace(/(?<![A-Z0-9])HID\s*(?=[A-HJ-NP-Z]*[2-9])[A-HJ-NP-Z2-9]{6,32}(?![A-Z0-9])/gi, '[Health ID removed]')
      .replace(/(?<![A-Za-z0-9])HID\s+[A-HJ-NP-Z2-9]{6,32}(?![A-Za-z0-9])/g, '[Health ID removed]')
      .replace(/\b((?:MRN|hospital\s*(?:no|number|num)|hosp\.?\s*no|folder\s*(?:no|number)|card\s*(?:no|number)|file\s*(?:no|number))\.?\s*[:#]?\s*)[A-Z0-9][A-Z0-9/-]{2,}/gi,
        '$1[record number removed]')
      .replace(/\b((?:NIN|BVN)\s*(?:no\.?|number)?\s*[:#]?\s*)\d(?:[\s-]?\d){10}(?!\d)/gi, '$1[ID number removed]')
      // Local and +234 numbers, with spaces, hyphens, dots, brackets or "(0)": "(0803) 123 4567", "+234 (0) 803 123 4567".
      .replace(/(?<![\d+(])(?:\(?\+?\(?234\)?[\s.-]*(?:\(0\)[\s.-]*)?|\(?0)[789][01]\d\)?(?:[\s.-]?\d){7}(?!\d)/g, '[phone removed]')
      .replace(/(?<!\d)\+\d[\d\s-]{8,14}\d(?!\d)/g, '[phone removed]')
      .replace(/(?<!\d|\d\.)\d{11}(?!\d|\.\d)/g, '[ID number removed]')
      .replace(/(?<!\d|\d\.)\d{4}[\s-]\d{4}[\s-]\d{3}(?!\d|\.\d)/g, '[ID number removed]');
    for (const pattern of dob) s = s.replace(pattern, '[date of birth removed]');
    for (const name of fullNames) s = s.replace(word(name.split(' ').map(escape).join('\\s+')), 'the patient');
    // A surname next to another name is someone else of the same family, or
    // the patient under another name: the whole name goes.
    // Names are often also words (Sunday, Will, Blessing, Hope), so only their
    // written-as-a-name forms are replaced, never the lower-case word.
    for (const surname of surnames) {
      const n = nameForms(surname);
      s = s.replace(word(`\\p{Lu}[\\p{L}'’-]+\\s+(?:${n})|(?:${n})\\s+\\p{Lu}[\\p{L}'’-]+`, 'gu'), '[name removed]');
      if (!COMMON_WORD_NAMES.has(surname.toLocaleLowerCase())) s = s.replace(word(n, 'gu'), '[name removed]');
    }
    for (const name of given) {
      if (!COMMON_WORD_NAMES.has(name.toLocaleLowerCase())) s = s.replace(word(nameForms(name), 'gu'), 'the patient');
    }
    return s;
  };
  const walk = (v: unknown): unknown => typeof v === 'string' ? clean(v) : Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

function hint(record: Evidence): OriginHint {
  if (record.kind === 'note') return record.origin === 'scanned_paper' ? 'scanned_paper' : null;
  if (record.kind === 'import' || record.kind === 'import_version') return record.origin === 'health_worker' ? 'provider-authored' : 'patient-provided';
  return null;
}
const pick = (fields: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]]));
const internal = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith('_')));

/** Whether the record stays out of the patient chat altogether. */
function excluded(record: Evidence): boolean {
  const f = record.fields;
  switch (record.kind) {
    case 'diagnosis': if (f.verificationStatus !== 'confirmed') return true; break;
    case 'prescription': case 'investigation':
      if (!ALLOWED_ORDER_STATUSES.has(text(f.status)) || f._encounterStatus !== 'completed') return true; break;
    case 'note': if (f._encounterStatus !== 'completed') return true; break;
    case 'encounter': if (f.status !== 'completed') return true; break;
    default: break;
  }
  return sensitive(record);
}

/** The patient's Health ID profile as the chat may see it: age and sex only. */
export function profileFields(profile: PatientProfileInput, today: Date) {
  return { ageYears: ageYears(profile.dateOfBirth, today), sex: sex(profile.gender) };
}

export function patientEvidence(records: Evidence[], profile: PatientProfileInput, today: Date): Evidence[] {
  const result: Evidence[] = [];
  for (const record of records) {
    if (excluded(record)) continue;
    let fields = internal(record.fields);
    let { title, provenance, quality } = record;
    const allowed = PATIENT_FIELDS[record.kind];
    if (record.kind === 'profile') { fields = profileFields(profile, today); title = 'Age and sex'; }
    else if (record.kind === 'lab_result' && fields.correctionPending === true) {
      fields = { ...pick(fields, allowed!.filter(k => !LAB_VALUE_FIELDS.includes(k))), correctionPending: true, status: LAB_CORRECTING };
      provenance = 'Laboratory result being corrected'; quality = 'correction pending; no value shown';
    } else if (allowed) fields = pick(fields, allowed);
    if (record.kind === 'lab_result' && fields.correctionPending !== true) { delete fields.correctionPending; delete fields.status; }
    if (record.kind === 'document') title = 'Clinical document';
    if (record.kind === 'attachment') title = 'Imported document';
    for (const key of FREE_TEXT_FIELDS[record.kind] ?? []) if (Object.hasOwn(fields, key)) fields[key] = redactIdentifiers(fields[key], profile);
    if (FREE_TEXT_TITLES.has(record.kind)) title = redactIdentifiers(title, profile);
    const rebuilt = evidence({ kind: record.kind, id: record.id, version: record.version, title, recordedAt: record.recordedAt,
      effectiveAt: record.effectiveAt, provenance, quality, fields, originHint: hint(record),
      ...(record.encounterId ? { encounterId: record.encounterId } : {}) });
    // The origin is worked out from the original row; it is not part of the hash.
    result.push({ ...rebuilt, origin: record.origin });
  }
  return result;
}
