/**
 * The medicine names a hard page's best-guess drug name may be shown as (owner decision of 2026-11-05, about
 * 18:40 UTC: "Yes, use a drug list"). Used only on hard pages (see reader.ts, hard-page reads): a drug name the
 * model proposes is shown only when it matches a name here; otherwise the drug name field is "[unreadable]".
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
 * plus a few British names still written on Nigerian charts, marked as added here.
 *
 * BRAND NAMES (BRAND_NAMES, below and kept apart): curated, not exhaustive; review before relying on it. A small
 * conservative list of brand names commonly written on Nigerian prescriptions, each mapped to its generic name(s)
 * on the list above. A brand is shown as "Brand? (generic)". Only true brand names; a manufacturer's name alone
 * (such as a company that makes paracetamol) is never a brand here.
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
  'glyburide': 'glibenclamide',
  'salbutamol sulphate': 'salbutamol',
  'ferrous sulphate': 'ferrous sulfate',
  'magnesium sulphate': 'magnesium sulfate',
  'hyoscine n-butylbromide': 'hyoscine butylbromide',
  'ors': 'oral rehydration salts',
};

/**
 * Brand names: curated, not exhaustive; review before relying on it. Each maps to its generic name on
 * NEML_GENERICS (or, for a combination brand, the generics it combines, each on the list). Conservative on
 * purpose: only brand names long and widely written on Nigerian prescriptions.
 */
export const BRAND_NAMES: Readonly<Record<string, string>> = {
  'plasil': 'metoclopramide',
  'flagyl': 'metronidazole',
  'augmentin': 'amoxicillin + clavulanic acid',
  'rocephin': 'ceftriaxone',
  'zinnat': 'cefuroxime',
  'amoxil': 'amoxicillin',
  'ampiclox': 'ampicillin + cloxacillin',
  'septrin': 'sulfamethoxazole + trimethoprim',
  'panadol': 'paracetamol',
  'coartem': 'artemether + lumefantrine',
  'fansidar': 'sulfadoxine + pyrimethamine',
  'daraprim': 'pyrimethamine',
  'lasix': 'furosemide',
  'voltaren': 'diclofenac',
  'glucophage': 'metformin',
  'norvasc': 'amlodipine',
  'adalat': 'nifedipine',
  'buscopan': 'hyoscine butylbromide',
  'valium': 'diazepam',
  'phenergan': 'promethazine',
  'piriton': 'chlorpheniramine',
  'ventolin': 'salbutamol',
  'postinor': 'levonorgestrel',
};

/**
 * Fuzzy match thresholds (tested in drug-list.spec.ts). A name of MIN_FUZZY_LETTERS letters or more matches a
 * listed name at an edit distance of at most MAX_EDIT_DISTANCE and a similarity ratio (1 - distance / longer
 * length) of at least MIN_SIMILARITY; a shorter name must match exactly. Two different medicines matching
 * equally well is no match (ambiguous): the screen never picks one of two lookalikes.
 */
export const MIN_FUZZY_LETTERS = 6;
export const MAX_EDIT_DISTANCE = 2;
export const MIN_SIMILARITY = 0.8;

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

export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(above + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

export interface DrugMatch {
  /** The generic name(s) the proposed name stands for, as on the list. */
  generic: string;
  /** The brand name as listed, when the proposed name matched a brand. */
  brand: string | null;
  /** What the drug name field shows: "Generic?" or "Brand? (generic)". Always marked "?" (a best guess). */
  display: string;
}

interface Entry { key: string; generic: string; brand: string | null }
const ENTRIES: readonly Entry[] = [
  ...NEML_GENERICS.map((name) => ({ key: normaliseDrugName(name), generic: name, brand: null })),
  ...Object.entries(SYNONYMS).map(([name, generic]) => ({ key: normaliseDrugName(name), generic, brand: null })),
  ...Object.entries(BRAND_NAMES).map(([name, generic]) => ({ key: normaliseDrugName(name), generic, brand: name })),
];

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const letters = (text: string) => text.replace(/[^a-z]/g, '').length;

/**
 * The listed medicine a proposed drug name stands for, or null. Exact (normalised, salt and form words taken off)
 * first; then the closest by edit distance within the thresholds, only when one medicine is closest. "[unreadable]"
 * or a name with no letters never matches.
 */
export function matchDrugName(proposed: string): DrugMatch | null {
  if (/\[unreadable\]/i.test(proposed)) return null;
  const whole = normaliseDrugName(proposed);
  if (letters(whole) === 0) return null;
  const candidates = [...new Set([whole, withoutSalts(whole)].filter((name) => name.length > 0))];
  const found = (entry: Entry): DrugMatch => ({ generic: entry.generic, brand: entry.brand,
    display: entry.brand === null ? `${capitalise(entry.generic)}?` : `${capitalise(entry.brand)}? (${entry.generic})` });
  for (const name of candidates) {
    const exact = ENTRIES.find((entry) => entry.key === name);
    if (exact) return found(exact);
  }
  let best: { entry: Entry; distance: number } | null = null;
  let ambiguous = false;
  for (const name of candidates) {
    if (letters(name) < MIN_FUZZY_LETTERS) continue;
    for (const entry of ENTRIES) {
      if (letters(entry.key) < MIN_FUZZY_LETTERS) continue;
      const distance = editDistance(name, entry.key);
      const similarity = 1 - distance / Math.max(name.length, entry.key.length);
      if (distance > MAX_EDIT_DISTANCE || similarity < MIN_SIMILARITY) continue;
      if (best === null || distance < best.distance) { best = { entry, distance }; ambiguous = false; }
      else if (distance === best.distance && entry.generic !== best.entry.generic) ambiguous = true;
    }
  }
  return best === null || ambiguous ? null : found(best.entry);
}
