#!/usr/bin/env node
// Upload local video, audio and image files to CapCut.
//
// Two steps, driven by the capcut-upload skill:
//
//   1. node capcut-upload.mjs describe <file>...
//      Prints the exact `files` list to pass to the capcut_asset_upload_credential tool
//      (with version 2). The ticket only works for that exact list.
//
//   2. node capcut-upload.mjs upload <file>...      (upload ticket on stdin)
//      Exchanges the ticket for short-lived upload credentials, uploads each file and
//      prints JSON results: a `vid` for video and audio, a `uri` for images.
//
// Credentials stay in this process. They are never printed, logged or written to disk.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const CREDENTIAL_URL = 'https://www.capcut.com/api/external_mcp/upload/credential'
export const FINALIZE_URL = 'https://www.capcut.com/api/external_mcp/upload/finalize'
const VOD_API_VERSION = '2020-11-19'
const IMAGEX_API_VERSION = '2018-08-01'
const PART_SIZE = 8 * 1024 * 1024
const MAX_MEDIA_BYTES = 1024 ** 3
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const TRUSTED_CONTROL_HOSTS = /(^|\.)(tiktok\.com|tiktokw\.us|volcengineapi\.com)$/i
const FINALIZE_PATH = '/api/external_mcp/upload/finalize'

// The finalize step must go to CapCut itself: www.capcut.com (or another capcut.com host), or www.capcutw.us, which
// CapCut uses for US accounts. Returns the URL to post to, or null when the session's URL isn't one of these.
export function trustedFinalizeUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const trusted = host === 'capcut.com' || host.endsWith('.capcut.com') || host === 'www.capcutw.us'
    return url.protocol === 'https:' && trusted && url.pathname === FINALIZE_PATH && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

const VIDEO = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', '3gp', 'ts', 'mts', 'm2ts', 'flv']
const AUDIO = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif']
const IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif']

// ------------------------------------------------------------------ files

export function mediaKind(file) {
  const ext = path.extname(file).slice(1).toLowerCase()
  if (VIDEO.includes(ext)) return 'video'
  if (AUDIO.includes(ext)) return 'audio'
  if (IMAGE.includes(ext)) return 'image'
  throw new Error(`Unsupported file type: ${path.basename(file)}`)
}

export function describeFiles(files) {
  if (files.length === 0) throw new Error('Pass at least one file')
  const names = new Set()
  return files.map(file => {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) throw new Error(`Not a non-empty file: ${file}`)
    const kind = mediaKind(file)
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES
    if (stat.size > limit) throw new Error(`${path.basename(file)} is larger than CapCut allows for ${kind} (${limit} bytes)`)
    const fileName = path.basename(file)
    if (names.has(fileName)) throw new Error(`Two files are named ${fileName}. Rename one so each name is unique.`)
    names.add(fileName)
    return { file, kind, file_name: fileName, size_bytes: stat.size }
  })
}

// ------------------------------------------------------------------ checksums and signing

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32Hex(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

function amzDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function deriveSigningKey(secret, day, region, service) {
  let key = hmac(`AWS4${secret}`, day)
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part)
  return key
}

// AWS Signature Version 4 for a request to the root path, as used by CapCut's upload gateway.
// Signs x-amz-date, the session token and (when there is a body) the payload hash.
export function signRequest({ method, params, body = null, region, service, credentials, date = new Date() }) {
  const stamp = amzDate(date)
  const day = stamp.slice(0, 8)
  const payloadHash = sha256(body ?? '')
  const headers = { 'x-amz-date': stamp }
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
  if (body !== null) headers['x-amz-content-sha256'] = payloadHash
  const headerNames = Object.keys(headers).sort()
  const query = Object.keys(params).sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&')
  const canonicalRequest = [
    method,
    '/',
    query,
    headerNames.map(name => `${name}:${headers[name]}\n`).join(''),
    headerNames.join(';'),
    payloadHash,
  ].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n')
  const signature = crypto.createHmac('sha256', deriveSigningKey(credentials.secretAccessKey, day, region, service)).update(stringToSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${headerNames.join(';')}, Signature=${signature}`
  return { query, headers }
}

// ------------------------------------------------------------------ HTTP

async function request(fetchImpl, url, options, stage, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(url, options)
      if (response.status >= 500 && attempt < attempts) continue
      return response
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${stage}: network error (${error.cause?.code ?? error.message})`)
    }
  }
}

