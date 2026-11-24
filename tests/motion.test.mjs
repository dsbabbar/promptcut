import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HYPERFRAMES_VERSION, LOCAL_COMMANDS, planToOps, runtimeDir, summarizeProbe } from '../scripts/motion.mjs'
import { applyOperations, newDraft, validate } from '../scripts/stdraft.mjs'

test('HyperFrames is pinned and only local commands run', () => {
  assert.match(HYPERFRAMES_VERSION, /^\d+\.\d+\.\d+$/)
  for (const c of ['init', 'check', 'snapshot', 'render']) assert.ok(LOCAL_COMMANDS.has(c))
  for (const c of ['cloud', 'lambda', 'cloudrun', 'publish', 'skills', 'upgrade', 'open']) assert.ok(!LOCAL_COMMANDS.has(c), c)
  assert.ok(runtimeDir({ PROMPTCUT_HYPERFRAMES_DIR: '/x/hf' }).endsWith('hf'))
  assert.ok(runtimeDir({}).includes(`hyperframes-${HYPERFRAMES_VERSION}`))
})

test('probe summaries give whole-frame lengths', () => {
  const s = summarizeProbe('a.mp4', { streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30/1', nb_frames: '75' }], format: { duration: '2.500000' } })
  assert.deepEqual(s, { file: 'a.mp4', width: 1080, height: 1920, fps: 30, frames: 75, duration_ms: 2500, has_audio: false })
  const ntsc = summarizeProbe('b.mp4', { streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', nb_frames: '100' }, { codec_type: 'audio' }], format: { duration: '3.336667' } })
  assert.equal(ntsc.duration_ms, 3337)
  assert.equal(ntsc.has_audio, true)
  assert.equal(summarizeProbe('c.mp3', { streams: [{ codec_type: 'audio' }], format: {} }).error, 'no video stream')
})

test('a shot plan becomes a valid draft: shots in order, transitions, music and captions', () => {
  const plan = {
    shots: [
      { id: 'intro', vid: 'v1', duration_ms: 2000, transition: { source: 'vimo://t', duration_ms: 400 } },
      { id: 'steps', vid: 'vid://v2', duration_ms: 4000 },
      { id: 'outro', vid: 'v3', duration_ms: 3000, has_audio: true },
    ],
    music: { source: 'sid://m', volume: 0.4, fade_out_ms: 1500 },
    captions: { cues: [{ start_ms: 0, end_ms: 1800, text: 'Hello' }] },
  }
  const ops = planToOps(plan)
  const { draft } = applyOperations(newDraft(1080, 1920), ops)
  assert.deepEqual(validate(draft), [])
  const shots = ['intro', 'steps', 'outro'].map(id => draft.segments.find(s => s.id === id))
  assert.deepEqual(shots.map(s => s.timeline['start.ms']), [0, 2000, 6000])
  assert.deepEqual(shots.map(s => s.attributes.volume), [0, 0, 1], 'silent renders are muted, shots with sound keep it')
  assert.equal(shots[0].attributes['transition.duration.ms'], 400)
  const music = draft.segments.find(s => s.type === 'AUDIO')
  assert.deepEqual([music.timeline['duration.ms'], music.attributes.volume, music.attributes['fade_out.ms']], [9000, 0.4, 1500])
  assert.ok(draft.segments.some(s => s.type === 'TEXT' && s.attributes.content === 'Hello'))
})

test('bad shot plans are refused with the shot named', () => {
  assert.throws(() => planToOps({ shots: [] }), /at least one shot/)
  assert.throws(() => planToOps({ shots: [{ id: 'a b', vid: 'v', duration_ms: 1 }] }), /shot 1 needs an id/)
  assert.throws(() => planToOps({ shots: [{ id: 'a', vid: 'v', duration_ms: 1 }, { id: 'a', vid: 'w', duration_ms: 1 }] }), /used twice/)
  assert.throws(() => planToOps({ shots: [{ id: 'a', duration_ms: 1 }] }), /no uploaded vid/)
  assert.throws(() => planToOps({ shots: [{ id: 'a', vid: 'v', duration_ms: 1.5 }] }), /duration_ms/)
  assert.throws(() => planToOps({ shots: [{ id: 'a', vid: 'v', duration_ms: 1, transition: { source: 'vimo://t' } }] }), /no next shot/)
})

test('add_video and add_image keep a chosen id, and refuse a used or odd one', () => {
  const { draft } = applyOperations(newDraft(1080, 1920), [{ op: 'add_video', id: 'intro', source: 'vid://v', source_end_ms: 1000 }])
  assert.ok(draft.segments.some(s => s.id === 'intro'))
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', id: 'intro', source: 'tos://x', duration_ms: 1000 }]), /already used/)
  assert.throws(() => applyOperations(draft, [{ op: 'add_image', id: 'no spaces', source: 'tos://x', duration_ms: 1000 }]), /id must be/)
})
