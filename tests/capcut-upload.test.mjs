import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CREDENTIAL_URL, FINALIZE_URL, crc32Hex, proxySupported, trustedFinalizeUrl, deriveSigningKey, describeFiles, exchangeTicket, mediaKind, signRequest, uploadAll,
} from '../scripts/capcut-upload.mjs'

const TICKET = 'AbCdEfGhIjKlMnOpQrStUw'

function tempFiles(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-upload-'))
  return Object.entries(entries).map(([name, content]) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    return file
  })
}

function fakeSession(overrides = {}) {
  return {
    status: 'success',
    vod_credential: {
      access_key_id: 'AKTEST', secret_access_key: 'secret', session_token: 'token', region: 'sg',
      space_name: 'space', upload_host: 'https://vod-upload.example.tiktok.com',
    },
    imagex_credential: {
      access_key_id: 'AKTEST', secret_access_key: 'secret', session_token: 'token', region: 'sg',
      image_service_id: 'svc', upload_host: 'https://imagex-upload.example.tiktok.com',
    },
    vod_finalize: { url: FINALIZE_URL, token: 'finalize-token', expires_at: 0 },
    ...overrides,
  }
}

function fakeCapCut(session = fakeSession()) {
  const calls = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url)
    const action = u.searchParams.get('Action') ?? u.searchParams.get('phase') ?? u.pathname
    calls.push({ host: u.host, action, headers: options.headers ?? {}, body: options.body })
    if (url === CREDENTIAL_URL) return json(session)
    if (url === FINALIZE_URL) return json({ status: 'success', vid: 'v-123' })
    switch (action) {
      case 'ApplyUploadInner':
        return json({ Result: { InnerUploadAddress: { UploadNodes: [{ UploadHost: 'tos.example.com', SessionKey: 'sk', StoreInfos: [{ StoreUri: 'bucket/a b', Auth: 'store-auth' }] }] } } })
      case 'init': return json({ code: 2000, data: { uploadid: 'up-1' } })
      case 'transfer': return json({ code: 2000, data: {} })
      case 'finish': return json({ code: 2000, data: {} })
      case 'CommitUploadInner': return json({ Result: { Results: [{ Vid: 'v-123' }] } })
      case 'ApplyImageUpload':
        return json({ Result: { UploadAddress: { UploadHosts: ['img.example.com'], SessionKey: 'isk', StoreInfos: [{ StoreUri: 'bucket/img', Auth: 'img-auth' }] } } })
      case 'CommitImageUpload': return json({ Result: { Results: [{ Uri: 'bucket/img' }] } })
      default:
        if (u.host === 'img.example.com') return json({ success: 0 })
        return json({ error: 'unexpected' }, 404)
    }
  }
  return { calls, fetchImpl }
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32Hex(Buffer.from('123456789')), 'cbf43926')
  assert.equal(crc32Hex(Buffer.alloc(0)), '00000000')
})

