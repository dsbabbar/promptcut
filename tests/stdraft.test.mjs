import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyOperations, curveAverageSpeed, draftDuration, fontProblems, newDraft, summarize, validate } from '../scripts/stdraft.mjs'

const script = fileURLToPath(new URL('../scripts/stdraft.mjs', import.meta.url))

// Synthetic draft: two main-track clips, one music track and one title.
function sampleDraft() {
  return {
    version: '0.1.0',
    segments: [
      { id: 'draft', type: 'DRAFT', attributes: { width: 1080, height: 1920 } },
      { id: 'clip_a', type: 'VIDEO', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 3000 }, layout: { layer: 0 },
        attributes: { source: 'vid://example-a', meta_type: 'video', 'start.ms': 0, 'end.ms': 3000, volume: 1 } },
      { id: 'clip_b', type: 'VIDEO', parent_id: 'draft', timeline: { 'start.ms': 3000, 'duration.ms': 2000 }, layout: { layer: 0 },
        attributes: { source: 'vid://example-b', meta_type: 'video', 'start.ms': 1000, 'end.ms': 3000, volume: 1 } },
      { id: 'music', type: 'AUDIO', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 5000 }, layout: { layer: 100 },
        attributes: { source: 'vid://example-music', 'end.ms': 5000, volume: 0.5, auto_loop: true } },
      { id: 'title', type: 'TEXT', parent_id: 'draft', timeline: { 'start.ms': 0, 'duration.ms': 2000 }, layout: { layer: 1000, position_x: 0, position_y: 0.4 },
        attributes: { content: 'Hello', font_size: 13 } },
    ],
  }
}

test('a well-formed draft validates', () => {
  assert.deepEqual(validate(sampleDraft()), [])
  assert.equal(draftDuration(sampleDraft()), 5000)
})

test('validation catches structural problems', () => {
  const d = sampleDraft()
  d.segments.push({ ...d.segments[1] })
  d.segments[2].parent_id = 'elsewhere'
  d.segments[4].attributes.content = ' '
  d.segments[2].timeline['start.ms'] = 2000
  const errors = validate(d).join('\n')
  assert.match(errors, /duplicate id/)
  assert.match(errors, /parent_id "draft"/)
  assert.match(errors, /needs text content/)
  assert.match(errors, /overlap/)
  assert.deepEqual(validate({}), ['The document must be an object with a "segments" array'])
})

test('adds text, captions and music on new layers without touching the input', () => {
  const input = sampleDraft()
  const { draft, changes } = applyOperations(input, [
    { op: 'add_text', content: 'Grand opening', start_ms: 0, duration_ms: 1500, font: 'vimo://123' },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1200, text: 'Hi there' }, { start_ms: 1300, end_ms: 2500, text: 'Welcome' }] },
    { op: 'add_audio', source: 'vimo://456', volume: 0.3, fade_out_ms: 1000 },
  ])
  assert.equal(input.segments.length, 5, 'input must not be mutated')
  assert.equal(changes.length, 3)
  const text = draft.segments.find(s => s.attributes?.content === 'Grand opening')
  assert.equal(text.layout.layer, 1001)
  assert.equal(text.attributes.font, 'vimo://456'.replace('456', '123'))
  const captions = draft.segments.filter(s => s.id.startsWith('caption_'))
  assert.equal(captions.length, 2)
  assert.ok(captions.every(c => c.layout.layer === 1), 'captions go on layer 1')
  assert.deepEqual(captions[1].timeline, { 'start.ms': 1300, 'duration.ms': 1200 })
  const audio = draft.segments.find(s => s.id === 'audio_0')
  assert.equal(audio.layout.layer, 101)
  assert.equal(audio.timeline['duration.ms'], 5000)
  assert.equal(audio.attributes['fade_out.ms'], 1000)
  assert.deepEqual(validate(draft), [])
})