async function readJson(response, stage) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${stage}: HTTP ${response.status}, response is not JSON`)
  }
}

function apiResult(body, stage) {
  const error = body?.ResponseMetadata?.Error
  if (error) throw new Error(`${stage}: ${error.Code ?? 'error'} (request ${body.ResponseMetadata.RequestId ?? 'unknown'})`)
  if (!body?.Result) throw new Error(`${stage}: response has no Result`)
  return body.Result
}

function trustedControlHost(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !TRUSTED_CONTROL_HOSTS.test(url.hostname)) throw new Error(`Untrusted upload host: ${url.hostname}`)
  return url.origin
}

function encodePath(storeUri) {
  return storeUri.split('/').map(encodeURIComponent).join('/')
}

// ------------------------------------------------------------------ CapCut session

export async function exchangeTicket(ticket, described, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(ticket)) throw new Error('The upload ticket is missing or malformed. Pass it unchanged on stdin.')
  const body = JSON.stringify({ files: described.map(({ file_name, size_bytes }) => ({ file_name, size_bytes })) })
  const response = await request(fetchImpl, CREDENTIAL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json', accept: 'application/json' },
    body,
  }, 'credential exchange')
  if (response.status === 401) throw new Error('credential exchange: the upload ticket is invalid or expired. Request a new one.')
  if (response.status === 403) throw new Error('credential exchange: the files do not match the ticket. Request a new ticket with the output of "describe".')
  const session = await readJson(response, 'credential exchange')
  if (!response.ok || session.status !== 'success') throw new Error(`credential exchange: HTTP ${response.status} ${session.error ?? ''}`.trim())
  return session
}

function credentialsFrom(block) {
  return { accessKeyId: block.access_key_id, secretAccessKey: block.secret_access_key, sessionToken: block.session_token }
}

// ------------------------------------------------------------------ video and audio

async function uploadMedia(item, session, fetchImpl, log) {
  const cred = session.vod_credential
  if (!cred?.space_name) throw new Error('The upload session has no video credentials')
  const host = trustedControlHost(cred.upload_host)
  const credentials = credentialsFrom(cred)
  const region = cred.region

  const applyParams = { Action: 'ApplyUploadInner', Version: VOD_API_VERSION, SpaceName: cred.space_name, FileType: 'video', IsInner: '1', FileSize: String(item.size_bytes) }
  const applySigned = signRequest({ method: 'GET', params: applyParams, region, service: 'vod', credentials })
  const applied = apiResult(await readJson(await request(fetchImpl, `${host}/?${applySigned.query}`, { headers: applySigned.headers }, 'apply'), 'apply'), 'apply')
  const node = applied.InnerUploadAddress?.UploadNodes?.[0]
  const store = node?.StoreInfos?.[0]
  if (!node?.UploadHost || !store?.StoreUri || !store?.Auth || !node.SessionKey) throw new Error('apply: response has no upload address')

  const base = `https://${node.UploadHost}/upload/v1/${encodePath(store.StoreUri)}`
  const storageHeaders = { authorization: store.Auth, 'x-storage-u': crypto.randomUUID() }
  const tosCall = async (url, options, stage) => {
    const response = await request(fetchImpl, url, options, stage)
    const body = await readJson(response, stage)
    if (!response.ok || body.code !== 2000) throw new Error(`${stage}: HTTP ${response.status}, code ${body.code ?? 'unknown'}`)
    return body
  }

  const init = await tosCall(`${base}?uploadmode=part&phase=init`, { method: 'POST', headers: storageHeaders }, 'init')
  const uploadId = init.data?.uploadid
  if (!uploadId) throw new Error('init: response has no upload id')

  const checksums = []
  const fd = fs.openSync(item.file, 'r')
  try {
    for (let offset = 0, part = 1; offset < item.size_bytes; offset += PART_SIZE, part++) {
      const length = Math.min(PART_SIZE, item.size_bytes - offset)
      const chunk = Buffer.alloc(length)
      fs.readSync(fd, chunk, 0, length, offset)
      const crc = crc32Hex(chunk)
      await tosCall(`${base}?uploadid=${encodeURIComponent(uploadId)}&part_number=${part}&phase=transfer&part_offset=${offset}`, {
        method: 'POST',
        headers: { ...storageHeaders, 'content-crc32': crc, 'content-type': 'application/octet-stream' },
        body: chunk,
      }, `upload part ${part}`)
      checksums.push(`${part}:${crc}`)
      log(`${item.file_name}: ${Math.round(((offset + length) / item.size_bytes) * 100)}%`)
    }
  } finally {
    fs.closeSync(fd)
  }

  await tosCall(`${base}?uploadmode=part&phase=finish&uploadid=${encodeURIComponent(uploadId)}&size=${item.size_bytes}`, {
    method: 'POST', headers: storageHeaders, body: checksums.join(','),
  }, 'finish')

  const commitBody = JSON.stringify({ SessionKey: node.SessionKey })
  const commitSigned = signRequest({ method: 'POST', params: { Action: 'CommitUploadInner', Version: VOD_API_VERSION, SpaceName: cred.space_name }, body: commitBody, region, service: 'vod', credentials })
  const committed = apiResult(await readJson(await request(fetchImpl, `${host}/?${commitSigned.query}`, {
    method: 'POST', headers: { ...commitSigned.headers, 'content-type': 'application/json' }, body: commitBody,
  }, 'commit'), 'commit'), 'commit')
  const vid = committed.Results?.[0]?.Vid
  if (!vid) throw new Error('commit: response has no vid')

  const finalize = session.vod_finalize ?? session.video_finalize
  const finalizeUrl = trustedFinalizeUrl(finalize?.url)
  if (!finalizeUrl || !finalize.token) throw new Error('The upload session has no trusted finalize step')
  const finalized = await readJson(await request(fetchImpl, finalizeUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${finalize.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ vid }),
  }, 'finalize'), 'finalize')
  if (finalized.status !== 'success' || finalized.vid !== vid) {
    return { vid, public: false, error: `finalize: ${finalized.error ?? 'unexpected response'}. Keep this vid and retry later; do not upload the file again.` }
  }
  return { vid, public: true }
}

