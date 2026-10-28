/**
 * AcroForm handling for the exporter (internal): fill values, regenerate appearances,
 * flatten, and drop fields that live on removed pages.
 */
import {
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFDocument,
  type PDFField,
  type PDFForm,
  type PDFObject,
  type PDFPage
} from '@cantoo/pdf-lib'
import type { FormValue } from './model'
import type { EmbedCache } from './exportFonts'
import { createWidgetPageFinder } from './pdf'
import { flattenAllWidgets } from './flatten'
import {
  buttonStates,
  choiceOptions,
  hasAppearances,
  isMultiStateCheckBox,
  needAppearancesFlag,
  syncButtonAppearanceStates,
  toExportValue,
  widgetRefs,
  withLabelsAsValue,
  writeButtonValue,
  writeChoiceValues
} from './formFields'

function quiet<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export function acroFormDict(doc: PDFDocument): PDFDict | undefined {
  const af = quiet(() => doc.catalog.lookup(PDFName.of('AcroForm')))
  return af instanceof PDFDict ? af : undefined
}

export function hasAcroForm(doc: PDFDocument): boolean {
  return !!acroFormDict(doc)
}

function asText(value: FormValue): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(', ')
  return value ? 'Yes' : ''
}

function asBool(value: FormValue): boolean {
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  const v = value.trim().toLowerCase()
  return v !== '' && v !== 'false' && v !== 'off' && v !== '0' && v !== 'no'
}

/** Apply one value to a field. Invalid values (unknown options) are ignored. */
function applyValue(field: PDFField, value: FormValue): boolean {
  if (field instanceof PDFTextField) {
    let text = asText(value)
    const max = quiet(() => field.getMaxLength())
    if (typeof max === 'number' && [...text].length > max) text = [...text].slice(0, max).join('')
    field.setText(text)
    return true
  }
  if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
    const states = buttonStates(field)
    if (field instanceof PDFCheckBox && !isMultiStateCheckBox(field)) {
      const on = states.find((s) => s.onState)?.onState ?? 'Yes'
      return writeButtonValue(field, asBool(value) ? on : '', states)
    }
    // Radio groups and checkbox groups with several on-values: the value is an export value.
    const v = Array.isArray(value) ? (value[0] ?? '') : typeof value === 'string' ? value : ''
    if (value === true) return writeButtonValue(field, states.find((s) => s.exportValue)?.exportValue ?? '', states)
    return writeButtonValue(field, v, states)
  }
  if (field instanceof PDFDropdown) {
    const options = choiceOptions(field)
    const raw = Array.isArray(value) ? (value[0] ?? '') : asText(value)
    const v = raw ? toExportValue(raw, options) : ''
    if (v && !options.some((o) => o.value === v)) field.enableEditing()
    writeChoiceValues(field, v ? [v] : [], options)
    return true
  }
  if (field instanceof PDFOptionList) {
    const options = choiceOptions(field)
    const wanted = (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []).map((v) =>
      toExportValue(v, options)
    )
    const valid = [...new Set(wanted.filter((v) => options.some((o) => o.value === v)))]
    const multi = quiet(() => field.isMultiselect()) ?? false
    writeChoiceValues(field, multi ? valid : valid.slice(0, 1), options)
    return true
  }
  return false
}

/** Text shown by a field's appearance (used to pick a font that can draw it). */
function displayedText(field: PDFField): string {
  if (field instanceof PDFTextField) return quiet(() => field.getText()) ?? ''
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    return choiceOptions(field)
      .map((o) => o.label)
      .join(' ')
  }
  if (field instanceof PDFButton) return ''
  return ''
}

type DASnapshot = Array<{ dict: PDFDict; value: PDFObject | undefined }>

function snapshotDA(field: PDFField): DASnapshot {
  const dicts = [field.acroField.dict, ...(quiet(() => field.acroField.getWidgets()) ?? []).map((w) => w.dict)]
  return [...new Set(dicts)].map((dict) => ({ dict, value: dict.get(PDFName.of('DA')) }))
}

function restoreDA(snapshot: DASnapshot): void {
  for (const { dict, value } of snapshot) {
    if (value) dict.set(PDFName.of('DA'), value)
    else dict.delete(PDFName.of('DA'))
  }
}

const STANDARD_DA_FONTS: Record<string, StandardFonts> = {
  Helv: StandardFonts.Helvetica,
  HeBo: StandardFonts.HelveticaBold,
  HeOb: StandardFonts.HelveticaOblique,
  HeBO: StandardFonts.HelveticaBoldOblique,
  TiRo: StandardFonts.TimesRoman,
  TiBo: StandardFonts.TimesRomanBold,
  TiIt: StandardFonts.TimesRomanItalic,
  TiBI: StandardFonts.TimesRomanBoldItalic,
  Cour: StandardFonts.Courier,
  CoBo: StandardFonts.CourierBold,
  CoOb: StandardFonts.CourierOblique,
  CoBO: StandardFonts.CourierBoldOblique,
  Symb: StandardFonts.Symbol,
  ZaDb: StandardFonts.ZapfDingbats
}

function daString(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined
}

