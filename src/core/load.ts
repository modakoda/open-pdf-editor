import {
  PDFButton,
  PDFCheckBox,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFSignature,
  PDFTextField,
  type PDFDocument,
  type PDFRef,
  type PDFField,
  type PDFPage,
  type PDFWidgetAnnotation
} from '@cantoo/pdf-lib'
import { createId } from './ids'
import { PAGE_SIZES } from './model'
import { allPermissionsGranted } from './security'
import type {
  DocumentMetadata,
  EditorDocument,
  EncryptionSettings,
  FormFieldInfo,
  FormFieldWidget,
  PageEntry,
  SourceDocument,
  SourcePageInfo
} from './model'
import { createWidgetPageFinder, openPdfLib, pageRotation, rectFromArray, visibleBox } from './pdf'
import {
  buttonOptions,
  buttonStates,
  choiceOptions,
  choiceSelection,
  isMultiStateCheckBox,
  selectedButtonValue,
  widgetRefs
} from './formFields'
import type { PdfBox } from './geometry'

export interface LoadOptions {
  /** Password for encrypted files. Pass '' explicitly to try an empty password. */
  password?: string
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

function readMetadata(doc: PDFDocument): DocumentMetadata {
  const md: DocumentMetadata = {}
  const set = (key: keyof DocumentMetadata, value: string | undefined) => {
    if (typeof value === 'string') md[key] = value
  }
  set('title', safe(() => doc.getTitle()))
  set('author', safe(() => doc.getAuthor()))
  set('subject', safe(() => doc.getSubject()))
  set('keywords', safe(() => doc.getKeywords()))
  set('creator', safe(() => doc.getCreator()))
  set('producer', safe(() => doc.getProducer()))
  return md
}

function widgetBox(widget: PDFWidgetAnnotation, vb: PdfBox): FormFieldWidget['box'] | undefined {
  const r = rectFromArray(safe(() => widget.Rect()))
  if (!r) return undefined
  return { x: r.x - vb.x, y: vb.y + vb.height - (r.y + r.height), width: r.width, height: r.height }
}

function describeField(
  field: PDFField,
  findPage: (w: PDFWidgetAnnotation, ref?: PDFRef) => number | undefined,
  boxes: PdfBox[]
): FormFieldInfo | undefined {
  const name = field.getName()
  if (!name) return undefined
  const widgetsRaw = safe(() => field.acroField.getWidgets()) ?? []
  const refs = widgetRefs(field)
  const onValues: (string | undefined)[] = []
  let info: Omit<FormFieldInfo, 'widgets' | 'name' | 'readOnly' | 'required'>

  if (field instanceof PDFTextField) {
    info = {
      type: 'text',
      value: safe(() => field.getText()) ?? '',
      multiline: safe(() => field.isMultiline()) ?? false
    }
    const max = safe(() => field.getMaxLength())
    if (typeof max === 'number') info.maxLength = max
  } else if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    const states = buttonStates(field)
    states.forEach((s) => onValues.push(s.exportValue))
    if (field instanceof PDFCheckBox && !isMultiStateCheckBox(field)) {
      info = { type: 'checkbox', value: selectedButtonValue(field, states) !== '' }
    } else {
      // Radio groups, and checkbox groups whose widgets have different on-values
      // (e.g. a "Yes" box and a "No" box): the value is the export value that is on.
      info = { type: 'radio', value: selectedButtonValue(field, states), options: buttonOptions(states) }
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const options = choiceOptions(field)
    const selection = choiceSelection(field, options)
    info =
      field instanceof PDFDropdown
        ? { type: 'dropdown', value: selection[0] ?? '' }
        : { type: 'optionlist', value: selection }
    info.options = options.map((o) => o.value)
    if (options.some((o) => o.label !== o.value)) info.optionLabels = options.map((o) => o.label)
  } else if (field instanceof PDFButton) {
    info = { type: 'button', value: '' }
  } else if (field instanceof PDFSignature) {
    info = { type: 'signature', value: '' }
  } else {
    info = { type: 'unknown', value: '' }
  }

  const widgets: FormFieldWidget[] = []
  widgetsRaw.forEach((w, i) => {
    const pageIndex = findPage(w, refs[i])
    if (pageIndex === undefined) return
    const box = widgetBox(w, boxes[pageIndex])
    if (!box) return
    const widget: FormFieldWidget = { pageIndex, box }
    const on = onValues[i]
    if (on !== undefined && on !== 'Off') widget.onValue = on
    widgets.push(widget)
  })

  return {
    name,
    ...info,
    readOnly: safe(() => field.isReadOnly()) ?? false,
    required: safe(() => field.isRequired()) ?? false,
    widgets
  }
}

function readFormFields(doc: PDFDocument, pages: PDFPage[], boxes: PdfBox[]): FormFieldInfo[] {
  // Do not create an AcroForm where there is none.
  if (!safe(() => doc.catalog.lookup(PDFName.of('AcroForm')))) return []
  const form = safe(() => doc.getForm())
  if (!form) return []
  const fields = safe(() => form.getFields()) ?? []
  const findPage = createWidgetPageFinder(doc, pages)
  const result: FormFieldInfo[] = []
  for (const field of fields) {
    const info = safe(() => describeField(field, findPage, boxes))
    if (info) result.push(info)
  }
  return result
}

/**
 * Parse a PDF file into a SourceDocument (page count, metadata, form fields).
 * Throws PasswordRequiredError / InvalidPasswordError / PdfLoadError (see ./errors).
 */
export async function loadSource(bytes: Uint8Array, name: string, options?: LoadOptions): Promise<SourceDocument> {
  const opened = await openPdfLib(bytes, options?.password)
  const { doc } = opened
  const pages = doc.getPages()
  const boxes = pages.map(visibleBox)
  const pageInfo: SourcePageInfo[] = pages.map((p, i) => ({
    width: boxes[i].width,
    height: boxes[i].height,
    rotation: pageRotation(p)
  }))
  const source: SourceDocument = {
    id: createId('src'),
    name,
    bytes,
    isEncrypted: opened.isEncrypted,
    pageCount: pages.length,
    metadata: readMetadata(doc),
    formFields: readFormFields(doc, pages, boxes),
    pageInfo
  }
  if (opened.isEncrypted) {
    source.password = opened.password
    if (opened.passwordKind) source.passwordKind = opened.passwordKind
    if (opened.userPassword !== undefined) source.userPassword = opened.userPassword
    if (opened.permissions) source.permissions = opened.permissions
  }
  return source
}

/**
 * Encryption settings that re-create the protection of an opened encrypted file:
 * - opened with the user password: same user password and permissions; the unknown owner
 *   password is replaced by a random one if permissions are restricted (see applyEncryption);
 * - opened with the owner password: the same owner password and permissions, and the user
 *   password recovered from the file (RC4 / AES-128). For AES-256 files the user password
 *   cannot be recovered, so it is left empty: the UI should ask for a new open password
 *   (`source.passwordKind === 'owner' && source.userPassword === undefined`).
 * - owner-password-only files opened without a password: null (saved unencrypted).
 */
export function encryptionFromSource(source: SourceDocument): EncryptionSettings | null {
  if (!source.isEncrypted) return null
  const permissions = source.permissions && !allPermissionsGranted(source.permissions) ? source.permissions : undefined
  const withPermissions = (e: EncryptionSettings): EncryptionSettings => (permissions ? { ...e, permissions } : e)
  if (source.passwordKind === 'owner' && source.password) {
    return withPermissions({ userPassword: source.userPassword ?? '', ownerPassword: source.password })
  }
  const user = source.userPassword ?? source.password
  if (!user) return null
  return withPermissions({ userPassword: user })
}

function pageEntriesFor(source: SourceDocument): PageEntry[] {
  return Array.from({ length: source.pageCount }, (_, pageIndex) => {
    const info = source.pageInfo?.[pageIndex]
    return {
      id: createId('page'),
      source: { kind: 'source', sourceId: source.id, pageIndex },
      width: info?.width ?? PAGE_SIZES.A4.width,
      height: info?.height ?? PAGE_SIZES.A4.height,
      baseRotation: info?.rotation ?? 0,
      rotation: 0
    }
  })
}

/** EditorDocument for an already loaded source (one PageEntry per page). */
export function documentFromSource(source: SourceDocument): EditorDocument {
  return {
    primarySourceId: source.id,
    sources: { [source.id]: source },
    pages: pageEntriesFor(source),
    objects: [],
    formValues: {},
    settings: {
      metadata: {},
      watermark: null,
      pageNumbers: null,
      flattenForms: false,
      encryption: encryptionFromSource(source)
    }
  }
}

/**
 * Open a file as a new EditorDocument: one PageEntry per page of the file, no objects,
 * settings derived from the file (metadata, encryption pre-filled with the password).
 */
export async function openDocument(bytes: Uint8Array, name: string, options?: LoadOptions): Promise<EditorDocument> {
  return documentFromSource(await loadSource(bytes, name, options))
}

/** A new untitled document with one blank page (A4 by default). */
export function createBlankDocument(size?: { width: number; height: number }): EditorDocument {
  const dims = size ?? PAGE_SIZES.A4
  return {
    primarySourceId: null,
    sources: {},
    pages: [
      {
        id: createId('page'),
        source: { kind: 'blank' },
        width: dims.width,
        height: dims.height,
        baseRotation: 0,
        rotation: 0
      }
    ],
    objects: [],
    formValues: {},
    settings: {
      metadata: {},
      watermark: null,
      pageNumbers: null,
      flattenForms: false,
      encryption: null
    }
  }
}
