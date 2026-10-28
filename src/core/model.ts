/**
 * Document model shared by the PDF engine (src/core) and the UI (src/renderer).
 *
 * Design:
 * - The original PDF bytes are never mutated. An `EditorDocument` describes the output:
 *   which pages (from which sources) appear in which order and rotation, which new objects
 *   are drawn on them, which form values are set, and document-level settings.
 * - The UI renders source pages with pdf.js and draws `EditObject`s as an interactive overlay.
 * - `exportDocument()` (src/core/export.ts) turns an `EditorDocument` into real PDF bytes.
 * - All operations on the model are pure (return a new object) so undo/redo is a stack
 *   of snapshots that share unchanged data structurally.
 *
 * Coordinate system ("page space"):
 * - Units are PDF points (1/72 inch).
 * - Origin is the top-left corner of the page's visible box (crop box), BEFORE any page
 *   rotation is applied. x grows to the right, y grows downwards.
 * - Because objects live in unrotated page space, rotating a page rotates its objects too.
 * - `rotation` on box objects is in degrees, clockwise as seen in page space, around the
 *   center of the box.
 */

export type Rotation = 0 | 90 | 180 | 270

/** Hex color string: "#rrggbb". */
export type Color = string

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Generic font families. Mapped to standard PDF fonts or embedded Unicode fonts on export. */
export type FontFamily = 'sans' | 'serif' | 'mono'

export interface DocumentMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
}

export type FormFieldType =
  | 'text'
  | 'checkbox'
  | 'radio'
  | 'dropdown'
  | 'optionlist'
  | 'button'
  | 'signature'
  | 'unknown'

/** text → string, checkbox → boolean, radio/dropdown → string, optionlist → string[] */
export type FormValue = string | boolean | string[]

export interface FormFieldWidget {
  /** Index of the page within the field's source document. */
  pageIndex: number
  /** Widget rectangle in page space of that page. */
  box: Box
  /** For checkboxes/radios: the export value that this widget represents when "on". */
  onValue?: string
}

export interface FormFieldInfo {
  /** Fully qualified field name (unique within its source). */
  name: string
  /**
   * Checkbox fields whose widgets have different on-values (e.g. a "Yes" box and a "No"
   * box) behave like radio groups and are reported as 'radio' (value = export value that is on).
   */
  type: FormFieldType
  /** Value as stored in the source file. */
  value: FormValue
  /**
   * Choices for radio / dropdown / optionlist. These are the export values that `value`
   * holds (what is written to /V).
   */
  options?: string[]
  /**
   * Display text of each option, aligned with `options`. Only present when a choice field
   * defines [export value, display text] pairs that differ; show these labels in the UI and
   * store the corresponding `options[i]` as the value.
   */
  optionLabels?: string[]
  readOnly: boolean
  required?: boolean
  multiline?: boolean
  maxLength?: number
  widgets: FormFieldWidget[]
}

/** Geometry of one page of a source file (filled in by loadSource). */
export interface SourcePageInfo {
  /** Unrotated size of the visible box (crop box ∩ media box), in points. */
  width: number
  height: number
  /** The page's /Rotate, normalized to 0/90/180/270. */
  rotation: Rotation
}

/** A PDF file that pages are taken from. The first opened file is the primary source. */
export interface SourceDocument {
  id: string
  /** File name for display, e.g. "contract.pdf". */
  name: string
  /** Original file bytes exactly as read from disk (may be encrypted). Never mutated. */
  bytes: Uint8Array
  /** Password used to decrypt the file, if it is encrypted. */
  password?: string
  isEncrypted: boolean
  /**
   * Which of the file's passwords `password` is ('user' = the password to open it, 'owner' =
   * the full-permission password). Undefined when not encrypted or not determinable.
   */
  passwordKind?: 'user' | 'owner'
  /**
   * The user (open) password when known: equal to `password` for passwordKind 'user';
   * recovered from the file for RC4 / AES-128 files opened with the owner password;
   * undefined for AES-256 files opened with the owner password (it cannot be recovered).
   */
  userPassword?: string
  /** Permissions granted to user-password holders by an encrypted file (from /P). */
  permissions?: DocumentPermissions
  pageCount: number
  metadata: DocumentMetadata
  formFields: FormFieldInfo[]
  /**
   * Per-page geometry, index = page index in this file (length = pageCount). Always set by
   * loadSource(); optional only so hand-built SourceDocuments stay valid (A4 is assumed then).
   */
  pageInfo?: SourcePageInfo[]
}

export type PageSource =
  | { kind: 'source'; sourceId: string; pageIndex: number }
  | { kind: 'blank' }

export interface PageEntry {
  /** Stable id; objects reference pages by this id, so reordering keeps them attached. */
  id: string
  source: PageSource
  /** Unrotated size of the visible (crop) box, in points. */
  width: number
  height: number
  /** /Rotate value of the page in its source file (0 for blank pages). */
  baseRotation: Rotation
  /** Extra rotation applied by the user. Displayed rotation = (baseRotation + rotation) % 360. */
  rotation: Rotation
}

interface BaseObject {
  id: string
  pageId: string
  /** 0..1, default 1. */
  opacity?: number
}