// ------------------------------------------------------------------ images

async function uploadImage(item, session, fetchImpl) {
  const cred = session.imagex_credential
  if (!cred?.image_service_id) throw new Error('The upload session has no image credentials')
  const host = trustedControlHost(cred.upload_host)
  const credentials = credentialsFrom(cred)
  const region = cred.region

  const applyParams = { Action: 'ApplyImageUpload', Version: IMAGEX_API_VERSION, ServiceId: cred.image_service_id, UploadNum: 1 }
  const applySigned = signRequest({ method: 'GET', params: applyParams, region, service: 'imagex', credentials })
  const applied = apiResult(await readJson(await request(fetchImpl, `${host}/?${applySigned.query}`, { headers: applySigned.headers }, 'apply'), 'apply'), 'apply')
  const address = applied.UploadAddress
  const store = address?.StoreInfos?.[0]
  const uploadHost = address?.UploadHosts?.[0]
  if (!store?.StoreUri || !store?.Auth || !uploadHost || !address.SessionKey) throw new Error('apply: response has no upload address')

  const data = fs.readFileSync(item.file)
  const extraHeaders = {}
  for (const entry of Array.isArray(address.UploadHeader) ? address.UploadHeader : []) {
    if (entry?.Key && entry?.Value) extraHeaders[String(entry.Key).toLowerCase()] = String(entry.Value)
  }
  const put = await request(fetchImpl, `https://${uploadHost}/${encodePath(store.StoreUri)}`, {
    method: 'POST',
    headers: { ...extraHeaders, authorization: store.Auth, 'content-crc32': crc32Hex(data), 'content-type': 'application/octet-stream' },
    body: data,
  }, 'upload')
  const putBody = await readJson(put, 'upload')
  if (!put.ok || (putBody.success !== undefined && putBody.success !== 0)) throw new Error(`upload: HTTP ${put.status}`)

  const commitBody = JSON.stringify({ SessionKey: address.SessionKey, SuccessOids: [store.StoreUri] })
  const commitSigned = signRequest({ method: 'POST', params: { Action: 'CommitImageUpload', Version: IMAGEX_API_VERSION, ServiceId: cred.image_service_id }, body: commitBody, region, service: 'imagex', credentials })
  const committed = apiResult(await readJson(await request(fetchImpl, `${host}/?${commitSigned.query}`, {
    method: 'POST', headers: { ...commitSigned.headers, 'content-type': 'application/json' }, body: commitBody,
  }, 'commit'), 'commit'), 'commit')
  const uri = committed.Results?.[0]?.Uri ?? committed.PluginResult?.[0]?.ImageUri ?? store.StoreUri
  return { uri }
}

