/** Renders the dialog requested through state/dialogs (openDialog). */
import { useDialogs } from '@renderer/state/dialogs'
import { AboutDialog, ConfirmDialog } from './ConfirmDialog'
import { ExtractDialog } from './ExtractDialog'
import { InsertPagesDialog } from './InsertPagesDialog'
import { OcrDialog } from './OcrDialog'
import { PageNumbersDialog } from './PageNumbersDialog'
import { PasswordDialog } from './PasswordDialog'
import { PropertiesDialog } from './PropertiesDialog'
import { RedactDialog } from './RedactDialog'
import { SecurityDialog } from './SecurityDialog'
import { SignDialog } from './SignDialog'
import { SplitDialog } from './SplitDialog'
import { WatermarkDialog } from './WatermarkDialog'

export function DialogHost() {
  const current = useDialogs((s) => s.current)
  if (!current) return null
  const { request, resolve, id } = current
  const close = (result: unknown) => resolve(result)
  switch (request.kind) {
    case 'password':
      return <PasswordDialog key={id} fileName={request.fileName} submit={request.submit} onClose={close} />
    case 'confirm':
      return <ConfirmDialog key={id} {...request} onClose={close} />
    case 'properties':
      return <PropertiesDialog key={id} onClose={close} />
    case 'watermark':
      return <WatermarkDialog key={id} onClose={close} />
    case 'page-numbers':
      return <PageNumbersDialog key={id} onClose={close} />
    case 'security':
      return <SecurityDialog key={id} onClose={close} />
    case 'extract':
      return <ExtractDialog key={id} initialRange={request.initialRange} onClose={close} />
    case 'split':
      return <SplitDialog key={id} onClose={close} />
    case 'insert':
      return <InsertPagesDialog key={id} source={request.source} onClose={close} />
    case 'ocr':
      return <OcrDialog key={id} scope={request.scope} skipPagesWithText={request.skipPagesWithText} onClose={close} />
    case 'about':
      return <AboutDialog key={id} onClose={() => close(null)} />
    case 'redact':
      return <RedactDialog key={id} areas={request.areas} pages={request.pages} onClose={close} />
    case 'sign':
      return <SignDialog key={id} onClose={close} />
  }
}
