import { BRAND_ROWS, isActiveBrandRow } from './brand-names';
import { editDistance, fuzzyListMatch, letterCount, LOOKALIKE_DISTANCE, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS,
  MIN_SIMILARITY, NOT_FOR_LISTS, type ListEntry } from './list-match';

/**
 * The medicine names a hard page's best-guess drug name may be shown as (owner decision of 2026-11-05, about
 * 18:40 UTC: "Yes, use a drug list"). Used only on hard pages (see reader.ts, hard-page reads): a drug name the
 * model proposes is shown in the list's spelling when it matches a name here; otherwise (since the owner decision of
 * 2026-11-06, about 10:13 UTC) it is shown as read with "?" (hard-page.ts); before, it was "[unreadable]".
 * The list never adds a drug: it only checks, and respells, a name the model itself proposed.
 *
 * SOURCE (generic names): Federal Ministry of Health, Nigeria. "Nigeria Essential Medicines List", 7th Edition,
 * 2020 (foreword by the Honourable Minister of Health; prepared by the National Drug Formulary/Essential Drug List
 * Review Committee). The latest edition found on 2026-11-05: the WHO country planning cycle database lists it as
 * the current edition, and no 8th edition was found. Copy read:
 *   https://extranet.who.int/cpcd/sites/default/files/public_file_repository/NGA_Nigeria-Essential-Medicine-List_2020.pdf
 *   (catalogue page: https://extranet.who.int/cpcd/health-legislation/nigeria-essential-medicine-list-7th-edition)
 * Taken from it: the medicines of the main list, the primary health care lists, the list for patent and
 * proprietary medicine vendors, the vitamin appendix and the restricted medicines list (Appendix 2), and the index.
 * Left out: vaccines, sera and immunoglobulins, diagnostics and test kits, dressings, devices and other supplies,
 * disinfectants and section headings. A fixed combination is listed as written there ("amoxicillin + clavulanic
 * acid"); its parts are listed on their own where the list has them on their own.
 * Spelling: the list's own misprints are given in their standard (INN or BAN) spelling, so the screen never shows a
 * misprint: lsoflurane (isoflurane), Bicalutanide (bicalutamide), Carboplastin (carboplatin), Cisplastin
 * (cisplatin), Dacabazine (dacarbazine), Artovastatin (atorvastatin), Glimeperide / Glimepyride (glimepiride),
 * Vidagliptin (vildagliptin), Tenovofir (tenofovir), Nifortimox (nifurtimox), Diethylcarbarmazine
 * (diethylcarbamazine), Capreomycine (capreomycin), Imipenen (imipenem), Pengrastrin (pentagastrin), Trilodothyronine
 * (triiodothyronine), Ethanercept (etanercept), Bethanecol (bethanechol), Flucinolone (fluocinolone), Zolendronic
 * (zoledronic), Chorhexidine (chlorhexidine), Lidnocaine (lidocaine).
 *
 * Other names for the same medicine (SYNONYMS) are the ones the list itself gives in brackets (adrenaline,
 * chlorphenamine, trihexyphenidyl, hydroxyurea, aspirin, co-trimoxazole, valproic acid, cyclosporin, busulphan),
 * plus a few British, US and older names still written on Nigerian charts, marked as added here.
 *
 * BRAND NAMES (BRAND_NAMES, kept apart): the active rows of the data table in brand-names.ts, each with its source
 * (a NAFDAC Greenbook listing, registration number and address, or for the brands curated before the table
 * 'coordinator-curated 2026-11') and reviewed_by. Each maps to its generic name on the list above or, for a
 * combination brand the list does not have as a combination (Ampiclox: ampicillin + cloxacillin), to the generics
 * it combines, each of which is on the list. A brand is shown as "Brand? (generic)". Only true brand names; a
 * manufacturer's name alone (such as a company that makes paracetamol) is never a brand here.
 */

