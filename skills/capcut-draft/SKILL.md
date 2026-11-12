---
name: capcut-draft
description: Add, change or remove captions, text, music and video clips in a CapCut cloud draft, and open the draft in the CapCut web editor. Use when the user wants to edit a rough cut or an existing CapCut draft, burn captions into a video, add background music or text, or move, trim or delete clips.
---

# Edit CapCut drafts

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes.

Before running any `${CLAUDE_PLUGIN_ROOT}/scripts/` command or ffmpeg, make sure the `capcut-connect` skill's setup check has passed in this conversation.

A CapCut draft is a cloud project that the user can also open in the CapCut web editor. Claude edits it as an STDraft JSON document: download it, change it locally with `scripts/stdraft.mjs`, then save it back. CapCut validates every save.

The user's own edits always win. Drafts also sync to the CapCut desktop app, and if the user saves in the web editor or the desktop app while you are editing, your save is rejected with a version conflict, by design. Simply having the draft open in the desktop app can save new versions.

## Draft sessions

Each draft session (`session_id` from `start_stdraft_session`) is bound to one cloud draft. A new session has no draft until the first save. Keep together, for each session: its `session_id`, the latest `package_id` (the draft version), the latest document saved to a local file, and its editor link. Never mix up a draft `session_id` with a rough-cut editing session or a generation task.

Reuse the session the user is clearly continuing. If several could apply, ask which draft they mean, describing each by its content, not its ID.

## Get the starting document

- **Draft session already in use:** use the document and `package_id` from your last save. If you have none, call `get_stdraft_snapshot` with the `session_id`.
- **Fresh rough cut:** call `video_preview` (on `capcut-cards`) with the rough-cut event's `context` and `resources` unchanged. Its output includes the finished draft as an STDraft string. Then call `start_stdraft_session`. The first save, with an empty `base_package_id`, turns the rough cut into an editable cloud draft.
- **An uploaded video with no draft:** get its width, height and duration from `capcut_batch_media_url` (`vids`). Phone videos are often stored landscape with a rotation flag, so for a local file also check with `ffprobe` when available, and swap width and height when it is rotated 90 or 270 degrees. Ask the user if the shape is still unclear. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/stdraft.mjs" new --width <w> --height <h> --out <tmp>/draft.json`, then include an `add_video` operation for the clip (`source_end_ms` = its duration) in the first edit round, and call `start_stdraft_session`. The first save, with an empty `base_package_id`, creates the draft.
- **Nothing to start from:** ask the user what to build on, such as a rough cut or uploaded clips.

Save the document as UTF-8 JSON in a temporary folder, for example `<tmp>/draft.json`. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/stdraft.mjs" summary --in <tmp>/draft.json` to see the timeline, with each segment's id, type, layer, times, source and font. Segments without a timeline (such as `PATCH` segments added by the CapCut desktop app) are listed separately and must be left unchanged. If the summary warns that text has a font that is not a CapCut library font (often a local font path saved by the desktop app), tell the user it may show in a fallback font and offer to set a library font with `update`.

## Edit round

