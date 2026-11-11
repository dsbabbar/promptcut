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
   | `add_text` | `content`, `start_ms`, `duration_ms`, optional `position_x`, `position_y` (-1 to 1), `font_size`, `font_color`, `font` | A title or label on its own layer |
   | `add_captions` | `cues: [{start_ms, end_ms, text}]`, optional `position_y`, `font_size`, `font`, `layer` | All cues on layer 1, the lowest text track (or the next layer up if captions there already overlap in time), near the bottom by default. Use the `capcut-captions` skill to get cues. |
   | `add_audio` | `source`, optional `start_ms`, `duration_ms` (default: to the end), `volume`, `fade_in_ms`, `fade_out_ms`, `loop` | Music or sound effect. `source` is the `stdraft_uri` from `capcut-materials` exactly as returned (usually `sid://...`, sometimes `vimo://...`), or an uploaded audio `vid` written as `vid://<vid>`. |
   | `add_video` | `source` (`vid://<vid>`), `source_end_ms`, optional `source_start_ms`, `start_ms`, `volume` | Appends to the end of the main track unless `start_ms` is given |
   | `add_image` | `source` (an uploaded image's `uri`, written as `tos://<uri>`), `duration_ms`, optional `start_ms` | A still image on the main track, such as a slide or photo. Appends to the end of the main track unless `start_ms` is given. |
   | `update` | `id`, then any of `content`, `volume`, `font_size`, `font_color`, `font`, `fade_in_ms`, `fade_out_ms` | Changes a segment in place. Never add a new segment and call it an update. |
   | `place` | `id`, then any of `start_ms`, `duration_ms`, `position_x`, `position_y`, `layer` | Moves, trims or repositions a segment |
   | `remove` | `id` | Deletes a segment. Gaps it leaves are not closed. |
   | `reset_caption_layers` | optional `layer` (default 1) | Puts all captions back on the lowest layers, one layer when they don't overlap in time. |

   **Always set `font` on text you add or restyle.** Without one, the CapCut web editor and desktop app each substitute their own default font, so the same text can wrap differently. `font` takes a font's `vimo://<id>` `stdraft_uri` from `capcut-materials`. Unless the user named a font, search fonts once per conversation (`search_capcut_material` with `type: "font"`, `top_n: 20`), pick a clean, legible sans-serif from the descriptions, tell the user which one you chose, and reuse it for all new text.

   **Keep captions on as few tracks as possible.** CapCut's read-back spreads captions over extra layers, and saving those layers as they are adds a track each time. Whenever the draft has captions, end every operation list with `{"op": "reset_caption_layers"}`, including saves that only change something else. Even so, CapCut usually shows the first caption on a track of its own and the rest together on a second track. Tell the user they can drag the first caption onto the shared track in the editor if they want one track.

2. **Apply locally:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/stdraft.mjs" apply --in <tmp>/draft.json --ops <tmp>/ops.json --out <tmp>/draft-new.json`. On an error, fix the operations and run again. Nothing is written until every operation succeeds and the result validates. Run `summary` on the result and check it matches the request.
3. **Check the version, right before saving:** call `check_stdraft_state` with the `session_id` and your current `package_id` (empty for a new draft). This also shows an "editing" overlay in the web editor for up to 20 minutes, so only call it when you are about to save. If `stale` is true, the user changed the draft in the browser: call `get_stdraft_snapshot`, apply the same operations to that newer document, and tell the user you built on their latest changes.
4. **Save:** call `push_stdraft_snapshot` with `session_id`, `base_package_id` (the version you edited, or empty for a new draft) and `stdraft_json` (the new document as a string).
5. **After a successful save:** keep the returned `server_package_id` as the new version. If `stdraft_json` is returned, save it as the new baseline document, otherwise call `get_stdraft_snapshot`. Tell the user what changed, in plain words, and give them `web_editor_url` with its `web_editor_text` label so they can review and export in the CapCut web editor. Saving a draft does not export a new video file.

   After the first save of a new draft, also tell the user that the draft appears as "Untitled" in their CapCut apps, because CapCut's draft tools can't set a name, and that they can rename it in any CapCut app. Say this once per draft.

## Save errors

| Error | Action |
| --- | --- |
| `STDRAFT_INVALID` | Nothing was saved. Read the validation details, fix the operations or document, and try once more. If it fails again, report the details to the user. |
| `STDRAFT_VERSION_CONFLICT` | Nothing was saved, because the draft changed in the browser. Get the latest snapshot, re-apply the operations, check the summary, then save again with the new `package_id`. |
| `save cloud draft failed` with `ret=2005` | The draft was deleted in CapCut, so this session can't save to it. Tell the user, call `start_stdraft_session` for a new draft, and save the current document with an empty `base_package_id`. |
| Unsure whether a save went through | Call `check_stdraft_state` or `get_stdraft_snapshot` first. Never repeat a save blindly. |
| Login error (for example `check login error` or `get user workspace failed`) | Stop and follow the `capcut-connect` skill. Do not retry or try other tools first. |

## Limits of this version

- Supported: text, captions, music and sound effects, main-track video clips and still images, volume and fades, moving, trimming and removing segments.
- Not yet supported: filters, transitions, video effects, text effects, text templates, picture-in-picture and stickers. If asked for these, say so, and offer to find the material with `capcut-materials` so the user can apply it in the web editor.
- CapCut converts drafts between its cloud format and STDraft, so a document read back can differ slightly from the one saved. Always continue from the read-back version.
- Do not use the CapCut desktop app, browser automation or Computer Use to edit drafts.