/** Generic medicine names from the Nigeria Essential Medicines List, 7th Edition (2020); see the header. */
export const NEML_GENERICS: readonly string[] = [
  // Anaesthetics, preoperative medicines and muscle relaxants
  'halothane', 'isoflurane', 'nitrous oxide', 'oxygen', 'sevoflurane', 'ketamine', 'propofol', 'bupivacaine',
  'lidocaine', 'lidocaine + epinephrine', 'prilocaine', 'atropine', 'clonidine', 'diazepam', 'midazolam', 'morphine',
  'promethazine', 'atracurium', 'neostigmine', 'pancuronium', 'suxamethonium', 'vecuronium',
  // Antiallergics and anaphylaxis
  'dexamethasone', 'epinephrine', 'hydrocortisone', 'chlorpheniramine', 'loratadine', 'prednisolone', 'cinnarizine',
  'diphenhydramine',
  // Anticonvulsants
  'carbamazepine', 'clonazepam', 'ethosuximide', 'magnesium sulfate', 'phenytoin', 'pregabalin', 'sodium valproate',
  'topiramate', 'phenobarbital', 'paraldehyde',
  // Antidotes
  'activated charcoal', 'acetylcysteine', 'calcium gluconate', 'flumazenil', 'methionine', 'methylene blue',
  'naloxone', 'phytomenadione', 'prussian blue', 'protamine sulfate', 'desferrioxamine', 'dimercaprol', 'fomepizole',
  'sodium calcium edetate', 'succimer', 'pralidoxime',
  // Anti-infectives: amoebicides, anthelminthics, antifilarials, antischistosomals
  'metronidazole', 'tinidazole', 'diloxanide', 'albendazole', 'diethylcarbamazine', 'ivermectin', 'praziquantel',
  'mebendazole', 'pyrantel', 'oxamniquine', 'levamisole',
  // Antibacterials
  'ampicillin', 'amoxicillin', 'amoxicillin + clavulanic acid', 'benzathine benzylpenicillin', 'benzylpenicillin',
  'cefixime', 'ceftriaxone', 'cefuroxime', 'cefpodoxime', 'chloramphenicol', 'ciprofloxacin', 'clarithromycin',
  'clindamycin', 'cloxacillin', 'doxycycline', 'erythromycin', 'flucloxacillin', 'gentamicin', 'levofloxacin',
  'nitrofurantoin', 'ofloxacin', 'phenoxymethylpenicillin', 'piperacillin + tazobactam',
  'sulfamethoxazole + trimethoprim', 'trimethoprim', 'tetracycline', 'ceftazidime', 'meropenem', 'vancomycin',
  'azithromycin', 'chlortetracycline', 'neomycin', 'neomycin + bacitracin',
  // Antifungals, antileishmanials, antileprosy
  'amphotericin b', 'clotrimazole', 'fluconazole', 'miconazole', 'nystatin', 'terbinafine', 'natamycin',
  'sodium stibogluconate', 'meglumine antimoniate', 'clofazimine', 'dapsone', 'rifampicin',
  // Antimalarials and antitrypanosomals
  'artemether', 'artemether + lumefantrine', 'artesunate', 'artesunate + amodiaquine',
  'artesunate + pyronaridine', 'dihydroartemisinin + piperaquine', 'quinine', 'atovaquone + proguanil', 'proguanil',
  'mefloquine', 'sulfadoxine + pyrimethamine', 'pyrimethamine', 'hydroxychloroquine', 'pentamidine', 'suramin',
  'eflornithine', 'nifurtimox', 'melarsoprol',
  // Antituberculosis (first and second line)
  'ethambutol', 'ethambutol + isoniazid', 'isoniazid', 'isoniazid + pyrazinamide + rifampicin',
  'isoniazid + rifampicin', 'isoniazid + rifampicin + ethambutol + pyrazinamide', 'pyrazinamide', 'rifabutin',
  'rifapentine', 'aminosalicylic acid', 'streptomycin', 'amikacin', 'bedaquiline', 'capreomycin', 'cycloserine',
  'delamanid', 'ethionamide', 'gatifloxacin', 'imipenem + cilastatin', 'kanamycin', 'linezolid', 'moxifloxacin',
  'prothionamide', 'terizidone', 'thioacetazone',
  // Antivirals (HIV, hepatitis, herpes)
  'aciclovir', 'idoxuridine', 'nevirapine', 'efavirenz', 'abacavir', 'didanosine', 'lamivudine', 'zidovudine',
  'indinavir', 'lopinavir + ritonavir', 'ritonavir', 'atazanavir + ritonavir', 'darunavir + ritonavir',
  'dolutegravir', 'tenofovir', 'tenofovir + lamivudine', 'tenofovir + lamivudine + efavirenz',
  'tenofovir + lamivudine + dolutegravir', 'abacavir + efavirenz + lamivudine', 'abacavir + lamivudine',
  'lamivudine + nevirapine + zidovudine', 'lamivudine + zidovudine', 'entecavir', 'daclatasvir', 'sofosbuvir',
  'peginterferon alfa-2b', 'ribavirin',
  // Antimigraine
  'ergotamine', 'ibuprofen', 'paracetamol', 'sumatriptan', 'propranolol',
  // Antineoplastics and immunosuppressives
  'abiraterone', 'dactinomycin', 'adalimumab', 'asparaginase', 'azathioprine', 'bevacizumab', 'bortezomib',
  'bicalutamide', 'bleomycin', 'buserelin', 'busulfan', 'capecitabine', 'carboplatin', 'chlorambucil', 'ciclosporin',
  'cisplatin', 'cyclophosphamide', 'cytarabine', 'dacarbazine', 'daunorubicin', 'degarelix', 'docetaxel',
  'doxorubicin', 'epirubicin', 'etoposide', 'fludarabine', 'fluorouracil', 'flutamide', 'gemcitabine', 'goserelin',
  'hydroxycarbamide', 'letrozole', 'leuprorelin', 'ifosfamide', 'imatinib', 'irinotecan', 'chlormethine',
  'melphalan', 'mercaptopurine', 'mesna', 'methotrexate', 'mitoxantrone', 'oxaliplatin', 'paclitaxel',
  'procarbazine', 'diethylstilbestrol', 'tamoxifen', 'tioguanine', 'trastuzumab', 'vinblastine', 'vincristine',
  'zoledronic acid', 'tacrolimus', 'mycophenolate mofetil',
  // Blood: antianaemia, coagulation, plasma substitutes
  'ferrous salt', 'ferrous sulfate', 'ferric ammonium citrate', 'folic acid', 'erythropoietin', 'iron dextran',
  'iron sucrose', 'hydroxocobalamin', 'dabigatran', 'desmopressin', 'heparin', 'tranexamic acid', 'warfarin',
  'dextran 70', 'polygeline',
  // Cardiovascular
  'bisoprolol', 'diltiazem', 'glyceryl trinitrate', 'isosorbide dinitrate', 'amiodarone', 'procainamide',
  'verapamil', 'amiloride', 'amiloride + hydrochlorothiazide', 'amlodipine', 'atenolol', 'bendrofluazide',
  'captopril', 'enalapril', 'hydrochlorothiazide', 'hydralazine', 'indapamide', 'labetalol', 'lisinopril',
  'losartan', 'methyldopa', 'nifedipine', 'nimodipine', 'telmisartan', 'carvedilol', 'digoxin', 'dobutamine',
  'dopamine', 'furosemide', 'metoprolol', 'spironolactone', 'torasemide', 'acetylsalicylic acid', 'clopidogrel',
  'alteplase', 'streptokinase', 'atorvastatin', 'simvastatin', 'mannitol', 'acetazolamide',
  // Dermatological
  'triamcinolone', 'hexetidine', 'benzoyl peroxide', 'tretinoin', 'benzoic acid + salicylic acid',
  'miconazole + hydrocortisone', 'mupirocin', 'silver sulfadiazine', 'betamethasone', 'clobetasol', 'calamine',
  'hydrocortisone + neomycin', 'methyl salicylate', 'aluminium diacetate', 'coal tar', 'dithranol',
  'podophyllum resin', 'salicylic acid', 'urea', 'benzyl benzoate', 'permethrin', 'crotamiton', 'monosulfiram',
  'gentian violet', 'selenium sulfide', 'zinc oxide', 'doxepin', 'fluocinolone', 'tazarotene', 'methoxsalen',
  'titanium dioxide', 'aminobenzoic acid',
  // Gastrointestinal
  'metoclopramide', 'ondansetron', 'domperidone', 'aluminium hydroxide + magnesium hydroxide',
  'magnesium trisilicate', 'magnesium hydroxide', 'omeprazole', 'rabeprazole', 'ranitidine', 'bisacodyl',
  'lactulose', 'liquid paraffin', 'senna', 'oral rehydration salts', 'zinc sulfate', 'loperamide',
  'diphenoxylate + atropine', 'hyoscine butylbromide', 'hyoscine hydrobromide', 'docusate sodium', 'cyclizine',
  // Hormones, endocrine, contraceptives
  'testosterone', 'medroxyprogesterone', 'levonorgestrel', 'glucagon', 'glucose', 'insulin', 'insulin aspart',
  'insulin glargine', 'insulin glulisine', 'soluble insulin', 'isophane insulin', 'glibenclamide', 'gliclazide',
  'glimepiride', 'metformin', 'vildagliptin', 'sitagliptin', 'carbimazole', 'lugol\'s iodine', 'propylthiouracil',
  'potassium iodide', 'levothyroxine', 'liothyronine', 'octreotide', 'carbetocin', 'oxytocin', 'ergometrine',
  'misoprostol', 'mifepristone', 'mifepristone + misoprostol', 'fludrocortisone', 'methylprednisolone',
  'mesterolone', 'chorionic gonadotrophin', 'danazol', 'epimestrol', 'triiodothyronine', 'vasopressin',
  'aminoglutethimide', 'metyrapone', 'pentagastrin', 'tetracosactide', 'histamine phosphate',
  // Respiratory, ENT
  'budesonide', 'ipratropium bromide', 'salbutamol', 'salmeterol + fluticasone', 'beclometasone',
  'fluticasone', 'xylometazoline', 'ketotifen',
  // Fluids and electrolytes
  'potassium chloride', 'sodium chloride', 'sodium bicarbonate', 'ringer\'s lactate', 'water for injection',
  'calcium lactate',
  // Mental and neurological
  'benzhexol', 'biperiden', 'bromazepam', 'amitriptyline', 'fluoxetine', 'clomipramine', 'chlorpromazine',
  'fluphenazine', 'haloperidol', 'risperidone', 'lithium carbonate', 'pimozide', 'levodopa + carbidopa',
  'pyridostigmine', 'edrophonium',
  // Pain and palliative care, gout, rheumatic
  'buprenorphine', 'methadone', 'naltrexone', 'dihydrocodeine', 'fentanyl', 'pethidine', 'tramadol', 'pentazocine',
  'hydromorphone', 'oxycodone', 'allopurinol', 'colchicine', 'diclofenac', 'febuxostat', 'ketoprofen', 'naproxen',
  'celecoxib', 'etanercept', 'rituximab', 'tocilizumab', 'sulfasalazine', 'leflunomide', 'baclofen',
  'methocarbamol', 'tizanidine',
  // Ophthalmological
  'tetracaine', 'latanoprost', 'pilocarpine', 'timolol', 'homatropine', 'phenylephrine', 'tropicamide',
  'fluorescein', 'methylcellulose', 'olopatadine', 'dipivefrine',
  // Urinary and erectile
  'alfuzosin', 'bethanechol', 'finasteride', 'sildenafil',
  // Vitamins and minerals
  'ascorbic acid', 'colecalciferol', 'pyridoxine', 'retinol', 'riboflavin', 'thiamine', 'cyanocobalamin',
  'nicotinamide', 'vitamin b complex', 'multivitamin', 'vitamin e', 'zinc', 'cod liver oil',
];

