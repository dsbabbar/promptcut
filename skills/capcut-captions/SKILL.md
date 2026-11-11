---
name: capcut-captions
description: Transcribe speech in a video or audio file and produce captions or subtitles with CapCut, including SRT or VTT files. Use for "add captions", "generate subtitles", "transcribe this video" and similar requests. Do not use an AI rough cut for caption-only requests.
---

# Automatic captions with CapCut

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes.

Before running any `${CLAUDE_PLUGIN_ROOT}/scripts/` command or ffmpeg, make sure the `capcut-connect` skill's setup check has passed in this conversation.

Caption-only requests keep the original video unchanged. Never start an AI rough cut to add captions.

## Inputs

Each media item needs either:

- a CapCut video or audio `vid` (from the `capcut-upload` skill or earlier work), or
- a `workspace_id` and `resource_id` pair from CapCut.

Upload local files first with `capcut-upload`. Each item also needs a `language` for the speech, for example `en-US`. Use the language the user gives. If none is given and you cannot tell from context, ask which languages are spoken.

### Videos with more than one language

CapCut transcribes mainly one language per pass, and on a mixed-language video it can lock onto the dominant language even when you request another. Speech in other languages is skipped.

1. First, add one resource per language for the same `vid`, each with its own `language`, in the same batch. Use the same code style for every language, for example `en-US` and `hi-IN`.
2. If a language still comes back missing, or returns the same text as another language, and `ffmpeg` is available: find the speech gaps with `ffmpeg -i <video> -af silencedetect=noise=-35dB:d=0.3 -f null -`, cut the untranscribed part into an audio file (`ffmpeg -ss <start> -to <end> -i <video> -vn -c:a aac <part>.m4a`), upload it with `capcut-upload`, and recognize it with the missing language. Add the cut's start time to every cue it returns before merging.
3. If that is not possible, tell the user which time ranges have speech but no captions.

If the user did not mention languages and the result looks sparse for the video's length, say that other languages may have been skipped and offer to run them.

### Never invent captions

Captions must come from CapCut's recognition. Never fill a missing language with your own translation, guess or paraphrase, and never save one under a language file name. Translate only when the user explicitly asks for a translation, then label it as one in the reply and the file name, for example `<video>.hi.translated.srt`.

## Workflow

1. **Draft session.** Reuse this conversation's `draft_session_id`, or call `start_stdraft_session`.
2. **Choose a batch key.** Create a `unique_key` of letters, digits, `.`, `_` or `-`, at most 64 characters, for example `captions-20261026-1`. Use one key per batch and keep it. Reuse the same key when retrying the same batch so it is not recognized twice.
3. **Submit.** Call `auto_caption_submit` with `draft_session_id`, `unique_key` and `resources`.
4. **Poll.** Call `auto_caption_query` with the `unique_key` until every item is finished. Tell the user progress for long media.
5. **Deliver.**
   - For subtitle files, convert each caption line in the result to a cue `{"start_ms": ..., "end_ms": ..., "text": ...}` (times in milliseconds from the start of the media), write the cues as a JSON array to a temporary file, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/captions-to-subtitles.mjs" --format srt --in <cues.json> --out <name>.srt` (use `--format vtt` for WebVTT). Write one file per media item and language, named like `<video>.<language>.srt`. For a video with several languages, also write a combined `<video>.srt` from all its cues together; the script orders them by time. Tell the user where each file is.
   - To show the text, print the captions with their timestamps.
   - To burn captions into the video, use the `capcut-draft` skill's `add_captions` operation with the same cues. For a video that has no draft yet, that skill explains how to start one.

If some items fail, report each failed item and keep the successful results. A login error (for example `check login error`) means the CapCut sign-in has expired: stop and follow the `capcut-connect` skill. Errors ending in `_unavailable` are temporary problems on CapCut's side: wait about a minute, then retry once with the same `unique_key`. If it fails again, report it and offer to try later. If a membership or purchase prompt is returned, give the user the link and wait.
