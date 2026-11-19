---
name: capcut-templates
description: Search CapCut video templates and editing inspiration. Use when the user wants CapCut templates, video ideas, hooks, story structures, pacing, transitions, visual styles or trends, including searches based on a reference image or video.
---

# Search CapCut templates

Template search is asynchronous: submit, poll until finished, then show the results.

## 1. Build the query

Write a `query` that stands on its own: subject, goal, platform, aspect ratio, mood, pacing and music feel, in the user's language. Include only details the user gave or that you saw in their reference media. Do not invent constraints.

Use `count` from the user, or 10 (the maximum).

### Reference media (optional, up to 16 assets)

- **Image:** needs a public `http(s)` URL. Pass `{"asset_type": "image", "url": ...}`.
- **Video:** needs a CapCut VOD `vid`. Pass `{"asset_type": "video", "vid": ...}`.
- Add `width`, `height`, `duration_ms` or `aspect_ratio` only when known.
- A local file must be uploaded first with the `capcut-upload` skill. For uploaded images, convert each ImageX URI to a public URL with `capcut_batch_media_url` (`uris`), and pass the URL, never the URI.
- Never pass audio, local paths or ImageX URIs to template search.

The server may ignore assets where multimodal search is unavailable, so never claim results were visually matched.

## 2. Submit and poll

1. Call `capcut_template_search` with `query`, `count` and any `assets`. Keep the returned `search_id`.
2. Call `capcut_template_search_poll_v2` with that `search_id`. While `status` is `running`, wait at least `next_poll_after_ms` and poll again with the same `search_id`. Do not resubmit and do not treat `total` as final until `status` is `succeeded` or `failed`.
3. On `failed`, report the error. Do not resubmit unless the user asks.

## 3. Show results

When `status` is `succeeded` and `total` is above 0:

1. Call `capcut_template_search_poll` with the same `search_id` to get the full template records. Do not call `templates_preview` or `templates_preview_v2` (on `capcut`): Claude Code doesn't render their cards, so the user would only see raw data.
2. Present the templates as a numbered list: title, a one-line description of the style or structure, duration or ratio when given, and the template link. Then summarize the useful creative directions in two or three sentences.

The list in your reply is the only place the user sees the templates. Never say cards, a gallery or previews are shown in the chat.

Only show links whose origin is `https://www.capcut.com`. Remove tracking parameters whose names start with `utm_` (such as `utm_source=codex`) and keep the rest of the link, for example `https://www.capcut.com/template-detail/<id>`. Never show raw responses, signatures, headers or tokens.

When `succeeded` returns `total` of 0, retry once with a shorter query that keeps the core goal. If that is also empty, say no templates matched and suggest one or two refinements.

## Errors

| Error | Action |
| --- | --- |
| `query_required` | Retry once with a self-contained query and no assets. If the user explicitly wanted an assets-only search, explain that text is required here. |
| `template_search_busy` | The account has 5 searches running. Keep polling existing `search_id`s, or wait briefly and submit once more. |
| Preview says the result expired | Search results are kept for 15 days. Offer a new search. |
| Login error (for example `check login error`) or missing tools | Stop and follow the `capcut-connect` skill. Do not retry or try other tools first. |

## Opening a template

Give the user the template link to open in their browser. Do not launch the CapCut desktop app or browse the CapCut website to search for templates.
