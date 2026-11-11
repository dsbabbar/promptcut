---
name: capcut-generate
description: Generate images or short videos with CapCut AI models (Seedream, GPT Image, Nano Banana Pro, Seedance) from text or reference media. Use for text-to-image, text-to-video, image-to-video, keyframe or reference-based generation, checking or cancelling a running generation, and showing generated results.
---

# Generate images and videos with CapCut

Before the first CapCut account step in this conversation, check the sign-in with `capcut_get_profile` as the `capcut-connect` skill describes.

Before running any `${CLAUDE_PLUGIN_ROOT}/scripts/` command or ffmpeg, make sure the `capcut-connect` skill's setup check has passed in this conversation.

Generation can spend the user's CapCut credits. **Never approve a charge on the user's behalf.**

## Choose the output

Pick by what the user wants to get, not by what they attached. An image that should move becomes a video. A poster or still frame is an image. If unclear, ask only "image or video?". Handle a request for both as two separate generations, one after the other.

## Settings

Use what the user specified and leave the rest to server defaults. If a requested value is not allowed for the model, say so and suggest the closest valid option instead of silently changing it.

### Images: `capcut_image_generate`

| Field | Values |
| --- | --- |
| `model` (required) | `seedream5pro` (default choice), `gpt_image_2`, `seedream5`, `seedream4.3`, `nano_banana_pro` |
| `count` | 1 to 10, default 4 |
| `ratio` | `adaptive` (fit references), `16:9`, `3:2`, `4:3`, `5:4`, `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `21:9` |
| `resolution` | `1K`, `2K`, `4K` |
| `model_options.quality` | GPT Image 2 only: `low`, `medium`, `high` |
| `reference_assets` | Up to 10 images: `{"role": "reference", "media_type": "image", "uri": <ImageX URI>}` |

### Videos: `capcut_video_generate`

| Field | Values |
| --- | --- |
| `model` (required) | `seedance2` (default choice), `seedance2.5`, `seedance2_fast`, `seedance2_mini`, `seedance1_fast` |
| `count` | 1 to 4, default 1 |
| `duration_ms` | Whole seconds. `seedance1_fast`: 2000 to 12000. `seedance2.5`: 4000 to 30000. Others: 4000 to 15000. Default 5000. |
| `ratio` | `adaptive`, `21:9`, `16:9`, `9:16`, `4:3`, `1:1`, `3:4` |
| `resolution` | `480p`, `720p`, `1080p`, `4K` |
| `reference_assets` | Up to 50. Images use `uri` and may have role `reference`, `first_frame` or `last_frame`. Video and audio use `vid` with role `reference`. |

Every request needs a non-empty `prompt`. If the user gave none, ask for one. Do not invent the creative concept. Keep the user's wording and language. You may tidy it into a clear prompt without changing the idea.

Reference files on disk must be uploaded first with the `capcut-upload` skill. Never pass local paths or public URLs as references.

## Workflow

1. **Draft session.** Generation needs a `draft_session_id`. Reuse the one already used in this conversation. Otherwise call `start_stdraft_session` and keep its `session_id`.
2. **Skip the settings cards.** Do not call `prepare_for_image_generation` or `prepare_for_video_generation`. They show interactive cards that Claude Code cannot display, and their results tell the assistant to wait for a button click that can never happen. The generate tool itself returns the exact credit quote. Never tell the user to click a card or button. Confirm settings in the chat instead.
3. **Submit.** Call the generate tool with `draft_session_id` and `spec`. Omit `confirmed`, `unique_key` and `dont_ask_again` on the first call.
4. **Handle the response.**
   - **Queued** (free or already covered): keep the `task_id` and go to step 5.
   - **`CONFIRMATION_REQUIRED`**: tell the user the exact `credits_amount` from the confirmation details and what will be generated, then **stop and wait for a clear yes**. On yes, call the same tool again with the identical `spec`, `draft_session_id`, the server-issued `unique_key` and `generate_id`, and `confirmed: true`. If the quote changes, ask again. Set `dont_ask_again: true` only if the user explicitly asks to stop being asked, and warn that it applies to all future generations on their account.
   - **Membership or credit purchase needed**: give the user the purchase or benefits link from the response and wait. After they confirm the purchase, retry with the same `generate_id`, `unique_key` and `spec`.
5. **Poll patiently.** Call `capcut_generation_poll` with the `task_id` until the task is finished and billing has settled. Between polls, wait for the delay the response suggests, or at least 10 seconds for images and 20 seconds for videos if it suggests none. Wait by running a short sleep command in the background and polling again when it completes. Never poll several times in a row without waiting. Tell the user the estimated wait once, then only report real changes.
6. **Show results.** Call `generation_result` with the `task_id`. For every result, show a clickable Markdown link with a short descriptive title, plus its size or duration when given. State the actual credits charged and mention any results that failed. If neither `generation_result` nor the final poll includes a URL, say so plainly. Never present a result without its link. Result links are signed and expire, so mention that saving the files keeps them.
7. **Offer to save the files.** Ask whether to save the results to the user's computer. If yes, write the result URLs as a JSON array of `{"url": ..., "name": ...}` items (short descriptive names) to a temporary file, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/download-media.mjs" --out ./capcut-output --in <items.json>`, using another folder if the user names one. Report the saved paths. For images, you can then open a saved file to check that it matches the request.

Generated results are stored in CapCut, not in an editable draft. Only offer to place a generated video into a draft (with the `capcut-draft` skill) when its result includes a `vid`. You may offer further generations, such as a different ratio or turning an image into a video, and always note that each costs credits after a new quote.

Never resubmit a request that already has a `task_id` or `unique_key`. Continue it instead, so the user is not charged twice.

## Cancel

Only when the user asks: call `capcut_generation_cancel` with the `task_id`, then poll once to confirm the final state and any refund.

## Errors

- Validation error: explain the invalid field and the allowed values.
- Login error (for example `check login error`) or missing tools: stop and follow the `capcut-connect` skill. Do not retry or try other tools first.
- Do not fall back to another image or video generator unless the user asks.
