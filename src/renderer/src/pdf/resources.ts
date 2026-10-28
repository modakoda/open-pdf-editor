import { releaseSources } from './pdfjs'
import { releaseTextIndexes } from './textSearch'
import { releaseThumbnails } from './thumbnails'

/** Free pdf.js documents, thumbnails and text indexes of sources not in `keepSourceIds`. */
export function releasePdfResources(keepSourceIds: Iterable<string>): void {
  const keep = [...keepSourceIds]
  releaseSources(keep)
  releaseThumbnails(keep)
  releaseTextIndexes(keep)
}
