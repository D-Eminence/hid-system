export interface ImportedMedicalRecord {
  id: string;
  origin: 'patient-provided' | 'provider-authored';
  currentVersionId: string;
  title: string | null;
  category: string | null;
  infoType: string | null;
  createdAt: string;
  updatedAt: string;
  versions: Array<{
    id: string; versionNo: number; origin: 'patient-provided' | 'provider-authored';
    createdAt: string; record: unknown; notes: unknown; structuredData: unknown; transcriptionText: unknown;
  }>;
  files: Array<{
    id: string; recordVersionId: string | null; fileName: string | null;
    mediaType: string | null; sizeBytes: number; createdAt: string;
    accessStatus: 'pending-safety-verification' | 'available' | 'rejected';
  }>;
}

export interface ImportedHealthProfile {
  content: Partial<Record<'blood_group' | 'genotype' | 'allergies' | 'chronic_conditions' | 'current_medications' | 'medical_notes', unknown>>;
  updatedAt: string;
}