test('accepts searched music (sid://) and keeps captions on one low layer', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_audio', source: 'sid://789' },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'English' }] },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 1000, text: 'Second language' }] },
    { op: 'add_captions', cues: [{ start_ms: 2000, end_ms: 3000, text: 'Later' }] },
  ])
  assert.equal(draft.segments.find(s => s.attributes?.source === 'sid://789').type, 'AUDIO')
  const layerOf = text => draft.segments.find(s => s.attributes?.content === text).layout.layer
  assert.equal(layerOf('English'), 1)
  assert.equal(layerOf('Second language'), 2, 'overlapping captions move up one layer')
  assert.equal(layerOf('Later'), 1, 'non-overlapping captions share layer 1')
  // CapCut's read-back spreads captions over layers; reset puts them back on one.
  for (const s of draft.segments) if (s.id.startsWith('caption_')) s.layout.layer += 5
  const { draft: reset, changes } = applyOperations(draft, [{ op: 'reset_caption_layers' }])
  assert.match(changes[0], /Put 3 captions on layers 1, 2/)
  assert.equal(reset.segments.find(s => s.attributes?.content === 'Later').layout.layer, 1)
  assert.equal(reset.segments.find(s => s.attributes?.content === 'Second language').layout.layer, 2)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'reset_caption_layers' }]), /no captions/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_captions', layer: 0, cues: [{ start_ms: 0, end_ms: 1, text: 'x' }] }]), /layer must be/)
})

test('appends video, updates, moves and removes segments', () => {
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'add_video', source: 'vid://example-c', source_start_ms: 500, source_end_ms: 2500 },
    { op: 'update', id: 'title', content: 'Hello world', font_color: '#FFCC00' },
    { op: 'update', id: 'music', volume: 0.2 },
    { op: 'place', id: 'title', start_ms: 500, position_y: -0.5 },
    { op: 'place', id: 'clip_b', duration_ms: 1000 },
    { op: 'remove', id: 'clip_a' },
  ])
  const added = draft.segments.find(s => s.id === 'video_0')
  assert.deepEqual(added.timeline, { 'start.ms': 5000, 'duration.ms': 2000 })
  const title = draft.segments.find(s => s.id === 'title')
  assert.equal(title.attributes.content, 'Hello world')
  assert.equal(title.attributes.text_color, '#FFCC00')
  assert.equal(title.timeline['start.ms'], 500)
  assert.equal(title.layout.position_y, -0.5)
  assert.equal(draft.segments.find(s => s.id === 'music').attributes.volume, 0.2)
  assert.equal(draft.segments.find(s => s.id === 'clip_b').attributes['end.ms'], 2000)
  assert.equal(draft.segments.some(s => s.id === 'clip_a'), false)
})

test('rejects bad operations with the failing step named', () => {
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'explode' }]), /Operation 1: unknown op "explode"/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_text', content: 'x', start_ms: 0, duration_ms: 0 }]), /Operation 1 \(add_text\): duration_ms/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_audio', source: 'https://x' }]), /source must start with/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'remove', id: 'draft' }]), /DRAFT root/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'update', id: 'title', volume: 1 }]), /no volume/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'place', id: 'title', position_y: 3 }]), /between -1 and 1/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'add_video', source: 'vid://x', start_ms: 1000, source_end_ms: 1000 }]), /overlap/)
})

test('summary lists segments by layer and time', () => {
  const lines = summarize(sampleDraft()).split('\n')
  assert.equal(lines[0], 'Canvas 1080x1920, length 5.0s, 4 segments')
  assert.match(lines[1], /^clip_a\s+VIDEO layer 0\s+0\.0s-3\.0s\s+vid:\/\/example-a from source 0\.0s-3\.0s$/)
  assert.match(lines[4], /^title\s+TEXT\s+layer 1000\s+0\.0s-2\.0s\s+"Hello"$/)
})

test('CLI applies operations, keeps UTF-8 and refuses to write invalid results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-draft-'))
  const input = path.join(dir, 'draft.json')
  const ops = path.join(dir, 'ops.json')
  const out = path.join(dir, 'out.json')
  fs.writeFileSync(input, '﻿' + JSON.stringify(sampleDraft()))
  fs.writeFileSync(ops, JSON.stringify([{ op: 'add_text', content: 'Reality ✂️😱', start_ms: 0, duration_ms: 1000 }]))
  const result = JSON.parse(execFileSync(process.execPath, [script, 'apply', '--in', input, '--ops', ops, '--out', out]).toString())
  assert.equal(result.success, true)
  assert.ok(fs.readFileSync(out, 'utf8').includes('Reality ✂️😱'))

  fs.writeFileSync(ops, JSON.stringify([{ op: 'remove', id: 'missing' }]))
  fs.rmSync(out)
  assert.throws(() => execFileSync(process.execPath, [script, 'apply', '--in', input, '--ops', ops, '--out', out], { stdio: 'pipe' }))
  assert.equal(fs.existsSync(out), false)
})

