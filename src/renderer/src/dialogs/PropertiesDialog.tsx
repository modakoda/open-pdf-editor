import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { STANDARD_INFO_KEYS, updateSettings, type DocumentMetadata } from '@core'
import { applyEdit } from '@renderer/actions/util'
import { effectiveMetadata } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

type TextKey = 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer'
const TEXT_FIELDS: { key: TextKey; label: string; placeholder?: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords', placeholder: 'Separate keywords with commas' },
  { key: 'creator', label: 'Creator', placeholder: 'Application the document was made with' },
  { key: 'producer', label: 'Producer', placeholder: 'Application that wrote the PDF' }
]

interface CustomRow {
  id: number
  name: string
  value: string
  /** Added with the button: focus its name. */
  added?: boolean
}

let nextRowId = 0
const newRow = (name = '', value = ''): CustomRow => ({ id: nextRowId++, name, value })

/** ISO date → value of a datetime-local input (local time, to the second). */
function toLocalInput(iso: string | undefined): string {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fromLocalInput(value: string): string {
  return value ? new Date(value).toISOString() : ''
}

/** Error for each row (by id): a value without a name, a standard or a repeated name. */
function rowErrors(rows: CustomRow[]): Map<number, string> {
  const errors = new Map<number, string>()
  const seen = new Set<string>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) {
      if (row.value.trim()) errors.set(row.id, 'Enter a name for this property.')
    } else if (STANDARD_INFO_KEYS.includes(name)) {
      errors.set(row.id, `“${name}” is a standard property name.`)
    } else if (seen.has(name)) {
      errors.set(row.id, `There is already a property named “${name}”.`)
    }
    seen.add(name)
  }
  return errors
}

function sameEntries(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] === a[k])
}

