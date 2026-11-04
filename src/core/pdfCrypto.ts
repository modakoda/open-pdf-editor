/**
 * Standard security handler algorithms needed by the engine itself (internal).
 * pdf-lib decrypts/encrypts documents, but it does not tell which password matched and
 * cannot recover the user password from the owner password, which we need so a re-saved
 * file keeps opening with its original passwords.
 *
 * MD5 / RC4 are implemented here (not in WebCrypto); SHA-2 and AES use WebCrypto
 * (`globalThis.crypto.subtle`, available in Node and in Electron/browser secure contexts).
 */

/** Padding string of the standard security handler (ISO 32000-1, 7.6.3.3). */
const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a
])

// ---------------------------------------------------------------------------------------
// MD5 (RFC 1321)
// ---------------------------------------------------------------------------------------

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

export function md5(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8
  const padded = new Uint8Array(((data.length + 8) >> 6) * 64 + 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const m = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const tmp = d
      d = c
      c = b
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0
      const s = MD5_S[(i >> 4) * 4 + (i % 4)]
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const out = new Uint8Array(16)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, a0, true)
  ov.setUint32(4, b0, true)
  ov.setUint32(8, c0, true)
  ov.setUint32(12, d0, true)
  return out
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    const t = s[i]
    s[i] = s[j]
    s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}

const equalBytes = (a: Uint8Array, b: Uint8Array, n = Math.max(a.length, b.length)) => {
  if (a.length < n || b.length < n) return false
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------------------
// WebCrypto helpers (SHA-2, AES-128-CBC without padding)
// ---------------------------------------------------------------------------------------

function subtle(): SubtleCrypto | undefined {
  return globalThis.crypto?.subtle
}

async function sha(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle()!.digest(alg, data as BufferSource))
}

async function aesCbcDecryptNoPadding(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle()!.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
  // WebCrypto insists on PKCS#7 padding: append a block that decrypts to a full padding block.
  const last = data.subarray(data.length - 16)
  const padBlock = new Uint8Array(16).fill(16)
  const extra = new Uint8Array(
    await subtle()!.encrypt({ name: 'AES-CBC', iv: last as BufferSource }, k, padBlock as BufferSource)
  ).subarray(0, 16)
  const plain = await subtle()!.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, concat(data, extra) as BufferSource)
  return new Uint8Array(plain)
}

async function aes128CbcNoPadding(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle()!.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, ['encrypt'])
  // WebCrypto always appends a PKCS#7 block; the leading blocks equal unpadded CBC output.
  const out = new Uint8Array(await subtle()!.encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource))
  return out.subarray(0, data.length)
}

/** ISO 32000-2 Algorithm 2.B (revision 6 password hash). */
async function hashR6(password: Uint8Array, input: Uint8Array, userBytes: Uint8Array): Promise<Uint8Array> {
  let k = (await sha('SHA-256', input)).subarray(0, 32)
  let e: Uint8Array = new Uint8Array([0])
  let i = 0
  while (i < 64 || e[e.length - 1] > i - 32) {
    const combined = concat(password, k, userBytes)
    const k1 = new Uint8Array(combined.length * 64)
    for (let j = 0; j < 64; j++) k1.set(combined, j * combined.length)
    e = await aes128CbcNoPadding(k.subarray(0, 16), k.subarray(16, 32), k1)
    const remainder = e.subarray(0, 16).reduce((a, b) => a + b, 0) % 3
    k = await sha(remainder === 0 ? 'SHA-256' : remainder === 1 ? 'SHA-384' : 'SHA-512', e)
    i++
  }
  return k.subarray(0, 32)
}

// ---------------------------------------------------------------------------------------
// Password identification
// ---------------------------------------------------------------------------------------

export interface StandardSecurityInfo {
  /** /R */
  revision: number
  /** /Length in bits (40 when absent). */
  keyLength: number
  /** /O and /U strings. */
  owner: Uint8Array
  user: Uint8Array
  /** /P */
  permissions: number
  encryptMetadata: boolean
  /** First element of the trailer /ID. */
  fileId: Uint8Array
  /** /V */
  version: number
  /** /OE, /UE, /Perms (revisions 5 and 6). */
  ownerEncryption?: Uint8Array
  userEncryption?: Uint8Array
  perms?: Uint8Array
  /** Crypt filter method of the standard filter (V4/V5): 'V2' | 'AESV2' | 'AESV3' | 'None'. */
  cryptFilterMethod?: string
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s).subarray(0, 127)
}

function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  const n = Math.min(32, pw.length)
  out.set(pw.subarray(0, n))
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n)
  return out
}

/** Algorithm 2: file key from a (user) password, revisions 2-4. */
function fileKeyR234(info: StandardSecurityInfo, password: Uint8Array): Uint8Array {
  const p = info.permissions
  const parts = [
    padPassword(password),
    info.owner.subarray(0, 32),
    new Uint8Array([p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff]),
    info.fileId
  ]
  if (info.revision >= 4 && !info.encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))
  const n = info.revision === 2 ? 5 : info.keyLength >> 3
  let hash = md5(concat(...parts))
  if (info.revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, n))
  return hash.subarray(0, n)
}

