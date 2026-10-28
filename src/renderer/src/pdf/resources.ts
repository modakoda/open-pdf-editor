import { releaseSources } from './pdfjs'
import { releasePreviews } from './previews'
import { releaseTextIndexes } from './textSearch'
import { releaseThumbnails } from './thumbnails'

/** Free pdf.js documents, thumbnails and text indexes of sources not in `keepSourceIds`, and all page previews. */
export function releasePdfResources(keepSourceIds: Iterable<string>): void {
  const keep = [...keepSourceIds]
  releaseSources(keep)
  releaseThumbnails(keep)
  releaseTextIndexes(keep)
  releasePreviews()
}