export function PropertiesDialog({ onClose }: { onClose: (saved: boolean | null) => void }) {
  const doc = useEditor((s) => s.doc)
  const fileName = useEditor((s) => s.fileName)
  const filePath = useEditor((s) => s.filePath)
  const initial = doc ? effectiveMetadata(doc) : {}
  const original = doc?.primarySourceId ? doc.sources[doc.primarySourceId]?.metadata : undefined
  // A new document gets the time of saving as its modification date unless one is set.
  const isNew = !original
  const [values, setValues] = useState<Record<TextKey, string>>(() => {
    const out = {} as Record<TextKey, string>
    for (const { key } of TEXT_FIELDS) out[key] = initial[key] ?? ''
    return out
  })
  const initialCreated = toLocalInput(initial.creationDate)
  const initialModified = toLocalInput(initial.modificationDate)
  const [created, setCreated] = useState(initialCreated)
  const [modified, setModified] = useState(initialModified)
  const [rows, setRows] = useState<CustomRow[]>(() => Object.entries(initial.custom ?? {}).map(([n, v]) => newRow(n, v)))
  const [flatten, setFlatten] = useState(!!doc?.settings.flattenForms)
  if (!doc) return null

  const errors = rowErrors(rows)
  const formFieldCount = Object.values(doc.sources).reduce((n, s) => n + s.formFields.length, 0)
  const sourceCount = Object.keys(doc.sources).length
  const originalProducer = original?.producer && original.producer !== values.producer ? original.producer : null

  const updateRow = (id: number, patch: Partial<CustomRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const confirm = () => {
    if (errors.size) return
    const metadata: DocumentMetadata = {}
    for (const { key } of TEXT_FIELDS) {
      const before = initial[key] ?? ''
      const value = values[key].trim()
      // Untouched values are kept as they are, even with surrounding spaces.
      if (values[key] !== before && value !== before) metadata[key] = value
    }
    if (created !== initialCreated) metadata.creationDate = fromLocalInput(created)
    if (modified !== initialModified) metadata.modificationDate = modified || !isNew ? fromLocalInput(modified) : undefined
    const custom: Record<string, string> = {}
    for (const row of rows) if (row.name.trim()) custom[row.name.trim()] = row.value.trim()
    if (!sameEntries(custom, initial.custom ?? {})) metadata.custom = custom

    const patch: Parameters<typeof updateSettings>[1] = {}
    if (Object.keys(metadata).length) patch.metadata = metadata
    if (flatten !== doc.settings.flattenForms) patch.flattenForms = flatten
    if (Object.keys(patch).length) {
      if (!applyEdit('Update properties', (d) => updateSettings(d, patch))) return
    }
    onClose(true)
  }

  return (
    <Dialog
      kind="properties"
      title="Document properties"
      onCancel={() => onClose(null)}
      onConfirm={confirm}
      confirmLabel="Save"
      confirmDisabled={errors.size > 0}
      width={520}
    >
      {TEXT_FIELDS.map(({ key, label, placeholder }) => (
        <Field
          key={key}
          label={label}
          htmlFor={`prop-${key}`}
          inline
          hint={key === 'producer' && originalProducer ? `Originally “${originalProducer}”` : undefined}
        >
          <input
            id={`prop-${key}`}
            className="input"
            data-testid={`prop-${key}`}
            value={values[key]}
            placeholder={placeholder}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          />
        </Field>
      ))}
      <Field label="Created" htmlFor="prop-created" inline>
        <input
          id="prop-created"
          type="datetime-local"
          step={1}
          className="input"
          data-testid="prop-created"
          value={created}
          onChange={(e) => setCreated(e.target.value)}
        />
      </Field>
      <Field label="Modified" htmlFor="prop-modified" inline hint={isNew ? 'Leave empty to use the time of saving.' : undefined}>
        <input
          id="prop-modified"
          type="datetime-local"
          step={1}
          className="input"
          data-testid="prop-modified"
          value={modified}
          onChange={(e) => setModified(e.target.value)}
        />
      </Field>

      <div className="dialog-section-title">Custom properties</div>
      {rows.map((row) => (
        <div key={row.id} className="custom-prop" data-testid="prop-custom-row">
          <div className="custom-prop-inputs">
            <input
              className="input custom-prop-name"
              aria-label="Property name"
              placeholder="Name"
              data-testid="prop-custom-name"
              autoFocus={row.added}
              value={row.name}
              onChange={(e) => updateRow(row.id, { name: e.target.value })}
            />
            <input
              className="input"
              aria-label={row.name.trim() ? `Value of ${row.name.trim()}` : 'Property value'}
              placeholder="Value"
              data-testid="prop-custom-value"
              value={row.value}
              onChange={(e) => updateRow(row.id, { value: e.target.value })}
            />
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Remove property"
              title="Remove property"
              data-testid="prop-custom-remove"
              onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {errors.get(row.id) && (
            <div className="field-error" role="alert" data-testid="field-error">
              {errors.get(row.id)}
            </div>
          )}
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-small" data-testid="prop-custom-add" onClick={() => setRows((rs) => [...rs, { ...newRow(), added: true }])}>
          <Plus size={14} aria-hidden="true" /> Add property
        </button>
      </div>

      <dl className="info-grid">
        <dt>File</dt>
        <dd title={filePath ?? undefined}>{filePath ?? fileName}</dd>
        <dt>Pages</dt>
        <dd>{doc.pages.length}</dd>
        {sourceCount > 1 && (
          <>
            <dt>Sources</dt>
            <dd>{sourceCount} files</dd>
          </>
        )}
        <dt>Security</dt>
        <dd>{doc.settings.encryption ? 'Password protected' : 'None'}</dd>
        {formFieldCount > 0 && (
          <>
            <dt>Form fields</dt>
            <dd>{formFieldCount}</dd>
          </>
        )}
      </dl>

      <label className="check">
        <input type="checkbox" data-testid="prop-flatten" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
        <span>
          Flatten form fields when saving
          <small>Filled-in values become part of the page and can no longer be edited.</small>
        </span>
      </label>
    </Dialog>
  )
}
