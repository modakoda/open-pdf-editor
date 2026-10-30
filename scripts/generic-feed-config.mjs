// Writes a copy of electron-builder.yml whose apps read updates from a generic feed (any static
// HTTPS folder holding the release files) instead of GitHub Releases. Used by release.yml when
// the UPDATE_FEED_URL repository variable is set:
//   node scripts/generic-feed-config.mjs https://updates.example.com/open-pdf-editor/ electron-builder.feed.yml
//   npx electron-builder --config electron-builder.feed.yml
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [url, out = 'electron-builder.feed.yml'] = process.argv.slice(2)
if (!url || !/^https?:\/\/\S+$/.test(url)) {
  console.error('Usage: node scripts/generic-feed-config.mjs <http(s) feed URL> [output.yml]')
  process.exit(1)
}
const config = yaml.load(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))
config.publish = { provider: 'generic', url }
writeFileSync(resolve(root, out), yaml.dump(config, { lineWidth: -1 }))
console.log(`${out}: updates from ${url}`)