1. **Plan the operations** from the user's request and the summary. Write them as a JSON array to `<tmp>/ops.json`. Supported operations (times in milliseconds):

   | op | Fields | Notes |
   | --- | --- | --- |
   | `add_text` | `content`, `start_ms`, `duration_ms`, optional `position_x`, `position_y` (-1 to 1), `font_size`, `font_color`, `font`, text style fields, `scale`, `rotation`, `opacity` | A title or label on its own layer |
   | `add_captions` | `cues: [{start_ms, end_ms, text}]`, optional `position_y`, `font_size`, `font`, `layer` | All cues on layer 1, the lowest text track (or the next layer up if captions there already overlap in time), near the bottom by default. Use the `capcut-captions` skill to get cues. |
   | `add_audio` | `source`, optional `start_ms`, `duration_ms` (default: to the end), `source_start_ms` (where in the track to start, such as the chorus), `kind` (`music` or `sound`), `volume`, `fade_in_ms`, `fade_out_ms`, `loop` | Music or a sound effect. `source` is the `stdraft_uri` from `capcut-materials` exactly as returned (usually `sid://...`, sometimes `vimo://...`), or an uploaded audio `vid` written as `vid://<vid>`. For a sound effect at a moment, use `kind: "sound"` with `start_ms` and the effect's length as `duration_ms`. |
   | `add_video` | `source` (`vid://<vid>`), `source_end_ms`, optional `source_start_ms`, `start_ms`, `volume`, `overlay`, `layer`, `position_x`, `position_y`, `scale`, `rotation`, `opacity`, `crop`, `background_blur`, `background_color` | Appends to the end of the main track unless `start_ms` is given. With `overlay: true` and `start_ms`, it goes on top of the main track instead (picture-in-picture, such as a face-cam in a corner). |
   | `add_image` | `source` (an uploaded image's `uri`, written as `tos://<uri>`), `duration_ms`, optional `start_ms`, and the same overlay, layout and look fields as `add_video` | A still image on the main track, such as a slide or photo, or with `overlay: true` an image on top, such as a logo or watermark. |
   | `update` | `id`, then any of `content`, `volume`, `font_size`, `font_color`, `font`, `fade_in_ms`, `fade_out_ms`, text style fields (text only), `crop`, `background_blur`, `background_color` (video clips and images) | Changes a segment in place. Never add a new segment and call it an update. `crop: null` removes a crop. |
   | `place` | `id`, then any of `start_ms`, `duration_ms`, `position_x`, `position_y`, `layer`, `scale`, `scale_x`, `scale_y`, `rotation`, `opacity` | Moves, trims, resizes, rotates or fades a segment |
   | `remove` | `id` | Deletes a segment. Gaps it leaves are not closed. |
   | `animate` | `id`, `property` (`position_x`, `position_y`, `scale`, `scale_x`, `scale_y`, `rotation`, `opacity`), `keyframes: [{time_ms, value}]` | **Don't use for now.** It writes keyframes, and CapCut's cloud drafts currently drop all keyframes on save, so nothing animates. Tell the user to add movement or fades in the CapCut editor (Animation or keyframes). |
   | `zoom` | `id`, optional `from`, `to`, `pan`, `pan_amount` | **Don't use for now**, for the same reason: CapCut drops the keyframes it writes. For a slow zoom on photos, point the user to the editor's Animation panel (for example a zoom-in animation) or keyframes. |
   | `duck` | `id` (a music or sound track), `ranges: [{start_ms, end_ms}]` (project time), optional `to` (default 0.25 of its volume), `fade_ms` (default 300) | Lowers the track during each range, for example while someone speaks. It splits the track into back-to-back parts with quieter parts during the ranges and short crossfades between them, because CapCut drops volume keyframes. Ranges closer than two fades merge. Tell the user the music is now several pieces in the editor. |
   | `set_speed` | `id`, `speed` (0.1 to 100; 2 = twice as fast, 0.5 = half speed, 1 = normal) | Constant speed for a video clip. Replaces any ramp. |
   | `speed_ramp` | `id`, then `shape`, or `points: [{x, y}]` | A speed ramp on a video clip. `shape` is one of CapCut's curve presets, named as in its Speed > Curve panel: `montage`, `hero`, `bullet`, `jump_cut`, `flash_in`, `flash_out`. Or it is a basic shape with an optional `peak` (default 3): `ramp_up`, `ramp_down`, `fast_middle` (fast through the middle, normal at both ends, as for a stair climb) or `slow_middle`. For `points`, `x` runs from 0 (start of the clip) to 1 (end) and `y` is the speed there (0.1 to 100). |
   | `reset_caption_layers` | optional `layer` (default 1) | Puts all captions back on the lowest layers, one layer when they don't overlap in time. |

   **Text style fields** (on `add_text`, on `update` for text, and as `style: {...}` on `add_captions`): `alignment` (`left`, `center`, `right`), `outline` (true or false), `outline_color`, `outline_width` (default 0.06), `shadow` (true or false), `shadow_color`, `shadow_opacity` (default 0.4), `shadow_distance` (default 2), `shadow_blur` (0 to 1, default 0.3), `shadow_angle`, `box_color` and `box_opacity` (a background box behind the text; **CapCut currently saves these but doesn't draw the box**, so don't offer it), `text_opacity`, `underline`, `letter_spacing`, `line_spacing`, `line_max_width` (0.05 to 1, the share of the frame width a line may use), `bold_width`, `italic_degree`. Colours are `#RRGGBB` or `#RRGGBBAA`. The outline and shadow defaults are the values CapCut uses on its own captions.

   **Layout:** `position_x` and `position_y` run from -1 to 1 with (0, 0) at the centre and positive y up; `scale` 1 is the original size; `rotation` is in degrees, clockwise; `opacity` runs from 0 to 1. **Crop** is `[left, top, right, bottom]`, each from 0 to 1. **Background fill** shows behind a clip that doesn't fill the frame, for example a landscape clip in a 9:16 reel: `background_blur` (0 to 1; `true` gives a soft 0.2, and 0.5 already looks strong) or `background_color`.

   **Layers:** CapCut gives clips, images and text one shared set of layers (audio has its own) and renumbers them on read-back. The operations pick free layers for you; if you set `layer` yourself, choose one that no other clip, image or text uses at that time. `validate` reports clashes, which CapCut would reject with `invalid stdraft`.

   **Always set `font` on text you add or restyle.** Without one, the CapCut web editor and desktop app each substitute their own default font, so the same text can wrap differently. `font` takes a font's `vimo://<id>` `stdraft_uri` from `capcut-materials`. Unless the user named a font, search fonts once per conversation (`search_capcut_material` with `type: "font"`, `top_n: 20`), pick a clean, legible sans-serif from the descriptions, tell the user which one you chose, and reuse it for all new text.

   **Keep captions on as few tracks as possible.** CapCut's read-back spreads captions over extra layers, and saving those layers as they are adds a track each time. Whenever the draft has captions, end every operation list with `{"op": "reset_caption_layers"}`, including saves that only change something else. Even so, CapCut usually shows the first caption on a track of its own and the rest together on a second track. Tell the user they can drag the first caption onto the shared track in the editor if they want one track.

2. **Apply locally:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/stdraft.mjs" apply --in <tmp>/draft.json --ops <tmp>/ops.json --out <tmp>/draft-new.json`. On an error, fix the operations and run again. Nothing is written until every operation succeeds and the result validates. Run `summary` on the result and check it matches the request.
3. **Check the version, right before saving:** call `check_stdraft_state` with the `session_id` and your current `package_id` (empty for a new draft). This also shows an "editing" overlay in the web editor for up to 20 minutes, so only call it when you are about to save. If `stale` is true, the user changed the draft in the browser: call `get_stdraft_snapshot`, apply the same operations to that newer document, and tell the user you built on their latest changes.
4. **Save:** call `push_stdraft_snapshot` with `session_id`, `base_package_id` (the version you edited, or empty for a new draft) and `stdraft_json` (the new document as a string).
5. **After a successful save:** keep the returned `server_package_id` as the new version. If `stdraft_json` is returned, save it as the new baseline document, otherwise call `get_stdraft_snapshot`. Tell the user what changed, in plain words, and give them `web_editor_url` with its `web_editor_text` label so they can review and export in the CapCut web editor. Saving a draft does not export a new video file.

   After the first save of a new draft, also tell the user, once per draft:
   - **Names:** CapCut's draft tools can't set a name, and every save resets it. The CapCut desktop app shows "Untitled" and the web editor shows the date and time of the last save (such as 202611111913). A name the user gives the draft is lost at the next save, so they should rename it only after the last change.
   - **Open it on the web first:** open the draft with the web editor link before opening it in the desktop app. Opened only in the desktop app, it gets a numbered name such as "(4)", and closing it there can create a separate copy. Those copies don't receive later saves; check before deleting any.

## Save errors

| Error | Action |
| --- | --- |
| `STDRAFT_INVALID` | Nothing was saved. Read the validation details, fix the operations or document, and try once more. If it fails again, report the details to the user. |
| `STDRAFT_VERSION_CONFLICT` | Nothing was saved, because the draft changed in the browser. Get the latest snapshot, re-apply the operations, check the summary, then save again with the new `package_id`. |
| `save cloud draft failed` with `ret=2005` | The draft was deleted in CapCut, so this session can't save to it. Tell the user, call `start_stdraft_session` for a new draft, and save the current document with an empty `base_package_id`. |
| Unsure whether a save went through | Call `check_stdraft_state` or `get_stdraft_snapshot` first. Never repeat a save blindly. |
| Login error (for example `check login error` or `get user workspace failed`) | Stop and follow the `capcut-connect` skill. Do not retry or try other tools first. |

## Limits of this version

- Supported: text with styling (outline, shadow, alignment, spacing), captions, music (with a start offset) and sound effects at set moments, lowering the music under speech, main-track video clips and still images, overlays and picture-in-picture, crop, background blur or colour fill, size, rotation and opacity, volume and fades, constant speed and speed ramps, moving, trimming and removing segments.

**Tested in a real draft (v0.3.0):** overlays with position, size and opacity, background blur, size and rotation, crop (saved), music start offset, sound effects and speed changes. **Not kept by CapCut:** keyframes (`animate`, `zoom`) and the text box. Text outline and shadow may look fainter after later saves, because CapCut keeps per-letter style overrides (PATCH segments) that lose detail; if the user notices, restyle the text with `update`.

**Speed changes change a clip's length.** `set_speed` and `speed_ramp` recalculate the clip's length from its speed, and later clips on the main track move to match. Text, captions and music don't move, so tell the user when timings that depended on the old length may now be off, and offer to shift them with `place`. Still images can't change speed. When the user names a CapCut preset ("give it the Hero curve"), use that shape. CapCut's editor smooths the curves, so a preset can look slightly different from picking the same preset in CapCut, while the clip length matches. Speed ramps follow CapCut's draft format, but how a ramp looks hasn't been checked in a real CapCut draft yet: after the first save with a ramp, ask the user to play the clip in the editor and tell you if it looks wrong.
- Not yet supported: filters, transitions, video effects, text effects, text templates and stickers. If asked for these, say so, and offer to find the material with `capcut-materials` so the user can apply it in the web editor.
- CapCut converts drafts between its cloud format and STDraft, so a document read back can differ slightly from the one saved. Always continue from the read-back version.
- Do not use the CapCut desktop app, browser automation or Computer Use to edit drafts.
