import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { buildPptx, crc32, escapeXml, pngSize, zip } from '../scripts/slides-pptx.mjs'

// A valid 2x1 PNG.
function png(width = 2, height = 1) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Minimal zip reader using the central directory.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0, 'no end of central directory')
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const files = {}
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const localNameLen = buf.readUInt16LE(offset + 26)
    const data = buf.subarray(offset + 30 + localNameLen, offset + 30 + localNameLen + size)
    const content = method === 0 ? data : zlib.inflateRawSync(data)
    assert.equal(crc32(content), crc, `crc of ${name}`)
    files[name] = content
    p += 46 + nameLen
  }
  return files
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('zip round-trips stored and deflated entries', () => {
  const files = unzip(zip([{ name: 'a.txt', data: 'hello hello hello' }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]), store: true }]))
  assert.equal(files['a.txt'].toString(), 'hello hello hello')
  assert.deepEqual([...files['dir/b.bin']], [1, 2, 3])
})

test('reads PNG sizes and rejects other files', () => {
  assert.deepEqual(pngSize(png(1280, 720)), { width: 1280, height: 720 })
  assert.throws(() => pngSize(Buffer.from('not a png at all, really')), /not a PNG/)
})

test('escapes XML text', () => {
  assert.equal(escapeXml('a & <b> "c"\u0001'), 'a &amp; &lt;b&gt; &quot;c&quot;')
})

test('builds a presentation with one picture slide and notes per slide', () => {
  const buffer = buildPptx({
    slides: [{ png: png(), notes: 'First & <best>\n\nsecond line' }, { png: png() }],
    ratio: [1024, 768],
    title: 'Deck "one"',
    date: new Date('2026-01-02T03:04:05Z'),
  })
  const files = unzip(buffer)
  const names = Object.keys(files)
  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml',
    'ppt/notesMasters/notesMaster1.xml', 'ppt/theme/theme2.xml', 'docProps/core.xml', 'docProps/app.xml',
    'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/media/slide1.png', 'ppt/media/slide2.png',
    'ppt/notesSlides/notesSlide1.xml', 'ppt/notesSlides/notesSlide2.xml',
  ]) {
    assert.ok(names.includes(required), `missing ${required}`)
  }
  const presentation = files['ppt/presentation.xml'].toString()
  assert.match(presentation, /<p:sldSz cx="9144000" cy="6858000"\/>/)
  assert.match(presentation, /<p:sldId id="256" r:id="rId10"\/><p:sldId id="257" r:id="rId11"\/>/)
  const types = files['[Content_Types].xml'].toString()
  for (const name of names.filter(n => n.endsWith('.xml') && n !== '[Content_Types].xml')) {
    assert.ok(types.includes(`PartName="/${name}"`), `content type for ${name}`)
  }
  const notes = files['ppt/notesSlides/notesSlide1.xml'].toString()
  assert.match(notes, /<a:t>First &amp; &lt;best&gt;<\/a:t>/)
  assert.match(notes, /<a:t>second line<\/a:t>/)
  assert.equal((notes.match(/<a:p>/g) || []).length, 3)
  assert.match(files['ppt/slides/_rels/slide2.xml.rels'].toString(), /Target="\.\.\/media\/slide2\.png"/)
  assert.match(files['docProps/core.xml'].toString(), /<dc:title>Deck &quot;one&quot;<\/dc:title>/)
  assert.match(files['docProps/core.xml'].toString(), /2026-01-02T03:04:05Z/)
  assert.throws(() => buildPptx({ slides: [] }), /at least one slide/)
})
