/**
 * Every text of a document that the exporter draws with a font, with the style it is drawn
 * in: text objects, form values and options, retyped existing text, edited free-text
 * annotations, watermark and page numbers.
 */
import type { EditorDocument, FontFamily, FormValue } from '@core'
import { getLoadedContentItems } from '@renderer/editing/contentItems'

export interface StyledText {
  text: string
  style: { font: FontFamily; bold: boolean; italic: boolean }
}

const SANS = { font: 'sans', bold: false, italic: false } as const

function valueTexts(value: FormValue | undefined): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

export function documentTexts(doc: EditorDocument): StyledText[] {
  const out: StyledText[] = []
  const add = (text: string | undefined | null, style: StyledText['style'] = SANS) => {
    if (text && text.trim()) out.push({ text, style })
  }
  for (const obj of doc.objects) {
    if (obj.type === 'text') add(obj.text, { font: obj.font, bold: obj.bold, italic: obj.italic })
    else if (obj.type === 'field') {
      valueTexts(obj.value).forEach((t) => add(t))
      obj.options?.forEach((t) => add(t))
    }
  }
  for (const values of Object.values(doc.formValues ?? {})) {
    for (const value of Object.values(values)) valueTexts(value).forEach((t) => add(t))
  }
  for (const edits of Object.values(doc.fieldEdits ?? {})) {
    for (const edit of Object.values(edits)) {
      edit.options?.forEach((t) => add(t))
      edit.optionLabels?.forEach((t) => add(t))
    }
  }
  for (const [pageId, edits] of Object.entries(doc.contentEdits ?? {})) {
    const page = doc.pages.find((p) => p.id === pageId)
    const items = page ? getLoadedContentItems(doc, page) : undefined
    for (const edit of edits) {
      if (edit.text === undefined) continue
      const item = items?.find((i) => i.id === edit.itemId)
      add(edit.text, { font: item?.fontFamily ?? 'sans', bold: !!item?.bold, italic: !!item?.italic })
    }
  }
  for (const edits of Object.values(doc.annotationEdits ?? {})) {
    for (const edit of edits) add(edit.contents)
  }
  const { watermark, pageNumbers } = doc.settings
  if (watermark) add(watermark.text, { font: 'sans', bold: true, italic: false })
  if (pageNumbers) add(pageNumbers.format)
  return out
}
