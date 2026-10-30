/**
 * Whether this copy of the app can update itself:
 * - in-place: Windows NSIS installs, Linux AppImages and macOS apps signed with a real certificate
 *   (Squirrel.Mac refuses ad-hoc signed or unsigned apps);
 * - notify-only: other builds (ad-hoc signed / unsigned macOS app, app run from a disk image,
 *   Windows portable or unpacked, Linux deb / tar.gz) only link to the download page;
 * - disabled: development builds and e2e runs.
 * Pure apart from the injected file / codesign checks, so it is unit tested.
 */
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'

export type InstallMode =
  | { kind: 'in-place' }
  | { kind: 'notify-only'; reason: string }
  | { kind: 'disabled'; reason: string }

export type MacSignature = 'signed' | 'adhoc' | 'unsigned'

export interface InstallEnvironment {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** OPE_E2E=1: tests never talk to a real update server. */
  e2e: boolean
  env: Record<string, string | undefined>
  /** app.getPath('exe') */
  exePath: string
  productName: string
  fileExists(path: string): boolean
  /** macOS: how the app bundle is signed. */
  macSignature(bundlePath: string): Promise<MacSignature>
}

const IN_PLACE: InstallMode = { kind: 'in-place' }
const notifyOnly = (reason: string): InstallMode => ({ kind: 'notify-only', reason })

/** "/Applications/X.app" for "/Applications/X.app/Contents/MacOS/X", else null. */
export function macAppBundle(exePath: string): string | null {
  const macOS = dirname(exePath)
  const contents = dirname(macOS)
  const bundle = dirname(contents)
  return bundle.endsWith('.app') ? bundle : null
}

export async function detectInstallMode(e: InstallEnvironment): Promise<InstallMode> {
  if (!e.isPackaged) return { kind: 'disabled', reason: 'development build' }
  if (e.e2e) return { kind: 'disabled', reason: 'test run' }
  switch (e.platform) {
    case 'darwin': {
      const bundle = macAppBundle(e.exePath)
      if (!bundle) return notifyOnly('not running from an app bundle')
      // Squirrel.Mac cannot replace an app on a read-only disk image or a translocated copy.
      if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) {
        return notifyOnly('running from a disk image or a quarantined location')
      }
      const signature = await e.macSignature(bundle)
      if (signature === 'signed') return IN_PLACE
      return notifyOnly(signature === 'adhoc' ? 'ad-hoc signed build' : 'unsigned build')
    }
    case 'win32': {
      // Set by electron-builder's portable launcher.
      if (e.env.PORTABLE_EXECUTABLE_DIR || e.env.PORTABLE_EXECUTABLE_FILE) return notifyOnly('portable build')
      // The NSIS installer puts its uninstaller next to the executable.
      const uninstaller = join(dirname(e.exePath), `Uninstall ${e.productName}.exe`)
      return e.fileExists(uninstaller) ? IN_PLACE : notifyOnly('not installed with the installer')
    }
    case 'linux':
      // Set by the AppImage runtime.
      return e.env.APPIMAGE ? IN_PLACE : notifyOnly('deb or tar.gz build')
    default:
      return notifyOnly(`unsupported platform ${e.platform}`)
  }
}

/** Classifies `codesign --display --verbose=2` output (stdout + stderr). */
export function parseCodesignOutput(output: string): MacSignature {
  if (/not signed at all/i.test(output)) return 'unsigned'
  if (/^Signature=adhoc/m.test(output) || /^CodeDirectory .*flags=\S*\badhoc\b/m.test(output)) return 'adhoc'
  if (/^Authority=/m.test(output)) return 'signed'
  return 'unsigned'
}

export function readMacSignature(bundlePath: string): Promise<MacSignature> {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['--display', '--verbose=2', bundlePath], { timeout: 15_000 }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`
      // codesign exits with 1 for unsigned code; any other failure counts as unsigned too.
      resolve(err && !output.trim() ? 'unsigned' : parseCodesignOutput(output))
    })
  })
}