/** Make sure the font named by the field's (inherited) /DA exists in the AcroForm /DR. */
function ensureDAFontInDR(doc: PDFDocument, field: PDFField): void {
  const acroForm = acroFormDict(doc)
  if (!acroForm) return
  let da: string | undefined
  for (const w of quiet(() => field.acroField.getWidgets()) ?? []) da ??= daString(w.dict.get(PDFName.of('DA')))
  let node: PDFDict | undefined = field.acroField.dict
  for (let i = 0; node && !da && i < 32; i++) {
    da = daString(node.lookup(PDFName.of('DA')))
    const parent: PDFObject | undefined = node.lookup(PDFName.of('Parent'))
    node = parent instanceof PDFDict ? parent : undefined
  }
  da ??= daString(acroForm.lookup(PDFName.of('DA')))
  const m = da && /\/([^\s/<>[\]()]+)\s+[-+\d.]+\s+Tf/.exec(da)
  if (!m) return
  const fontName = PDFName.of(m[1])
  let dr = acroForm.lookup(PDFName.of('DR'))
  if (!(dr instanceof PDFDict)) {
    dr = doc.context.obj({})
    acroForm.set(PDFName.of('DR'), dr as PDFDict)
  }
  let fonts = (dr as PDFDict).lookup(PDFName.of('Font'))
  if (!(fonts instanceof PDFDict)) {
    fonts = doc.context.obj({})
    ;(dr as PDFDict).set(PDFName.of('Font'), fonts as PDFDict)
  }
  if ((fonts as PDFDict).get(fontName)) return
  const standard = STANDARD_DA_FONTS[m[1]] ?? StandardFonts.Helvetica
  ;(fonts as PDFDict).set(fontName, doc.embedStandardFont(standard).ref)
}

/**
 * Regenerate a field's appearance streams with a font that can draw its value. The field's
 * /DA is preserved (pdf-lib would rewrite it with the appearance font and a fixed size).
 */
export async function updateFieldAppearance(doc: PDFDocument, field: PDFField, cache: EmbedCache): Promise<void> {
  const da = snapshotDA(field)
  try {
    if (field instanceof PDFCheckBox || field instanceof PDFRadioGroup) {
      if (!hasAppearances(field)) field.updateAppearances()
      syncButtonAppearanceStates(field)
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const options = choiceOptions(field)
      const font = await cache.fontForText(doc, displayedText(field))
      withLabelsAsValue(field, options, () => field.updateAppearances(font))
    } else if (field instanceof PDFTextField || field instanceof PDFButton) {
      const font = await cache.fontForText(doc, displayedText(field))
      field.updateAppearances(font)
    }
  } catch {
    // Keep the value even if no appearance could be generated; viewers render from /V.
    acroFormDict(doc)?.set(PDFName.of('NeedAppearances'), doc.context.obj(true))
  } finally {
    restoreDA(da)
    quiet(() => ensureDAFontInDR(doc, field))
  }
}

function fieldsByName(form: PDFForm): Map<string, PDFField> {
  const map = new Map<string, PDFField>()
  for (const f of quiet(() => form.getFields()) ?? []) {
    const name = quiet(() => f.getName())
    if (name && !map.has(name)) map.set(name, f)
  }
  return map
}

/** Set user values on the form's fields and regenerate their appearances. */
export async function fillForm(
  doc: PDFDocument,
  form: PDFForm,
  values: Record<string, FormValue> | undefined,
  cache: EmbedCache
): Promise<void> {
  if (!values || !Object.keys(values).length) return
  const byName = fieldsByName(form)
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    const field = byName.get(name)
    if (!field) continue
    const applied = quiet(() => applyValue(field, value))
    if (applied) await updateFieldAppearance(doc, field, cache)
  }
}

/**
 * Make the appearance streams reflect the field values before they are burned into page
 * content: always for fields without appearances, and for every field when the form says
 * /NeedAppearances (its streams may be stale).
 */
export async function refreshAppearancesForBurning(doc: PDFDocument, form: PDFForm, cache: EmbedCache): Promise<void> {
  const all = needAppearancesFlag(acroFormDict(doc))
  for (const field of quiet(() => form.getFields()) ?? []) {
    // Push buttons often carry icons: only give them an appearance when they have none.
    const stale =
      field instanceof PDFButton
        ? !hasAppearances(field)
        : all || !hasAppearances(field) || !!quiet(() => field.needsAppearancesUpdate())
    if (stale) await updateFieldAppearance(doc, field, cache)
  }
}

/** Burn every field into the page content and remove the form. */
export async function flattenForm(doc: PDFDocument, form: PDFForm, pages: PDFPage[], cache: EmbedCache): Promise<void> {
  await refreshAppearancesForBurning(doc, form, cache)
  flattenAllWidgets(doc, pages)
}

/**
 * Remove widgets that sit on removed pages; fields left without widgets are removed from
 * the form entirely so the AcroForm stays consistent with the remaining pages.
 */
export function pruneFieldsOnRemovedPages(
  doc: PDFDocument,
  form: PDFForm,
  pages: PDFPage[],
  removed: Set<number>
): void {
  if (!removed.size) return
  const findPage = createWidgetPageFinder(doc, pages)
  for (const field of quiet(() => form.getFields()) ?? []) {
    const widgets = quiet(() => field.acroField.getWidgets()) ?? []
    if (!widgets.length) continue
    const refs = widgetRefs(field)
    const onRemoved = widgets.map((w, i) => {
      const p = findPage(w, refs[i])
      return p !== undefined && removed.has(p)
    })
    if (!onRemoved.some(Boolean)) continue
    if (onRemoved.every(Boolean)) {
      quiet(() => form.acroForm.removeField(field.acroField))
      continue
    }
    const kids = quiet(() => field.acroField.Kids())
    if (!kids) continue
    const isButton = field instanceof PDFRadioGroup || field instanceof PDFCheckBox
    const hasExportValues = isButton && !!quiet(() => field.acroField.dict.lookup(PDFName.of('Opt')))
    // Descending, so export values (/Opt, aligned with widget order) stay aligned.
    for (let i = widgets.length - 1; i >= 0; i--) {
      if (!onRemoved[i]) continue
      kids.remove(i)
      if (hasExportValues) {
        quiet(() => (field.acroField as unknown as { removeExportValue(i: number): void }).removeExportValue(i))
      }
    }
  }
}