const xorKey = (key: Uint8Array, v: number) => key.map((b) => b ^ v)

/** Algorithm 6: is `password` the user password (revisions 2-4)? */
function isUserPasswordR234(info: StandardSecurityInfo, password: Uint8Array): boolean {
  return keyMatchesUserEntryR234(info, fileKeyR234(info, password))
}

function keyMatchesUserEntryR234(info: StandardSecurityInfo, key: Uint8Array): boolean {
  if (info.revision === 2) return equalBytes(rc4(key, PASSWORD_PADDING), info.user, 32)
  let x = rc4(key, md5(concat(PASSWORD_PADDING, info.fileId)))
  for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x)
  return equalBytes(x, info.user, 16)
}

/** Algorithm 7: user password from the owner password (revisions 2-4). */
function userPasswordFromOwnerR234(info: StandardSecurityInfo, ownerPassword: Uint8Array): Uint8Array {
  const n = info.revision === 2 ? 5 : info.keyLength >> 3
  let hash = md5(padPassword(ownerPassword))
  if (info.revision >= 3) for (let i = 0; i < 50; i++) hash = md5(hash)
  const key = hash.subarray(0, n)
  let x = info.owner.subarray(0, 32)
  if (info.revision === 2) x = rc4(key, x)
  else for (let i = 19; i >= 0; i--) x = rc4(xorKey(key, i), x)
  // x = user password followed by the start of the padding string.
  for (let len = 0; len <= 32; len++) {
    if (equalBytes(x.subarray(len), PASSWORD_PADDING.subarray(0, 32 - len), 32 - len)) return x.subarray(0, len)
  }
  return x
}

export interface PasswordIdentity {
  kind: 'user' | 'owner'
  /** The user (open) password, when known. */
  userPassword?: string
}

/**
 * Which of the file's passwords `password` is. Only call it with a password that pdf-lib
 * accepted. Returns undefined when this cannot be determined (no WebCrypto, odd handler).
 */
export async function identifyPassword(info: StandardSecurityInfo, password: string): Promise<PasswordIdentity | undefined> {
  try {
    if (info.revision >= 2 && info.revision <= 4) {
      const pw = latin1Bytes(password)
      if (isUserPasswordR234(info, pw)) return { kind: 'user', userPassword: password }
      const user = userPasswordFromOwnerR234(info, pw)
      if (!isUserPasswordR234(info, user)) return { kind: 'owner' }
      return { kind: 'owner', userPassword: String.fromCharCode(...user) }
    }
    if ((info.revision === 5 || info.revision === 6) && subtle()) {
      const pw = info.revision === 6 ? utf8Bytes(password) : latin1Bytes(password).subarray(0, 127)
      const salt = info.user.subarray(32, 40)
      const input = concat(pw, salt)
      const hash = info.revision === 6 ? await hashR6(pw, input, new Uint8Array()) : await sha('SHA-256', input)
      if (equalBytes(hash, info.user, 32)) return { kind: 'user', userPassword: password }
      // The user password of an AES-256 file cannot be derived from the owner password.
      return { kind: 'owner' }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The file encryption key, from a password whose kind is known. For revisions 2-4 the user
 * password is required (pass `userPassword` when `password` is the owner password).
 */
export async function fileEncryptionKey(
  info: StandardSecurityInfo,
  password: string,
  kind: 'user' | 'owner',
  userPassword?: string
): Promise<Uint8Array | undefined> {
  try {
    if (info.revision >= 2 && info.revision <= 4) {
      const user = kind === 'user' ? password : userPassword
      if (user === undefined) return undefined
      const key = fileKeyR234(info, latin1Bytes(user))
      return keyMatchesUserEntryR234(info, key) ? key : undefined
    }
    if ((info.revision === 5 || info.revision === 6) && subtle()) {
      const pw = info.revision === 6 ? utf8Bytes(password) : latin1Bytes(password).subarray(0, 127)
      const zero = new Uint8Array(16)
      let key: Uint8Array
      if (kind === 'user') {
        if (!info.userEncryption) return undefined
        const input = concat(pw, info.user.subarray(40, 48))
        const k = info.revision === 6 ? await hashR6(pw, input, new Uint8Array()) : await sha('SHA-256', input)
        key = await aesCbcDecryptNoPadding(k, zero, info.userEncryption.subarray(0, 32))
      } else {
        if (!info.ownerEncryption) return undefined
        const u48 = info.user.subarray(0, 48)
        const input = concat(pw, info.owner.subarray(40, 48), u48)
        const k = info.revision === 6 ? await hashR6(pw, input, u48) : await sha('SHA-256', input)
        key = await aesCbcDecryptNoPadding(k, zero, info.ownerEncryption.subarray(0, 32))
      }
      // Algorithm 13: /Perms decrypted with the file key ends in "adb" at bytes 9-11.
      if (!info.perms || info.perms.length < 16) return undefined
      const perms = await aesCbcDecryptNoPadding(key, zero, info.perms.subarray(0, 16))
      return perms[9] === 0x61 && perms[10] === 0x64 && perms[11] === 0x62 ? key : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}
