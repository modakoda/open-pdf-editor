import { useState } from 'react'
import { updateSettings, type DocumentMetadata } from '@core'
import { applyEdit } from '@renderer/actions/util'
import { effectiveMetadata } from '@renderer/state/selectors'
import { useEditor } from '@renderer/state/store'
import { Dialog, Field } from './Dialog'

type EditableKey = 'title' | 'author' | 'subject' | 'keywords'
const FIELDS: { key: EditableKey; label: string; placeholder?: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords', placeholder: 'Separate keywords with commas' }
]

export function PropertiesDialog({ onClose }: { onClose: (saved: boolean | null) => void }) {
  const doc = useEditor((s) => s.doc)
  const fileName = useEditor((s) => s.fileName)
  const filePath = useEditor((s) => s.filePath)
  const initial = doc ? effectiveMetadata(doc) : {}
  const [values, setValues] = useState<Record<EditableKey, string>>({
    title: initial.title ?? '',
    author: initial.author ?? '',
    subject: initial.subject ?? '',
    keywords: initial.keywords ?? ''
  })
  const [flatten, setFlatten] = useState(!!doc?.settings.flattenForms)
  if (!doc) return null

  const formFieldCount = Object.values(doc.sources).reduce((n, s) => n + s.formFields.length, 0)
  const sourceCount = Object.keys(doc.sources).length

  const confirm = () => {
    const metadata: DocumentMetadata = {}
    let changed = false
    for (const { key } of FIELDS) {
      const value = values[key].trim()
      if (value !== (initial[key] ?? '')) {
        metadata[key] = value
        changed = true
      }
    }
    const patch: Parameters<typeof updateSettings>[1] = {}
    if (changed) patch.metadata = metadata
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
      width={480}
    >
      {FIELDS.map(({ key, label, placeholder }) => (
        <Field key={key} label={label} htmlFor={`prop-${key}`} inline>
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
        {initial.creator && (
          <>
            <dt>Creator</dt>
            <dd>{initial.creator}</dd>
          </>
        )}
        {initial.producer && (
          <>
            <dt>Producer</dt>
            <dd>{initial.producer}</dd>
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