/**
 * Other names for a medicine on the list: the list's own bracketed names, and (marked "added") British or older
 * names still written on Nigerian charts. Each maps to the name on NEML_GENERICS that is shown.
 */
export const SYNONYMS: Readonly<Record<string, string>> = {
  'adrenaline': 'epinephrine',
  'chlorphenamine': 'chlorpheniramine',
  'trihexyphenidyl': 'benzhexol',
  'hydroxyurea': 'hydroxycarbamide',
  'aspirin': 'acetylsalicylic acid',
  'co-trimoxazole': 'sulfamethoxazole + trimethoprim',
  'valproic acid': 'sodium valproate',
  'cyclosporin': 'ciclosporin',
  'busulphan': 'busulfan',
  'vitamin k1': 'phytomenadione',
  'vitamin c': 'ascorbic acid',
  'vitamin d': 'colecalciferol',
  'cholecalciferol': 'colecalciferol',
  'vitamin a': 'retinol',
  'vitamin b1': 'thiamine',
  'vitamin b2': 'riboflavin',
  'vitamin b6': 'pyridoxine',
  'vitamin b12': 'cyanocobalamin',
  'leuprolide': 'leuprorelin',
  'stilboestrol': 'diethylstilbestrol',
  'thioguanine': 'tioguanine',
  'mechlorethamine': 'chlormethine',
  'actinomycin d': 'dactinomycin',
  'torsemide': 'torasemide',
  'beclomethasone': 'beclometasone',
  'desferoxamine': 'desferrioxamine',
  'imipenem': 'imipenem + cilastatin',
  // Added (not in the list's brackets): British and older names commonly written in Nigeria.
  'frusemide': 'furosemide',
  'co-amoxiclav': 'amoxicillin + clavulanic acid',
  'lignocaine': 'lidocaine',
  'phenobarbitone': 'phenobarbital',
  'salbutamol sulphate': 'salbutamol',
  'ferrous sulphate': 'ferrous sulfate',
  'magnesium sulphate': 'magnesium sulfate',
  'hyoscine n-butylbromide': 'hyoscine butylbromide',
  'ors': 'oral rehydration salts',
  // Added (not in the list's brackets): US names.
  'glyburide': 'glibenclamide',
  'acyclovir': 'aciclovir',
};

