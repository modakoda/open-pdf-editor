/**
 * Low-level AcroForm helpers shared by load.ts and the exporter (internal). They work on
 * the raw field dictionaries where pdf-lib's field API is lossy (export values of choice
 * fields, checkbox groups with several on-states) or slow (getObjectRef per widget).
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  type PDFField,
  type PDFObject,
  type PDFWidgetAnnotation
} from '@cantoo/pdf-lib'

function quiet<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const decode = (o: PDFObject | undefined): string | undefined =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined

/** Refs of a field's widgets, aligned with `field.acroField.getWidgets()` (O(1) per widget). */
export function widgetRefs(field: PDFField): (PDFRef | undefined)[] {
  const kids = quiet(() => field.acroField.Kids())
  if (!kids) return [field.ref]
  const refs: (PDFRef | undefined)[] = []
  for (let i = 0; i < kids.size(); i++) {
    const k = kids.get(i)
    refs.push(k instanceof PDFRef ? k : undefined)
  }
  return refs
}

export interface ChoiceOption {
  /** Export value (what /V holds). */
  value: string
  /** Display text. */
  label: string
}

/** Options of a dropdown / option list from the raw /Opt (export value + display text). */
export function choiceOptions(field: PDFDropdown | PDFOptionList): ChoiceOption[] {
  const raw = quiet(() => field.acroField.getOptions()) ?? []
  return raw.map(({ value, display }) => {
    const v = quiet(() => value.decodeText()) ?? ''
    const d = display ? (quiet(() => display.decodeText()) ?? v) : v
    return { value: v, label: d }
  })
}

/** The field's current selection as export values (labels stored by sloppy writers are mapped). */
export function choiceSelection(field: PDFDropdown | PDFOptionList, options = choiceOptions(field)): string[] {
  const values = quiet(() => field.acroField.getValues()) ?? []
  return values
    .map((v) => quiet(() => v.decodeText()) ?? '')
    .map((v) => {
      if (options.some((o) => o.value === v)) return v
      return options.find((o) => o.label === v)?.value ?? v
    })
}

/** Map a value coming from the UI to an export value (accepts display labels as well). */
export function toExportValue(v: string, options: ChoiceOption[]): string {
  if (options.some((o) => o.value === v)) return v
  return options.find((o) => o.label === v)?.value ?? v
}

/** Write /V and /I of a choice field directly (pdf-lib's setValues compares against labels). */
export function writeChoiceValues(field: PDFDropdown | PDFOptionList, values: string[], options: ChoiceOption[]): void {
  const dict = field.acroField.dict
  const ctx = dict.context
  const strings = values.map((v) => PDFHexString.fromText(v))
  if (!strings.length) dict.delete(PDFName.of('V'))
  else if (strings.length === 1) dict.set(PDFName.of('V'), strings[0])
  else dict.set(PDFName.of('V'), ctx.obj(strings))
  const indices = values
    .map((v) => options.findIndex((o) => o.value === v))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  if (indices.length) dict.set(PDFName.of('I'), ctx.obj(indices))
  else dict.delete(PDFName.of('I'))
}

/** Temporarily replace /V by display labels (pdf-lib draws /V verbatim), run `fn`, restore. */
export function withLabelsAsValue<T>(field: PDFDropdown | PDFOptionList, options: ChoiceOption[], fn: () => T): T {
  const dict = field.acroField.dict
  const original = dict.get(PDFName.of('V'))
  const originalI = dict.get(PDFName.of('I'))
  const selection = choiceSelection(field, options)
  const labels = selection.map((v) => options.find((o) => o.value === v)?.label ?? v)
  const differs = labels.some((l, i) => l !== selection[i])
  if (differs) {
    const strings = labels.map((l) => PDFHexString.fromText(l))
    dict.set(PDFName.of('V'), strings.length === 1 ? strings[0] : dict.context.obj(strings))
  }
  try {
    return fn()
  } finally {
    if (differs) {
      if (original) dict.set(PDFName.of('V'), original)
      else dict.delete(PDFName.of('V'))
    }
    if (originalI) dict.set(PDFName.of('I'), originalI)
  }
}

export interface ButtonWidgetState {
  /** Name of the widget's "on" appearance state (e.g. "Yes", "0"). */
  onState?: string
  /** Value this widget stands for (from /Opt if present, else the on-state name). */
  exportValue?: string
}