test('signing key matches the AWS documentation example', () => {
  const key = deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam')
  assert.equal(key.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d')
})

test('signRequest builds a verifiable SigV4 authorization', () => {
  const credentials = { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'TOKEN' }
  const date = new Date('2026-10-26T12:00:00Z')
  const { query, headers } = signRequest({ method: 'POST', params: { b: '2', a: 'x y' }, body: '{}', region: 'sg', service: 'vod', credentials, date })
  assert.equal(query, 'a=x%20y&b=2')
  assert.equal(headers['x-amz-date'], '20261026T120000Z')
  assert.equal(headers['x-amz-security-token'], 'TOKEN')
  const sha = s => crypto.createHash('sha256').update(s).digest('hex')
  const canonical = ['POST', '/', query,
    `x-amz-content-sha256:${sha('{}')}\nx-amz-date:20261026T120000Z\nx-amz-security-token:TOKEN\n`,
    'x-amz-content-sha256;x-amz-date;x-amz-security-token', sha('{}')].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', '20261026T120000Z', '20261026/sg/vod/aws4_request', sha(canonical)].join('\n')
  const expected = crypto.createHmac('sha256', deriveSigningKey('SK', '20261026', 'sg', 'vod')).update(toSign).digest('hex')
  assert.equal(headers.authorization,
    `AWS4-HMAC-SHA256 Credential=AK/20261026/sg/vod/aws4_request, SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${expected}`)
})

test('classifies media and validates files', () => {
  assert.equal(mediaKind('a/B.MP4'), 'video')
  assert.equal(mediaKind('song.mp3'), 'audio')
  assert.equal(mediaKind('cover.webp'), 'image')
  assert.throws(() => mediaKind('notes.txt'), /Unsupported/)
  const [a, b] = tempFiles({ 'clip.mp4': 'x'.repeat(10), 'cover.png': 'y' })
  assert.deepEqual(describeFiles([a, b]).map(({ file_name, size_bytes, kind }) => ({ file_name, size_bytes, kind })), [
    { file_name: 'clip.mp4', size_bytes: 10, kind: 'video' },
    { file_name: 'cover.png', size_bytes: 1, kind: 'image' },
  ])
  const [empty] = tempFiles({ 'empty.png': '' })
  assert.throws(() => describeFiles([empty]), /non-empty/)
})

test('ticket exchange sends the ticket only as a bearer header and maps errors', async () => {
  const [file] = tempFiles({ 'clip.mp4': 'abc' })
  const described = describeFiles([file])
  let seen
  const ok = await exchangeTicket(TICKET, described, async (url, options) => {
    seen = { url, options }
    return new Response(JSON.stringify(fakeSession()), { status: 200 })
  })
  assert.equal(ok.status, 'success')
  assert.equal(seen.url, CREDENTIAL_URL)
  assert.equal(seen.options.headers.authorization, `Bearer ${TICKET}`)
  assert.deepEqual(JSON.parse(seen.options.body), { files: [{ file_name: 'clip.mp4', size_bytes: 3 }] })
  await assert.rejects(exchangeTicket(TICKET, described, async () => new Response('{}', { status: 401 })), /invalid or expired/)
  await assert.rejects(exchangeTicket(TICKET, described, async () => new Response('{}', { status: 403 })), /do not match/)
  await assert.rejects(exchangeTicket('bad ticket!', described, async () => assert.fail('must not call')), /malformed/)
})

test('uploads a video and an image end to end', async () => {
  const [video, image] = tempFiles({ 'clip.mp4': Buffer.alloc(9 * 1024 * 1024, 1), 'cover.png': 'png' })
  const { calls, fetchImpl } = fakeCapCut()
  const result = await uploadAll(TICKET, [video, image], { fetchImpl })
  assert.equal(result.success, true)
  assert.deepEqual(result.results.map(r => [r.file_name, r.vid ?? r.uri, r.public]), [
    ['clip.mp4', 'v-123', true],
    ['cover.png', 'bucket/img', undefined],
  ])
  assert.deepEqual(calls.map(c => c.action), [
    '/api/external_mcp/upload/credential', 'ApplyUploadInner', 'init', 'transfer', 'transfer', 'finish', 'CommitUploadInner',
    '/api/external_mcp/upload/finalize', 'ApplyImageUpload', '/bucket/img', 'CommitImageUpload',
  ])
  const transfers = calls.filter(c => c.action === 'transfer')
  assert.equal(transfers[0].body.length, 8 * 1024 * 1024)
  assert.equal(transfers[1].body.length, 1024 * 1024)
  assert.equal(calls.find(c => c.action === 'finish').body, `1:${crc32Hex(transfers[0].body)},2:${crc32Hex(transfers[1].body)}`)
  for (const call of calls.filter(c => c.host !== 'www.capcut.com')) {
    assert.ok(!JSON.stringify(call.headers).includes(TICKET), 'ticket must only go to CapCut')
    assert.ok(!JSON.stringify(call.headers).includes('finalize-token'), 'finalize token must only go to CapCut')
  }
})

test('refuses untrusted control hosts and finalize urls', async () => {
  const [video] = tempFiles({ 'clip.mp4': 'abc' })
  const untrusted = fakeCapCut(fakeSession({ vod_credential: { ...fakeSession().vod_credential, upload_host: 'https://evil.example.com' } }))
  const r1 = await uploadAll(TICKET, [video], { fetchImpl: untrusted.fetchImpl })
  assert.match(r1.results[0].error, /Untrusted upload host/)
  assert.equal(untrusted.calls.length, 1)

  const badFinalize = fakeCapCut(fakeSession({ vod_finalize: { url: 'https://evil.example.com/finalize', token: 't' } }))
  const r2 = await uploadAll(TICKET, [video], { fetchImpl: badFinalize.fetchImpl })
  assert.match(r2.results[0].error, /trusted finalize/)
  assert.ok(badFinalize.calls.every(c => !c.host.includes('evil')))
})

test('finalize goes only to CapCut, including its US address', () => {
  assert.equal(trustedFinalizeUrl(FINALIZE_URL), FINALIZE_URL)
  assert.equal(trustedFinalizeUrl('https://www.capcutw.us/api/external_mcp/upload/finalize'), 'https://www.capcutw.us/api/external_mcp/upload/finalize')
  assert.equal(trustedFinalizeUrl('https://capcut.com.evil.example/api/external_mcp/upload/finalize'), null)
  assert.equal(trustedFinalizeUrl('http://www.capcut.com/api/external_mcp/upload/finalize'), null)
  assert.equal(trustedFinalizeUrl('https://www.capcutw.us/other'), null)
  assert.equal(trustedFinalizeUrl('https://user:pw@www.capcut.com/api/external_mcp/upload/finalize'), null)
  assert.equal(trustedFinalizeUrl(undefined), null)
})

test('a video whose session finalizes on the US address is finalized there', async () => {
  const us = 'https://www.capcutw.us/api/external_mcp/upload/finalize'
  const { fetchImpl, calls } = fakeCapCut(fakeSession({ vod_finalize: { url: us, token: 'finalize-token', expires_at: 0 } }))
  const wrapped = async (url, options) => (url === us ? new Response(JSON.stringify({ status: 'success', vid: 'v-123' }), { status: 200 }) : fetchImpl(url, options))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'))
  const file = path.join(dir, 'clip.mp4')
  fs.writeFileSync(file, Buffer.alloc(10))
  const result = await uploadAll('mcp_ut_useast5_abcdefghijklmnopqrstuA', [file], { fetchImpl: wrapped })
  assert.equal(result.success, true)
  assert.equal(result.results[0].public, true)
  assert.ok(!calls.some(c => c.action === '/api/external_mcp/upload/finalize' && c.host === 'www.capcut.com'))
})

test('proxy support needs Node 22.21+ or 24.5+', () => {
  assert.equal(proxySupported('22.21.0'), true)
  assert.equal(proxySupported('22.20.1'), false)
  assert.equal(proxySupported('24.4.0'), false)
  assert.equal(proxySupported('24.5.0'), true)
  assert.equal(proxySupported('25.0.0'), true)
  assert.equal(proxySupported('20.18.0'), false)
})
