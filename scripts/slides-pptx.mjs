// Build a PowerPoint (.pptx) file from slide images, with speaker notes. Uses only Node.js built-in modules.
//
// Each slide is one full-bleed picture, so the deck looks exactly like the HTML version, but its text cannot be
// edited in PowerPoint. Speaker notes are real PowerPoint notes.

import zlib from 'node:zlib'

const EMU_PER_PX = 9525
const SLIDE_HEIGHT_EMU = 6858000 // 7.5 inches, the PowerPoint standard height

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

// entries: [{ name, data: Buffer|string, store?: boolean }]
export function zip(entries, date = new Date()) {
  const { time, day } = dosDateTime(date)
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const store = entry.store === true
    const body = store ? raw : zlib.deflateRawSync(raw)
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

export function pngSize(buf) {
  const signature = '89504e470d0a1a0a'
  if (!Buffer.isBuffer(buf) || buf.length < 24 || buf.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Slide image is not a PNG file')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export function escapeXml(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'

function rels(list) {
  return `${XML}<Relationships xmlns="${PKG_REL}">${list
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`
}

const EMPTY_TREE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

const CLR_MAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"'

function theme(name) {
  const colors = [
    ['dk1', '<a:sysClr val="windowText" lastClr="000000"/>'],
    ['lt1', '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ['dk2', '<a:srgbClr val="1F2937"/>'],
    ['lt2', '<a:srgbClr val="E5E7EB"/>'],
    ['accent1', '<a:srgbClr val="2563EB"/>'],
    ['accent2', '<a:srgbClr val="F97316"/>'],
    ['accent3', '<a:srgbClr val="10B981"/>'],
    ['accent4', '<a:srgbClr val="8B5CF6"/>'],
    ['accent5', '<a:srgbClr val="EF4444"/>'],
    ['accent6', '<a:srgbClr val="EAB308"/>'],
    ['hlink', '<a:srgbClr val="2563EB"/>'],
    ['folHlink', '<a:srgbClr val="7C3AED"/>'],
  ]
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const line = w => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
  return (
    `${XML}<a:theme xmlns:a="${NS_A}" name="${escapeXml(name)}"><a:themeElements>` +
    `<a:clrScheme name="promptcut">${colors.map(([k, v]) => `<a:${k}>${v}</a:${k}>`).join('')}</a:clrScheme>` +
    '<a:fontScheme name="promptcut"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="promptcut"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  )
}

function notesParagraphs(notes) {
  const lines = String(notes || '').replace(/\r\n?/g, '\n').split('\n')
  return lines
    .map(line => (line ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>` : '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>'))
    .join('')
}

// slides: [{ png: Buffer, notes?: string }], ratio: [width, height] of the HTML canvas in px.
export function buildPptx({ slides, ratio = [1280, 720], title = 'Presentation', date = new Date() }) {
  if (!Array.isArray(slides) || slides.length === 0) throw new Error('A presentation needs at least one slide')
  const cy = SLIDE_HEIGHT_EMU
  const cx = Math.round((cy * ratio[0]) / ratio[1])
  for (const slide of slides) pngSize(slide.png)
  const notesCx = 6858000
  const notesCy = 9144000
  const files = []
  const add = (name, data, store) => files.push({ name, data, store })

  const overrides = [
    ['/ppt/presentation.xml', `${CT}.presentation.main+xml`],
    ['/ppt/slideMasters/slideMaster1.xml', `${CT}.slideMaster+xml`],
    ['/ppt/slideLayouts/slideLayout1.xml', `${CT}.slideLayout+xml`],
    ['/ppt/notesMasters/notesMaster1.xml', `${CT}.notesMaster+xml`],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/ppt/presProps.xml', `${CT}.presProps+xml`],
    ['/ppt/viewProps.xml', `${CT}.viewProps+xml`],
    ['/ppt/tableStyles.xml', `${CT}.tableStyles+xml`],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
  ]
  slides.forEach((_, i) => {
    overrides.push([`/ppt/slides/slide${i + 1}.xml`, `${CT}.slide+xml`])
    overrides.push([`/ppt/notesSlides/notesSlide${i + 1}.xml`, `${CT}.notesSlide+xml`])
  })
  add(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
      overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
      '</Types>',
  )
  add(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${PKG_REL}">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  )
  const stamp = date.toISOString().replace(/\.\d+Z$/, 'Z')
  add(
    'docProps/core.xml',
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${escapeXml(title)}</dc:title><dc:creator>promptcut</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`,
  )
  add(
    'docProps/app.xml',
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>promptcut</Application><Slides>${slides.length}</Slides><Notes>${slides.length}</Notes></Properties>`,
  )

  const presRels = [
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'],
    ['rId4', 'presProps', 'presProps.xml'],
    ['rId5', 'viewProps', 'viewProps.xml'],
    ['rId6', 'tableStyles', 'tableStyles.xml'],
  ]
  slides.forEach((_, i) => presRels.push([`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`]))
  add('ppt/_rels/presentation.xml.rels', rels(presRels))
  add(
    'ppt/presentation.xml',
    `${XML}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
      `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="${notesCx}" cy="${notesCy}"/>` +
      '<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>',
  )
  add('ppt/presProps.xml', `${XML}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`)
  add(
    'ppt/viewProps.xml',
    `${XML}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
  )
  add('ppt/tableStyles.xml', `${XML}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)
  add('ppt/theme/theme1.xml', theme('promptcut'))
  add('ppt/theme/theme2.xml', theme('promptcut notes'))

  add(
    'ppt/slideMasters/slideMaster1.xml',
    `${XML}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld>` +
      `<p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
      '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>',
  )
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]))
  add(
    'ppt/slideLayouts/slideLayout1.xml',
    `${XML}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_TREE}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  )
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]))

  const nmImgW = 5486400
  const nmImgH = Math.round((nmImgW * cy) / cx)
  add(
    'ppt/notesMasters/notesMaster1.xml',
    `${XML}<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_TREE}` +
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${Math.round((notesCx - nmImgW) / 2)}" y="685800"/><a:ext cx="${nmImgW}" cy="${nmImgH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="685800" y="${685800 + nmImgH + 228600}"/><a:ext cx="5486400" cy="${Math.max(1828800, notesCy - (685800 + nmImgH + 228600) - 685800)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
      '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>' +
      `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle><a:lvl1pPr marL="0" algn="l" rtl="0"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`,
  )
  add('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([['rId1', 'theme', '../theme/theme2.xml']]))

  slides.forEach((slide, i) => {
    const n = i + 1
    add(`ppt/media/slide${n}.png`, slide.png, true)
    add(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${EMPTY_TREE}` +
        `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide ${n}" descr="Slide ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
        `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    )
    add(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      rels([
        ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
        ['rId2', 'image', `../media/slide${n}.png`],
        ['rId3', 'notesSlide', `../notesSlides/notesSlide${n}.xml`],
      ]),
    )
    add(
      `ppt/notesSlides/notesSlide${n}.xml`,
      `${XML}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${EMPTY_TREE}` +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
        `<p:txBody><a:bodyPr/><a:lstStyle/>${notesParagraphs(slide.notes)}</p:txBody></p:sp>` +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>',
    )
    add(
      `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
      rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]]),
    )
  })

  return zip(files, date)
}