/** Brand names: the active rows of brand-names.ts (see there), brand to generic. */
export const BRAND_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  BRAND_ROWS.filter(isActiveBrandRow).map((row) => [row.brand, row.generic]));

/**
 * Fuzzy match thresholds: the shared strict rules of list-match.ts (one edit, similarity 0.85, same first letter,
 * same short words and digits, names of six letters or more, ambiguous is no match). Most look-alike medicines
 * differ at the start (pefloxacin / ofloxacin, esomeprazole / omeprazole). A name within LOOKALIKE_DISTANCE of a
 * real medicine that is not on the list (UNLISTED_LOOKALIKES) is no match either, since the proposal may well be
 * that medicine.
 */
export { editDistance, LOOKALIKE_DISTANCE, MAX_EDIT_DISTANCE, MIN_FUZZY_LETTERS, MIN_SIMILARITY };

/**
 * Real medicines that are not on the list but are spelled within a letter or two of one that is (curated, not
 * exhaustive). A proposed name near one of these is never respelled into the listed medicine: on a hard page it is
 * shown as read with the listed one as the other option, "Arteether? (or Artemether?)" (drugLookalike). Each is within LOOKALIKE_DISTANCE of a listed name. The edit-distance and first-letter rules above
 * already keep most of them apart; this keeps apart a misreading of one of them as well (arteether is one letter
 * from artemether, which the distance rule alone would let through).
 */
