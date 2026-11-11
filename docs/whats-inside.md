# What's inside promptcut

promptcut is a **Claude Code plugin**. A plugin is a package that bundles several kinds of pieces so you can install them with one command. promptcut contains skills, scripts and a hook written for this project, plus the address of an MCP server that **CapCut runs**. promptcut does not include or run an MCP server of its own.

## The pieces

| Piece | What it is | Who made it | Where it lives |
| --- | --- | --- | --- |
| **Plugin** | The installable package that holds everything below | promptcut | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` |
| **MCP servers** | Services that give Claude tools to call, such as "generate an image" or "search templates", running under your CapCut account | **CapCut**, on CapCut's servers | Only their addresses, in `.mcp.json` |
| **Skills** | Written instructions that teach Claude how to use those tools well, for example to quote credits before spending them or never to invent captions | promptcut (9 skills) | `skills/` |
| **Scripts** | Small Node.js programs for jobs CapCut's tools can't do alone: uploading files, editing drafts, writing subtitle files, saving results and building slide decks | promptcut (5 scripts) | `scripts/` |
| **Hook** | A command Claude Code runs automatically when a chat starts, to check that Node.js and ffmpeg are installed | promptcut | `hooks/` |

An analogy: CapCut's MCP server is the **kitchen**, the skills are the **recipes**, the scripts are **extra kitchen tools**, and the plugin is the **box** that delivers them all.

## How the pieces work together

```
You: "Add captions to clip.mp4"
 │
 ▼
Claude Code
 ├── skill: capcut-captions        tells Claude the steps and the rules
 ├── skill: capcut-upload          tells Claude how to upload the file
 │     └── script: capcut-upload.mjs        sends the file to CapCut
 ├── MCP tool (CapCut): auto_caption_submit / auto_caption_query
 └── script: captions-to-subtitles.mjs      writes the .srt file on your computer
```

1. You ask in plain words. Claude picks the skill whose description matches the request.
2. The skill explains which CapCut tools to call, in what order, and what to avoid.
3. Claude calls tools on **CapCut's MCP server** for the AI work: recognition, generation, search, rough cuts and drafts.
4. When a job needs your computer (reading a file, writing a file, editing a draft document), Claude runs one of promptcut's **scripts**.

## Where things run

CapCut's MCP servers run in the cloud, not on your computer. All AI processing happens there, under your CapCut account.

| On your computer | On CapCut's servers (cloud) |
| --- | --- |
| Claude Code with promptcut's skills, scripts and hook | AI processing: generation, speech recognition, rough cuts, template and material search |
| Your original media, until you ask Claude to upload it | Uploaded copies of your media |
| Draft editing: the script changes the draft document locally, then saves it back | Your cloud drafts, which sync to the CapCut web editor and apps |
| Subtitle files and downloaded results | Generated images and videos |
| Your CapCut login token, stored by Claude Code | Your account, credits and subscription |

The servers are reached at `www.capcut.com` through a global content delivery network. Uploads go to ByteDance's cloud storage, and the region depends on your account. For example, a test account was assigned a Singapore (`sg`) region. CapCut's tool descriptions also mention a separate US region for US accounts.

Anything you upload or generate is stored by CapCut under its [Privacy Policy](https://www.capcut.com/clause/privacy), possibly outside your country. If footage must stay on your computer, see local project mode in [Choosing a workflow](choosing-a-workflow.md).

## The two CapCut servers

| Server | Address | Login | What it provides |
| --- | --- | --- | --- |
| `capcut` | `https://www.capcut.com/api/external_mcp` | Your CapCut account (OAuth) | Search, generation, captions, rough cuts, upload permission, draft sessions |
| `capcut-cards` | `https://www.capcut.com/api/external_mcp/resource` | None | Display helpers such as template galleries |

CapCut built these servers for AI assistants. The official CapCut x Codex plugin connects to the same servers. promptcut uses them from Claude Code with its own skills and scripts.

## The skills

| Skill | Used when you want to |
| --- | --- |
| `capcut-connect` | Sign in, check setup (Node.js, ffmpeg) or fix connection problems |
| `capcut-templates` | Find CapCut templates and editing ideas |
| `capcut-materials` | Find music, sound effects, fonts and effects |
| `capcut-generate` | Generate images or short videos, with credit quotes first |
| `capcut-captions` | Transcribe speech and get captions or SRT/VTT files |
| `capcut-rough-cut` | Have CapCut's AI cut footage into a first edit |
| `capcut-upload` | Send local videos, audio and images to CapCut |
| `capcut-draft` | Add or change text, captions, music, clips and images in a CapCut draft |
| `capcut-slides` | Make, present and export slide decks, and turn a deck into a CapCut slideshow video |

You don't need to name a skill. Describe what you want, and Claude picks the right one.

## The scripts

| Script | What it does |
| --- | --- |
| `scripts/capcut-upload.mjs` | Exchanges CapCut's short-lived upload ticket for upload keys inside the script, uploads files and returns their IDs. The keys are never printed. |
| `scripts/stdraft.mjs` | Creates, summarizes, validates and edits CapCut draft documents (STDraft) on your computer |
| `scripts/captions-to-subtitles.mjs` | Turns caption timings into SRT or WebVTT files |
| `scripts/download-media.mjs` | Saves generated images and videos from expiring links to a local folder |
| `scripts/slides.mjs` | Creates and checks HTML slide decks, exports them to PDF, PNG or PowerPoint with your installed Chrome or Edge, and plans slideshow drafts. Uses `slides-runtime.js` (the viewer built into each deck) and `slides-pptx.mjs` (the PowerPoint writer). |

They use only Node.js's built-in modules, so there is nothing to `npm install`.

## The hook

`hooks/check-setup.sh` runs when a chat starts. It prints nothing when Node.js 20+ and ffmpeg are installed. If something is missing, it adds a short note so Claude tells you and offers to install it (with your approval) or to show you the steps.

## Skills, MCP servers and plugins in general

- An **MCP server** gives an AI assistant **abilities** (tools). It can run on your computer or on a company's servers.
- A **skill** gives an AI assistant **know-how**: when and how to use those abilities, written as instructions. Skills don't run anything by themselves.
- A **plugin** is how Claude Code **packages and installs** skills, MCP server connections, hooks, scripts and commands together.

A plugin can contain any mix of these. promptcut contains everything except its own MCP server, because CapCut already provides one.