export interface TextObject extends BaseObject, Box {
  type: 'text'
  /** May contain "\n". Lines are additionally wrapped to `width`. */
  text: string
  font: FontFamily
  bold: boolean
  italic: boolean
  fontSize: number
  color: Color
  align: 'left' | 'center' | 'right'
  /** Line height as a multiple of fontSize (default 1.2). */
  lineHeight: number
  rotation: number
  /** Optional opaque fill behind the text (used by "edit existing text" to cover the original). */
  background?: Color | null
}

export interface ImageObject extends BaseObject, Box {
  type: 'image'
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  rotation: number
}

export interface ShapeObject extends BaseObject, Box {
  type: 'rect' | 'ellipse'
  strokeColor: Color | null
  fillColor: Color | null
  strokeWidth: number
  rotation: number
}

/** Translucent marker. Exported with Multiply blend mode; default opacity 0.4. */
export interface HighlightObject extends BaseObject, Box {
  type: 'highlight'
  color: Color
}

/** Opaque cover (default white). NOTE: hides content visually; it does not remove it. */
export interface WhiteoutObject extends BaseObject, Box {
  type: 'whiteout'
  color: Color
}

export interface LineObject extends BaseObject {
  type: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: Color
  strokeWidth: number
  /** Draw an arrow head at (x2, y2). */
  arrowEnd: boolean
}

/** Freehand drawing. Each path is a polyline in page space. */
export interface InkObject extends BaseObject {
  type: 'ink'
  paths: Point[][]
  color: Color
  strokeWidth: number
}

/** Sticky-note comment. Exported as a real PDF /Text annotation anchored at (x, y). */
export interface NoteObject extends BaseObject {
  type: 'note'
  x: number
  y: number
  text: string
  color: Color
  author?: string
}

export type EditObject =
  | TextObject
  | ImageObject
  | ShapeObject
  | HighlightObject
  | WhiteoutObject
  | LineObject
  | InkObject
  | NoteObject

export type EditObjectType = EditObject['type']

/** Objects that are positioned by a Box (movable/resizable via handles). */
export type BoxObject = TextObject | ImageObject | ShapeObject | HighlightObject | WhiteoutObject

export type PageNumberPosition =
  | 'bottom-center'
  | 'bottom-right'
  | 'bottom-left'
  | 'top-center'
  | 'top-right'
  | 'top-left'

export interface WatermarkSettings {
  text: string
  fontSize: number
  color: Color
  /** 0..1 */
  opacity: number
  /** Degrees counter-clockwise as seen by the reader (45 = classic diagonal). */
  angle: number
}

export interface PageNumberSettings {
  /** Template: "{n}" is replaced by the page number, "{total}" by the page count. */
  format: string
  position: PageNumberPosition
  fontSize: number
  color: Color
  /** Number printed on the first page (default 1). */
  startAt: number
  /** Distance from the page edge in points (default 24). */
  margin: number
}

/** What a reader that opened the file with the user password may do. */
export interface DocumentPermissions {
  printing: 'none' | 'lowResolution' | 'highResolution'
  modifying: boolean
  copying: boolean
  annotating: boolean
  fillingForms: boolean
  contentAccessibility: boolean
  documentAssembly: boolean
}

export interface EncryptionSettings {
  /** Password required to open the document ('' = opens without a password). */
  userPassword: string
  /**
   * Password for full permissions. When omitted it defaults to userPassword, unless
   * `permissions` restrict something: then a random owner password is generated so the
   * restrictions cannot be lifted with the user password.
   */
  ownerPassword?: string
  /** Restrictions for user-password holders. Omitted = everything allowed. */
  permissions?: DocumentPermissions
}

export interface DocumentSettings {
  /** Overrides applied on top of the primary source's metadata. */
  metadata: DocumentMetadata
  watermark: WatermarkSettings | null
  pageNumbers: PageNumberSettings | null
  /** Burn form fields into page content on export. */
  flattenForms: boolean
  /** Encrypt on export. Pre-filled with the source password when an encrypted file is opened. */
  encryption: EncryptionSettings | null
}

export interface EditorDocument {
  /** Source whose structure (forms, outline, metadata) is preserved on export. Null for a new blank document. */
  primarySourceId: string | null
  sources: Record<string, SourceDocument>
  /** Output pages in order. */
  pages: PageEntry[]
  /** Objects added by the user, in z-order (later = on top). */
  objects: EditObject[]
  /** User-changed form values: sourceId → field name → value. */
  formValues: Record<string, Record<string, FormValue>>
  settings: DocumentSettings
}

/** Standard page sizes in points. */
export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  A3: { width: 841.89, height: 1190.55 },
  A5: { width: 419.53, height: 595.28 }
} as const

export type PageSizeName = keyof typeof PAGE_SIZES

export function isBoxObject(obj: EditObject): obj is BoxObject {
  return (
    obj.type === 'text' ||
    obj.type === 'image' ||
    obj.type === 'rect' ||
    obj.type === 'ellipse' ||
    obj.type === 'highlight' ||
    obj.type === 'whiteout'
  )
}