// ------------------------------------------------------------------ batch

export async function uploadAll(ticket, files, { fetchImpl = fetch, log = () => {} } = {}) {
  const described = describeFiles(files)
  const session = await exchangeTicket(ticket, described, fetchImpl)
  const results = []
  for (const item of described) {
    try {
      const outcome = item.kind === 'image'
        ? await uploadImage(item, session, fetchImpl)
        : await uploadMedia(item, session, fetchImpl, log)
      results.push({ file: item.file, file_name: item.file_name, kind: item.kind, success: !outcome.error, ...outcome })
    } catch (error) {
      results.push({ file: item.file, file_name: item.file_name, kind: item.kind, success: false, error: error.message })
    }
  }
  return { success: results.every(r => r.success), results }
}

// Node's built-in fetch uses HTTPS_PROXY only when NODE_USE_ENV_PROXY=1 is set at startup (Node 22.21+ or 24.5+).
// With a proxy configured, run again with it set, so uploads work behind company or network proxies. Returns
// true when the child process handled the command.
export function proxySupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21)
}

function rerunWithProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  if (!proxy || process.env.NODE_USE_ENV_PROXY === '1') return false
  if (!proxySupported()) {
    // Older Node can't use the proxy; try a direct connection as before, and say why if it fails.
    console.error(`Note: an HTTPS proxy is set, but Node.js ${process.versions.node} can't use it for uploads (needs 22.21+ or 24.5+). Connecting directly.`)
    return false
  }
  const child = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
  return true
}

async function main() {
  const [command, ...files] = process.argv.slice(2)
  if (command === 'upload' && rerunWithProxy()) return
  if (command === 'describe') {
    console.log(JSON.stringify({ files: describeFiles(files).map(({ file_name, size_bytes }) => ({ file_name, size_bytes })) }))
    return
  }
  if (command === 'upload') {
    const ticket = fs.readFileSync(0, 'utf8').trim()
    const result = await uploadAll(ticket, files, { log: line => console.error(line) })
    console.log(JSON.stringify(result))
    if (!result.success) process.exitCode = 1
    return
  }
  console.log('Usage:\n  capcut-upload.mjs describe <file>...\n  capcut-upload.mjs upload <file>...   (upload ticket on stdin)')
  process.exitCode = command ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.log(JSON.stringify({ success: false, error: error.message }))
    process.exit(1)
  })
}