test('builds a new draft and adds an uploaded clip with captions', () => {
  assert.throws(() => newDraft(0, 1920), /width/)
  const { draft } = applyOperations(newDraft(1080, 1920), [
    { op: 'add_video', source: 'vid://uploaded', source_end_ms: 4000 },
    { op: 'add_captions', cues: [{ start_ms: 0, end_ms: 2000, text: 'Line one' }] },
  ])
  assert.deepEqual(validate(draft), [])
  assert.match(summarize(draft), /^Canvas 1080x1920, length 4\.0s, 2 segments/)
})

test('handles untimed segments and flags fonts that are not library fonts', () => {
  const d = sampleDraft()
  d.segments.push({ id: 'patch_0', type: 'PATCH', parent_id: 'draft', attributes: { note: 'added by an editor app' } })
  d.segments.find(s => s.id === 'title').attributes.font = 'vimo://C:/Users/someone/fonts/Local.ttf'
  assert.deepEqual(validate(d), [])
  assert.deepEqual(fontProblems(d), ['title'])
  const text = summarize(d)
  assert.match(text, /Other segments kept unchanged: patch_0 \(PATCH\)/)
  assert.match(text, /Warning: .*title/)
  const { draft } = applyOperations(d, [{ op: 'update', id: 'title', font: 'vimo://7317175475195875841' }])
  assert.deepEqual(fontProblems(draft), [])
  assert.ok(draft.segments.some(s => s.id === 'patch_0'), 'unknown segments are preserved')
})

test('add_image appends still images to the main track', () => {
  const draft = newDraft(1920, 1080)
  const { draft: out, changes } = applyOperations(draft, [
    { op: 'add_image', source: 'tos-x/slide1', duration_ms: 4000 },
    { op: 'add_image', source: 'tos://tos-x/slide2', duration_ms: 2500 },
    { op: 'place', id: 'image_0', duration_ms: 3000 },
  ])
  const images = out.segments.filter(s => s.attributes?.meta_type === 'photo')
  assert.equal(images.length, 2)
  assert.equal(images[0].attributes.source, 'tos://tos-x/slide1')
  assert.deepEqual(images[1].timeline, { 'start.ms': 4000, 'duration.ms': 2500 })
  assert.equal(images[0].timeline['duration.ms'], 3000)
  assert.ok(!('end.ms' in images[0].attributes), 'a still image has no source end')
  assert.equal(images[0].type, 'VIDEO')
  assert.equal(images[0].layout.layer, 0)
  assert.match(changes[0], /Added image/)
  assert.match(summarize(out), /\(still image\)/)
  assert.deepEqual(validate(out), [])
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', source: 'tos://x' }]), /duration_ms/)
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', source: 'https://example.com/a.png', duration_ms: 1000 }]), /source must start with/)
})

test('validation rejects speed on still images', () => {
  const { draft } = applyOperations(newDraft(1920, 1080), [{ op: 'add_image', source: 'tos://x/y', duration_ms: 1000 }])
  draft.segments.find(s => s.type === 'VIDEO').attributes.speed = 2
  assert.match(validate(draft).join('\n'), /cannot have speed/)
})

test('set_speed retimes a clip and moves later main-track clips', () => {
  const { draft, changes } = applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'clip_a', speed: 2 }])
  const a = draft.segments.find(s => s.id === 'clip_a')
  const b = draft.segments.find(s => s.id === 'clip_b')
  assert.equal(a.attributes.speed, 2)
  assert.equal(a.timeline['duration.ms'], 1500)
  assert.equal(b.timeline['start.ms'], 1500, 'the next clip moves up')
  assert.equal(draft.segments.find(s => s.id === 'title').timeline['start.ms'], 0, 'text is not moved')
  assert.match(changes[0], /2x: now 1.5s \(shorter by 1.5s\); 1 later main-track clip moved/)
  assert.deepEqual(validate(draft), [])
  const back = applyOperations(draft, [{ op: 'set_speed', id: 'clip_a', speed: 1 }]).draft
  assert.equal('speed' in back.segments.find(s => s.id === 'clip_a').attributes, false)
  assert.equal(back.segments.find(s => s.id === 'clip_b').timeline['start.ms'], 3000)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'clip_a', speed: 0 }]), /speed must be/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'set_speed', id: 'title', speed: 2 }]), /not a video clip/)
})

