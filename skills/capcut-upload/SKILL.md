---
name: capcut-upload
description: Upload local video, audio and image files to CapCut so other CapCut workflows can use them. Use when a CapCut request involves files on the user's computer, such as references for generation, footage for captions or rough cuts, or images for template search.
---

# Upload media to CapCut

Before running any `${CLAUDE_PLUGIN_ROOT}/scripts/` command or ffmpeg, make sure the `capcut-connect` skill's setup check has passed in this conversation.

Uploads return a `vid` for each video or audio file and an ImageX `uri` for each image. Other CapCut skills use these IDs. Upload every file for a request in one batch.

Supported: videos up to 1 GiB (mp4, mov, m4v, mkv, webm, avi, mpeg, mpg, 3gp, ts, mts, m2ts, flv), audio up to 1 GiB (mp3, wav, m4a, aac, flac, ogg, opus, wma, aiff), images up to 20 MiB (jpg, jpeg, png, webp, gif, bmp, tif, tiff, heic, heif, avif). Each file name in a batch must be unique.

## Workflow

Use the file paths the user gives. If a file was named without a full path and is not in the current folder, ask the user where it is. Never search whole drives or the user's home folder for it.

1. **Describe the batch.** Run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/capcut-upload.mjs" describe <file1> <file2> ...`
   It prints `{"files": [...]}` with each file's name and size, or an error for unsupported, empty or oversized files. Report errors and continue with the valid files only if the user agrees.
2. **Request a ticket.** Call `capcut_asset_upload_credential` with `version: 2` and `files` set to exactly the printed list. It returns an `upload_ticket` that is valid for about 15 minutes and only for that list.
3. **Upload right away.** Pipe the ticket on stdin, passing the same files in the same order:
   `printf '%s' '<upload_ticket>' | node "${CLAUDE_PLUGIN_ROOT}/scripts/capcut-upload.mjs" upload <file1> <file2> ...`
   Never put the ticket in command arguments, files or replies. Large videos can take several minutes. Progress lines go to stderr.
4. **Read the results.** The script prints `{"success": ..., "results": [...]}` with one entry per file:
   - video or audio: `vid`, and `public: true` once CapCut has finalized it
   - image: `uri`
   - failure: `success: false` and an `error`

Keep every returned `vid` and `uri` in the conversation, with its file name, for later steps. Never upload a file again once it has a `vid` or `uri`.

## After uploading

- **Template search** needs public image URLs: call `capcut_batch_media_url` with `uris` (up to 20) and use the returned URLs.
- **Generation references** use image `uri`s and video or audio `vid`s directly.
- **Captions and rough cuts** use `vid`s (and image `uri`s for rough cuts).

For a standalone upload request, report each file's result briefly. Do not print the IDs unless the user asks.

## Errors

| Error | Action |
| --- | --- |
| Tool call blocked by Claude Code's permission check | Explain that `capcut_asset_upload_credential` issues short-lived upload credentials, so Claude Code asks first. The user can approve it once, or allow it permanently with `/permissions`. |
| `upload ticket is invalid or expired`, or HTTP 401 or 403 from the upload storage step | The ticket or its short-lived storage key expired. Request a new ticket (step 2) and upload again at once. This is not a sign-in problem, so do not ask the user to reconnect. |
| `files do not match the ticket` | Run `describe` again and request a new ticket with its exact output. |
| `public: false` with a `vid` | The upload worked but finalizing did not. Keep the `vid`. Do not upload again. |
| `Untrusted upload host` | Stop and report it. Do not work around it. |
| Login error (for example `check login error`) | Stop and follow the `capcut-connect` skill. Do not retry or try other tools first. |

Never upload through the CapCut website, the desktop app or browser automation instead.
