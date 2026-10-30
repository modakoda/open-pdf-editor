// Checks that electron-builder produced what in-app updates need (run after packaging, in CI):
// the update metadata (latest*.yml) for this OS, the installers and blockmaps it points to, and
// resources/app-update.yml inside each unpacked app.
//   node scripts/check-update-metadata.mjs [release-dir]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const release = process.argv[2] ?? join(root, 'release')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const errors = []
const fail = (message) => errors.push(message)

/** Update metadata per OS: the latest*.yml files and the installers they must point to. */
const expected = {
  darwin: { metadata: ['latest-mac.yml'], installer: /\.zip$/, blockmap: true },
  win32: { metadata: ['latest.yml'], installer: /\.exe$/, blockmap: true },
  // AppImages carry their blockmap inside the file.
  linux: { metadata: ['latest-linux.yml', 'latest-linux-arm64.yml'], installer: /\.AppImage$/, blockmap: false }
}[process.platform]
if (!expected) throw new Error(`Unsupported platform ${process.platform}`)

for (const name of expected.metadata) {
  const file = join(release, name)
  if (!existsSync(file)) {
    fail(`${name} is missing`)
    continue
  }
  const info = yaml.load(readFileSync(file, 'utf8'))
  if (info?.version !== version) fail(`${name}: version ${info?.version} instead of ${version}`)
  const files = Array.isArray(info?.files) ? info.files : []
  if (files.length === 0) fail(`${name}: no files`)
  for (const f of files) {
    if (!expected.installer.test(f.url ?? '')) continue
    if (!f.sha512 || !(f.size > 0)) fail(`${name}: ${f.url} has no sha512/size`)
    if (!existsSync(join(release, f.url))) fail(`${name}: ${f.url} is not in ${release}`)
    if (expected.blockmap && !existsSync(join(release, `${f.url}.blockmap`))) fail(`${name}: ${f.url}.blockmap is missing`)
  }
  if (!files.some((f) => expected.installer.test(f.url ?? ''))) fail(`${name}: no ${expected.installer} installer listed`)
  console.log(`${name}: ${info?.version}, ${files.map((f) => f.url).join(', ')}`)
}

// resources/app-update.yml in every unpacked app (release/mac-arm64/*.app, win-unpacked, …).
const resourceDirs = []
for (const entry of readdirSync(release, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(release, entry.name)
  if (process.platform === 'darwin' && entry.name.startsWith('mac')) {
    for (const app of readdirSync(dir).filter((n) => n.endsWith('.app'))) resourceDirs.push(join(dir, app, 'Contents', 'Resources'))
  } else if (process.platform !== 'darwin' && entry.name.endsWith('-unpacked')) {
    resourceDirs.push(join(dir, 'resources'))
  }
}
if (resourceDirs.length === 0) fail(`no unpacked app in ${release}`)
for (const dir of resourceDirs) {
  const file = join(dir, 'app-update.yml')
  if (!existsSync(file)) {
    fail(`${file} is missing`)
    continue
  }
  const config = yaml.load(readFileSync(file, 'utf8'))
  if (!config?.provider) fail(`${file}: no provider`)
  console.log(`${file}: ${config?.provider} ${config?.owner ?? ''}/${config?.repo ?? config?.url ?? ''}`)
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`)
  process.exit(1)
}
console.log('Update metadata OK')
