/**
 * Where updates come from. electron-builder writes the `publish` configuration of
 * electron-builder.yml into resources/app-update.yml (GitHub Releases of modakoda/open-pdf-editor
 * by default, or a generic URL); electron-updater reads it. OPE_UPDATE_FEED_URL overrides it with
 * a generic feed at run time (e.g. to try a staging feed). The feed also gives the download page
 * linked from builds that cannot update themselves.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FeedConfig {
  provider: string
  owner?: string
  repo?: string
  host?: string
  url?: string
}

/** Reads the flat `key: value` YAML electron-builder writes as app-update.yml. */
export function parseAppUpdateYml(text: string): FeedConfig | null {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line)
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  if (!values.provider) return null
  return { provider: values.provider, owner: values.owner, repo: values.repo, host: values.host, url: values.url }
}

export function readFeedConfig(resourcesPath: string): FeedConfig | null {
  try {
    return parseAppUpdateYml(readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8'))
  } catch {
    return null
  }
}

/** A generic feed from OPE_UPDATE_FEED_URL (http/https only), or null. */
export function feedOverride(env: Record<string, string | undefined>): FeedConfig | null {
  const url = env.OPE_UPDATE_FEED_URL?.trim()
  if (!url || !isWebUrl(url)) return null
  return { provider: 'generic', url }
}

export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Page where users download `version` by hand. */
export function downloadPageUrl(feed: FeedConfig | null, version: string, fallback: string): string {
  if (feed?.provider === 'github' && feed.owner && feed.repo) {
    const host = feed.host && feed.host !== 'api.github.com' ? feed.host : 'github.com'
    return `https://${host}/${encodeURIComponent(feed.owner)}/${encodeURIComponent(feed.repo)}/releases/tag/v${encodeURIComponent(version)}`
  }
  if (feed?.url && isWebUrl(feed.url)) return feed.url
  return fallback
}