export const UNLISTED_LOOKALIKES: readonly string[] = [
  'arteether', 'clobetasone', 'pefloxacin', 'norfloxacin', 'gemifloxacin', 'esomeprazole', 'ganciclovir',
  'famciclovir', 'lorazepam', 'oxazepam', 'felodipine', 'nisoldipine', 'prednisone', 'dicloxacillin', 'ornidazole',
  'econazole', 'bifonazole', 'tioconazole', 'methsuximide', 'dihydralazine', 'quinidine', 'rocuronium',
  'ropivacaine', 'mepivacaine', 'digitoxin', 'fosinopril', 'folinic acid', 'pentobarbital', 'saxagliptin',
];

/** Salt and form words written after a name that do not change which medicine it is. */
const SALT_WORDS = new Set(['hydrochloride', 'hcl', 'sodium', 'potassium', 'sulfate', 'sulphate', 'maleate',
  'phosphate', 'acetate', 'citrate', 'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules',
  'inj', 'injection', 'syrup', 'syr', 'susp', 'suspension', 'cream', 'oint', 'ointment', 'drops', 'iv', 'im', 'po']);

/** Lower case, "?" and punctuation other than "+" and "-" removed, "/" and "&" read as "+", spaces collapsed. */
export function normaliseDrugName(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[/&]/g, ' + ')
    .replace(/[^a-z0-9+\-' ]/g, ' ').replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim();
}

const withoutSalts = (name: string) => name.split(' ').filter((word) => !SALT_WORDS.has(word)).join(' ').trim();

export interface DrugMatch {
  /** The generic name(s) the proposed name stands for, as on the list. */
  generic: string;
  /** The brand name as listed, when the proposed name matched a brand. */
  brand: string | null;
  /** What the drug name field shows: "Generic?" or "Brand? (generic)". Always marked "?" (a best guess). */
  display: string;
  /** Whether the proposed name was a listed name as written (not respelled by the fuzzy match). */
  exact: boolean;
}

type Entry = ListEntry<{ generic: string; brand: string | null }>;
const entry = (name: string, generic: string, brand: string | null): Entry =>
  ({ key: normaliseDrugName(name), target: generic, value: { generic, brand } });
/** Every name the drug list knows, normalised, with the generic it stands for (list-match.spec.ts checks them all). */
export const DRUG_ENTRIES: readonly Entry[] = [
  ...NEML_GENERICS.map((name) => entry(name, name, null)),
  ...Object.entries(SYNONYMS).map(([name, generic]) => entry(name, generic, null)),
  ...Object.entries(BRAND_NAMES).map(([name, generic]) => entry(name, generic, name)),
];

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const LOOKALIKE_KEYS = UNLISTED_LOOKALIKES.map(normaliseDrugName);

/**
 * The listed medicine a proposed drug name stands for, or null. Exact (normalised, salt and form words taken off)
 * first; then the closest by edit distance within the thresholds, only when one medicine is closest, it starts with
 * the same letter, and no unlisted look-alike is as near. "[unreadable]", "[?]" or a name with no letters never
 * matches.
 */
export function matchDrugName(proposed: string): DrugMatch | null {
  if (NOT_FOR_LISTS.test(proposed)) return null;
  const whole = normaliseDrugName(proposed);
  if (letterCount(whole) === 0) return null;
  const candidates = [...new Set([whole, withoutSalts(whole)].filter((name) => name.length > 0))];
  const found = ({ value: { generic, brand } }: Entry, exact: boolean): DrugMatch => ({ generic, brand, exact,
    display: brand === null ? `${capitalise(generic)}?` : `${capitalise(brand)}? (${generic})` });
  for (const name of candidates) {
    const exact = DRUG_ENTRIES.find((candidate) => candidate.key === name);
    if (exact) return found(exact, true);
  }
  const best = fuzzyListMatch(candidates, DRUG_ENTRIES);
  if (best === null) return null;
  const nearUnlisted = candidates.some((name) =>
    LOOKALIKE_KEYS.some((key) => editDistance(name, key) <= LOOKALIKE_DISTANCE));
  return nearUnlisted ? null : found(best.entry, false);
}

/**
 * The listed medicine a proposed name would have been respelled into, where the strict fuzzy match found one but a
 * real unlisted look-alike (UNLISTED_LOOKALIKES) is as near, so matchDrugName refused it; else null ("Arteether" is
 * a letter from the listed artemether). Never used to pick a name: hard-page.ts shows the name as read with this one
 * as the other option, "Arteether? (or Artemether?)", so a look-alike pair is never resolved silently.
 */
export function drugLookalike(proposed: string): DrugMatch | null {
  if (NOT_FOR_LISTS.test(proposed) || matchDrugName(proposed) !== null) return null;
  const whole = normaliseDrugName(proposed);
  if (letterCount(whole) === 0) return null;
  const candidates = [...new Set([whole, withoutSalts(whole)].filter((name) => name.length > 0))];
  const best = fuzzyListMatch(candidates, DRUG_ENTRIES);
  if (best === null) return null;
  const { generic, brand } = best.entry.value;
  return { generic, brand, exact: false,
    display: brand === null ? `${capitalise(generic)}?` : `${capitalise(brand)}? (${generic})` };
}