test('speed_ramp writes a CapCut speed curve and retimes the clip', () => {
  assert.equal(curveAverageSpeed([{ x: 0, y: 2 }, { x: 1, y: 2 }]), 2)
  assert.ok(Math.abs(curveAverageSpeed([{ x: 0, y: 1 }, { x: 0.25, y: 3 }, { x: 0.75, y: 3 }, { x: 1, y: 1 }]) - 2.4) < 1e-9)
  const { draft } = applyOperations(sampleDraft(), [
    { op: 'set_speed', id: 'clip_a', speed: 2 },
    { op: 'speed_ramp', id: 'clip_a', shape: 'fast_middle' },
  ])
  const a = draft.segments.find(s => s.id === 'clip_a')
  assert.equal('speed' in a.attributes, false, 'a ramp replaces a constant speed')
  assert.deepEqual(JSON.parse(a.attributes.curve_speed), [{ x: 0, y: 1 }, { x: 0.25, y: 3 }, { x: 0.75, y: 3 }, { x: 1, y: 1 }])
  assert.equal(a.timeline['duration.ms'], 1250)
  assert.equal(draft.segments.find(s => s.id === 'clip_b').timeline['start.ms'], 1250)
  assert.match(summarize(draft), /speed ramp \(average 2.40x\)/)
  assert.deepEqual(validate(draft), [])
  // Trimming a ramped clip keeps the source range in step with its speed.
  const trimmed = applyOperations(draft, [{ op: 'place', id: 'clip_a', duration_ms: 1000 }]).draft
  assert.equal(trimmed.segments.find(s => s.id === 'clip_a').attributes['end.ms'], 2400)
  const custom = applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_b', points: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] }]).draft
  assert.equal(custom.segments.find(s => s.id === 'clip_b').timeline['duration.ms'], 4000)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', shape: 'zoom' }]), /shape must be/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', points: [{ x: 0, y: 1 }, { x: 0.5, y: 2 }] }]), /end at x 1/)
  assert.throws(() => applyOperations(sampleDraft(), [{ op: 'speed_ramp', id: 'clip_a', points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }]), /y must be/)
  const bad = sampleDraft(); bad.segments[1].attributes.curve_speed = '[{"x":0,"y":1}]'
  assert.match(validate(bad).join('\n'), /invalid curve_speed/)
})

test('CapCut curve presets give the clip lengths CapCut shows for a 6-second clip', () => {
  const six = () => {
    const d = sampleDraft()
    Object.assign(d.segments[1], { timeline: { 'start.ms': 0, 'duration.ms': 6000 } })
    Object.assign(d.segments[1].attributes, { 'start.ms': 0, 'end.ms': 6000 })
    d.segments[2].timeline['start.ms'] = 6000
    return d
  }
  const expected = { montage: 3, hero: 3, bullet: 2, jump_cut: 9, flash_in: 3, flash_out: 3 }
  for (const [shape, seconds] of Object.entries(expected)) {
    const { draft, changes } = applyOperations(six(), [{ op: 'speed_ramp', id: 'clip_a', shape }])
    const ms = draft.segments.find(s => s.id === 'clip_a').timeline['duration.ms']
    assert.ok(Math.abs(ms / 1000 - seconds) < 0.5, `${shape}: ${ms} ms, CapCut shows ${seconds}s`)
    assert.match(changes[0], /curve to clip_a/)
    assert.deepEqual(validate(draft), [])
  }
  assert.throws(() => applyOperations(six(), [{ op: 'speed_ramp', id: 'clip_a', shape: 'hero', peak: 4 }]), /fixed CapCut preset/)
})
