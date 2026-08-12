export type PricingVisibility = 'fixed' | 'starting_from' | 'contact_sales' | 'custom_quote' | 'hidden'
export type ProductContext = 'core' | 'addon' | 'standalone' | 'usage'

export type CommercialProduct = {
  slug: string
  name: string
  eyebrow: string
  headline: string
  description: string
  capabilities: string[]
  contexts: ProductContext[]
  badges: string[]
  availability: 'available' | 'coming_soon'
}

export const products: CommercialProduct[] = [
  { slug: 'identity', name: 'HID Identity', eyebrow: 'The foundation', headline: 'One patient. One health identity.', description: 'A persistent digital health identity that connects each patient’s healthcare journey across participating providers.', capabilities: ['Portable HID', 'Connected health records', 'Access history', 'Patient-controlled sharing', 'Emergency access', 'Cross-provider continuity'], contexts: ['core'], badges: ['HID Foundation'], availability: 'available' },
  { slug: 'ehr', name: 'HID EHR', eyebrow: 'Core hospital subscription', headline: 'Run your hospital from one connected system.', description: 'A modular hospital operating system built around real clinical and operational workflows-from registration and triage to consultation, admission, billing, laboratory, pharmacy, and discharge.', capabilities: ['Patient registration', 'Appointments and triage', 'Consultation and admissions', 'Billing', 'Staff and roles', 'Reports and audit'], contexts: ['core'], badges: ['Core Subscription', 'Modular'], availability: 'available' },
  { slug: 'laboratory', name: 'HID Laboratory', eyebrow: 'Diagnostics', headline: 'Manage the complete laboratory workflow.', description: 'Manage test requests, samples, processing, verification, results, and laboratory reporting in one connected workflow.', capabilities: ['Test requests', 'Sample collection', 'Sample tracking', 'Processing', 'Results and verification', 'Laboratory reports'], contexts: ['addon', 'standalone'], badges: ['EHR Add-on', 'Standalone'], availability: 'available' },
  { slug: 'pharmacy', name: 'HID Pharmacy', eyebrow: 'Stock to sale', headline: 'Manage pharmacy operations from stock to sale.', description: 'Connect prescribing and dispensing with inventory, purchasing, suppliers, expiry tracking, POS, and reporting.', capabilities: ['Prescriptions', 'Dispensing', 'Inventory and POS', 'Suppliers', 'Expiry tracking', 'Purchasing and reporting'], contexts: ['addon', 'standalone'], badges: ['EHR Add-on', 'Standalone'], availability: 'available' },
  { slug: 'migrate', name: 'HID Migrate', eyebrow: 'Legacy digitization', headline: 'Bring your existing patient folders into the digital future.', description: 'Digitize physical patient records using mobile and batch scanning, OCR, AI-assisted extraction, human validation, patient matching, and structured migration into HID.', capabilities: ['Mobile and batch scanning', 'OCR and AI extraction', 'Human validation', 'Patient matching', 'Structured migration', 'Source lineage'], contexts: ['addon', 'standalone', 'usage'], badges: ['EHR Add-on', 'Standalone Service'], availability: 'available' },
  { slug: 'outreach', name: 'HID Outreach', eyebrow: 'Care beyond hospital walls', headline: 'Take connected healthcare beyond hospital walls.', description: 'Manage medical outreach programs, field registration, patient records, outreach teams, and reporting.', capabilities: ['Campaign management', 'Field registration', 'Connected patient records', 'Team coordination', 'Consent', 'Reporting'], contexts: ['standalone'], badges: ['Standalone', 'HID Connected'], availability: 'available' },
  { slug: 'api', name: 'HID API', eyebrow: 'Integration layer', headline: 'Use HID. Or connect what you already use.', description: 'Connect existing EHRs, hospital systems, laboratories, pharmacies, HMOs, health apps, and third-party platforms to the HID ecosystem.', capabilities: ['Identity connectivity', 'Record interoperability', 'Secure integrations', 'Developer resources', 'Auditability', 'Existing-system support'], contexts: ['usage'], badges: ['Developers', 'Integration'], availability: 'coming_soon' },
]

export const facilityTypes = ['Clinic', 'Specialist Clinic', 'Hospital', 'Specialist Hospital', 'Maternity Centre', 'Diagnostic Centre', 'Multi-Branch Hospital', 'Teaching Hospital', 'Other']
export const departments = ['General OPD', 'Emergency', 'Inpatient', 'Maternity', 'Pediatrics', 'ICU', 'Theatre', 'Radiology', 'Dental', 'Physiotherapy', 'Dialysis', 'Cardiology', 'Oncology', 'Mental Health', 'Immunization', 'HIV Program', 'TB Program', 'Other']
export const ehrAddons = products.filter(product => product.contexts.includes('addon')).concat([
  { slug: 'hmo-claims', name: 'HMO & Claims', eyebrow: 'Care and coverage', headline: 'Connect care and coverage.', description: 'Eligibility, pre-authorization, claims, and HMO connectivity.', capabilities: [], contexts: ['addon'], badges: ['Planned availability'], availability: 'coming_soon' },
  { slug: 'analytics', name: 'Advanced Analytics', eyebrow: 'Operational intelligence', headline: 'Understand performance across your operation.', description: 'Advanced operational and clinical reporting for approved deployments.', capabilities: [], contexts: ['addon'], badges: ['Planned availability'], availability: 'coming_soon' },
] as CommercialProduct[])

export const solutions = [
  ['Hospitals', ['HID EHR', 'HID Laboratory', 'HID Pharmacy', 'HID Migrate', 'HMO & Claims']],
  ['Clinics', ['HID Identity', 'HID EHR', 'HID Laboratory']],
  ['Laboratories', ['HID Laboratory', 'HID Identity', 'HID API']],
  ['Pharmacies', ['HID Pharmacy', 'HID Identity', 'HID API']],
  ['Outreach Organizations', ['HID Outreach', 'HID Identity']],
  ['NGOs', ['HID Outreach', 'HID Migrate', 'HID API']],
  ['HMOs', ['HMO & Claims', 'HID API', 'HID Identity']],
  ['Health-Tech Providers', ['HID API', 'HID Identity']],
] as const