/** On-state and export value of every widget of a checkbox / radio field. */
export function buttonStates(field: PDFCheckBox | PDFRadioGroup): ButtonWidgetState[] {
  const widgets = quiet(() => field.acroField.getWidgets()) ?? []
  const opt = quiet(() => field.acroField.dict.lookup(PDFName.of('Opt')))
  return widgets.map((w, i) => {
    const onState = quiet(() => w.getOnValue()?.decodeText())
    const exported = opt instanceof PDFArray && i < opt.size() ? decode(quiet(() => opt.lookup(i))) : undefined
    return { onState, exportValue: exported ?? onState }
  })
}

/** Distinct export values in widget order. */
export function buttonOptions(states: ButtonWidgetState[]): string[] {
  const out: string[] = []
  for (const s of states) if (s.exportValue !== undefined && !out.includes(s.exportValue)) out.push(s.exportValue)
  return out
}

/** A checkbox whose widgets have different on-values behaves like a radio group. */
export function isMultiStateCheckBox(field: PDFField): field is PDFCheckBox {
  return field instanceof PDFCheckBox && buttonOptions(buttonStates(field)).length > 1
}

function currentState(field: PDFCheckBox | PDFRadioGroup): string | undefined {
  const v = quiet(() => field.acroField.dict.lookup(PDFName.of('V')))
  const name = v instanceof PDFName ? v.decodeText() : decode(v)
  return name && name !== 'Off' ? name : undefined
}

/** Export value of the selected widget ('' when nothing is on). */
export function selectedButtonValue(field: PDFCheckBox | PDFRadioGroup, states = buttonStates(field)): string {
  const state = currentState(field)
  if (!state) return ''
  return states.find((s) => s.onState === state)?.exportValue ?? states.find((s) => s.exportValue === state)?.exportValue ?? ''
}

/**
 * Select the widget(s) standing for `value` (export value, or on-state name); '' clears.
 * Writes /V on the field and /AS on every widget without regenerating appearances.
 */
export function writeButtonValue(field: PDFCheckBox | PDFRadioGroup, value: string, states = buttonStates(field)): boolean {
  const widgets = quiet(() => field.acroField.getWidgets()) ?? []
  let onState: string | undefined
  if (value) {
    onState = states.find((s) => s.exportValue === value)?.onState ?? states.find((s) => s.onState === value)?.onState
    if (!onState) return false
  }
  const off = PDFName.of('Off')
  field.acroField.dict.set(PDFName.of('V'), onState ? PDFName.of(onState) : off)
  widgets.forEach((w, i) => {
    const on = onState && states[i]?.onState === onState
    w.dict.set(PDFName.of('AS'), on ? PDFName.of(onState!) : off)
  })
  return true
}

/** Make every widget's /AS agree with the field's /V (what NeedAppearances viewers do). */
export function syncButtonAppearanceStates(field: PDFCheckBox | PDFRadioGroup): void {
  const states = buttonStates(field)
  const state = currentState(field)
  const widgets = quiet(() => field.acroField.getWidgets()) ?? []
  widgets.forEach((w, i) => {
    const on = state && states[i]?.onState === state
    w.dict.set(PDFName.of('AS'), on ? PDFName.of(state!) : PDFName.of('Off'))
  })
}

/** True when every widget has a normal appearance (stream, or state dict). */
export function hasAppearances(field: PDFField): boolean {
  const widgets = quiet(() => field.acroField.getWidgets()) ?? []
  return widgets.every((w) => {
    const ap = quiet(() => w.dict.lookup(PDFName.of('AP')))
    return ap instanceof PDFDict && !!ap.get(PDFName.of('N'))
  })
}

export function needAppearancesFlag(acroForm: PDFDict | undefined): boolean {
  const v = acroForm?.lookup(PDFName.of('NeedAppearances'))
  return !!v && v.toString() === 'true'
}

export function isHiddenWidget(widget: PDFDict | PDFWidgetAnnotation): boolean {
  const dict = widget instanceof PDFDict ? widget : widget.dict
  const f = dict.lookup(PDFName.of('F'))
  const flags = f instanceof PDFNumber ? f.asNumber() : 0
  // Hidden (bit 2) or NoView (bit 6)
  return (flags & 2) !== 0 || (flags & 32) !== 0
}
