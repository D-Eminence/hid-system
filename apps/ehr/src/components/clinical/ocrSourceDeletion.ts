/**
 * The OCR worker deletes a scanned page, its text and its reading 24 hours after the OCR job finished (migration
 * 0110; owner decision of 2026-11-11). The document then lists with status 'source_deleted' and its extractions come
 * back with contentDeleted: true. What a person saved into the record stays; there is nothing left to review.
 * No imports, so the node test can load it on its own.
 */
export const SOURCE_DELETED_STATUS = 'source_deleted';
export const SOURCE_DELETED_MESSAGE = 'Source page deleted after 24 hours';
export const CONTENT_DELETED_MESSAGE = 'Content deleted after 24 hours';

export interface OcrReviewVisibility {
  /** Ask ehr-api for a signed preview of the page (never for a deleted one: it answers 410). */
  loadPreview: boolean;
  /** Shown instead of the page preview. */
  sourceNotice: string | null;
  /** Shown instead of the extraction and the review controls. */
  contentNotice: string | null;
}

export function ocrReviewVisibility(document: { status: string } | null,
  extraction: { contentDeleted: boolean } | null): OcrReviewVisibility {
  const sourceDeleted = document?.status === SOURCE_DELETED_STATUS;
  const contentDeleted = sourceDeleted || extraction?.contentDeleted === true;
  return {
    loadPreview: document !== null && !sourceDeleted,
    sourceNotice: sourceDeleted ? SOURCE_DELETED_MESSAGE : null,
    contentNotice: contentDeleted ? CONTENT_DELETED_MESSAGE : null,
  };
}
