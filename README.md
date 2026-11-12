# promptcut

**Unofficial CapCut plugin for Claude Code.** Turn ideas into polished videos by asking Claude to search CapCut templates, generate images and videos, add captions and music, and rough-cut your footage, all from a Claude Code session.

> **Not affiliated with CapCut or ByteDance.** promptcut is an independent, community-built project. It is an unofficial alternative to the official "CapCut x Codex" plugin for OpenAI Codex. CapCut is a trademark of its respective owner and is used here only to describe what this plugin connects to.

## How it works

promptcut is a **Claude Code plugin**: one installable package. CapCut runs a hosted [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for AI assistants, and promptcut connects Claude Code to it. promptcut does not include an MCP server of its own. The plugin adds:

- **9 skills:** instructions that teach Claude the right CapCut workflows and rules
- **5 scripts:** local helpers for uploads, draft editing, subtitle files, saving results and slide decks
- **1 hook:** a setup check that runs when a chat starts

See [What's inside promptcut](docs/whats-inside.md) for how the pieces fit together.

```
Claude Code ── promptcut plugin ──┬── capcut        (your CapCut account, OAuth login)
                                  └── capcut-cards  (result cards, no login)
```

All AI generation, search and editing run on CapCut's servers under **your own CapCut account**. promptcut does not run its own backend and never sees your password.

## Requirements

- [Claude Code](https://code.claude.com) 2.1.292 or later, running on your own computer (the CapCut login sends you back to a local address, so cloud and browser-only sessions cannot complete it)
- A CapCut account. Your account region must match your internet connection's region (a US connection needs a US-registered account).
- [Node.js](https://nodejs.org) 20 or later for uploads, draft editing, subtitle export and saving results (Windows: `winget install OpenJS.NodeJS.LTS`, macOS: `brew install node`)
- Optional: [ffmpeg](https://ffmpeg.org), for portrait phone videos and mixed-language captions (Windows: `winget install Gyan.FFmpeg`, macOS: `brew install ffmpeg`)
- Optional: Google Chrome, Microsoft Edge, Chromium or Brave, for checking slide decks and exporting them to PDF, PNG or PowerPoint

promptcut's scripts have no other dependencies. Plugins can't install software, so when a chat starts promptcut checks for Node.js and ffmpeg. If something is missing, Claude tells you and offers to install it for you (with your approval) or to show you the steps. To stop reminders about the optional ffmpeg, set the environment variable `PROMPTCUT_SKIP_FFMPEG_CHECK=1`.

## Install

**Quickest way, if you have Claude Code for the terminal: ask Claude to install it.** In a local Claude Code session, paste:

```
Install the promptcut plugin by running: claude plugin install promptcut --marketplace dsbabbar/promptcut
```

Approve the command when Claude asks. Then start a new session and sign in to CapCut (step 2 below). This needs the `claude` command, which comes with [Claude Code for the terminal](https://code.claude.com). The Claude desktop app doesn't add it, so with only the desktop app, Claude reports `command not found: claude`. Use the desktop app steps in step 1 instead.

1. **Install the plugin.** Pick whichever app you use. Both put promptcut in the same place on your computer (`~/.claude/`), so one install covers the terminal and the desktop app.

   **Claude desktop app (Windows or Mac):**
   1. Type `/plugin` in a Code session, or open **Settings → Plugins**.
   2. Click **+ Add → Add marketplace → Add from a repository**, enter `dsbabbar/promptcut`, and click **Sync**.
   3. On the **Discover** tab, find **Promptcut**, open the arrow next to **Add**, and choose **Install for me**.

   **Terminal** (PowerShell or Command Prompt on Windows, Terminal on macOS):

   ```
   claude plugin install promptcut --marketplace dsbabbar/promptcut
   ```

   If your terminal doesn't recognize `claude`, [install Claude Code](https://code.claude.com) first. Already in a Claude Code session in the terminal? Type `/plugin install promptcut --marketplace dsbabbar/promptcut` instead, confirm adding the marketplace if asked, and choose **Install for you (user scope)**. "Components will be discovered at installation" is normal. If asked, run `/reload-plugins`.
2. **Sign in to CapCut** once. The sign-in is shared by both apps.
   - **Claude desktop app:** type `/mcp` in a Code session (or open **Settings → Connectors**) and search for **promptcut**, not "capcut". Open **Promptcut**, go to its **Connectors** tab, click **capcut** and connect it. Approve opening www.capcut.com, sign in in your browser, then click **Done**. Then add **capcut-cards**, which needs no sign-in.
   - **Terminal:** in a `claude` session, type `/mcp`, select **capcut** (it may show as `plugin:promptcut:capcut`), and choose **Authenticate**. Sign in to CapCut in the browser window that opens.
3. **Start a new session** and ask for what you want:
   - **Terminal:** run `claude` in the folder where you'll work.
   - **Claude desktop app:** go to **Code**, and in the environment picker choose **Local → This computer**. Don't choose a **Cloud** environment: CapCut's login can't finish there.

Choose **Install for me** (or user scope) rather than a project option, so promptcut works in every folder.

Always use promptcut in a local session. Cloud sessions and the claude.ai website can't connect to CapCut.

Uploading local files uses CapCut's `capcut_asset_upload_credential` tool, which issues short-lived upload credentials. Claude Code asks before running it. Approve it when asked, or allow it permanently with `/permissions`.

If you previously added CapCut's servers by hand, remove them so each tool is listed once: `claude mcp remove capcut` and `claude mcp remove capcut-cards`.

Questions? See the [FAQ](docs/faq.md) and [Known issues](docs/known-issues.md). Not sure whether promptcut or editing CapCut's local project files fits your project better? See [Choosing a workflow](docs/choosing-a-workflow.md).

## What you can ask for

| Feature | Example prompt | Status |
| --- | --- | --- |
| Template search | "Find fast-paced 9:16 product launch templates" | Available |
| Image generation | "Generate four poster concepts for a summer sale" | Available |
| Video generation | "Make a 5-second clip of waves at sunset" | Available |
| Material search | "Find upbeat background music and a bold title font" | Available |
| Auto captions | "Add English captions to this video and give me an SRT" | Available |
| AI rough cut | "Cut these clips into a 30-second highlight reel" | Available |
| Local uploads | "Use ./footage/intro.mp4 as the reference" | Available |
| Draft editing | "Add the music and captions to my draft" | Available (drafts sync to every CapCut app signed in to your account) |
| Speed and speed ramps | "Play the hallway clip at 2x and give the stair climb the Hero curve" | New (constant speed and ramps on video clips; ramps not yet checked in a real draft) |
| Slide decks | "Make a 10-slide pitch deck from these notes and export a PDF" | New: HTML decks with presenter view; PDF, PNG and PowerPoint export |
| Slideshow video | "Turn this deck into a video with calm music" | New: builds a CapCut draft with one image per slide |

**CapCut Credits:** some features spend CapCut credits. promptcut always shows the quoted cost and waits for your approval before any paid generation.

**Saving results:** result links are temporary. Ask Claude to save generated images and videos, and they are downloaded to a `capcut-output` folder in your current directory. CapCut may add an "AI" watermark to generated media.

## Use it from your phone

promptcut runs in Claude Code on your computer, but you can drive that session from the Claude mobile app with Remote Control. First install promptcut and sign in to CapCut on the computer, then start Remote Control in whichever app you use there:

| On your computer | How to start Remote Control |
| --- | --- |
| Claude desktop app (Windows or Mac) | In a local Claude Code session, type `/rc` |
| Claude Code in a terminal (Windows, Mac or Linux) | In a running session, type `/rc`, or start a new one with `claude remote-control` in your working folder |

Then, on your phone, open the Claude app, go to **Code**, and pick that session.

Everything you ask from the phone runs on the computer. Keep in mind:

- The computer must stay on and awake, with the session running.
- Media must be on the computer. Sync new phone clips there first (for example with a cloud photo or drive app), then give Claude the computer's file path.
- Sign in to CapCut on the computer. The login cannot be completed from the phone.
- Result links open on the phone. Files you ask Claude to save land on the computer.

A regular claude.ai chat or a cloud session cannot use promptcut, because CapCut's login only accepts a local callback address.

## Known limitations

These are things promptcut doesn't do yet. For problems on CapCut's side, such as drafts losing their names, duplicate copies from the desktop app and captions on two tracks, see [Known issues](docs/known-issues.md).

- **Claude Code only.** CapCut's login accepts local callback addresses only, so the claude.ai website and cloud sessions cannot connect. CapCut's interactive cards are not shown; promptcut asks questions and shows results in the chat instead.
- **Draft editing** covers text, captions, music, sound effects, main-track video clips and still images, plus constant speed and speed ramps on video clips (speed ramps are new and not yet checked in a real draft). Filters, transitions, effects, text templates, stickers and picture-in-picture must be added in the CapCut web editor for now.
- **Captions for mixed-language videos** may miss short phrases in the second language. promptcut never fills gaps with its own translation; it tells you which parts have no captions.
- **Fonts:** promptcut sets a CapCut library font on text it adds, so it looks the same in the web editor and the desktop app. Text without a font, or with a local font saved by the desktop app, can wrap differently between the two.
- **AI rough cuts** may use subscription credits and do not show a quote before starting.
- **Slide decks:** PowerPoint exports show each slide as a picture, so the text can't be edited in PowerPoint (speaker notes are included). Decks use Google Fonts, which need an internet connection unless the fonts are installed.
- **Upload permission:** Claude Code asks before running CapCut's upload-credential tool, because it issues short-lived upload keys.

## Development

This section is for people who want to change promptcut or contribute to it. You don't need it to use the plugin.

### Get the code and run the checks

You need Git, Node.js 20 or later and Claude Code.

```
git clone https://github.com/dsbabbar/promptcut
cd promptcut
npm test                     # runs the unit tests; no npm install needed
claude plugin validate .     # checks the plugin and marketplace files
```

### Try your changes in Claude Code

Start Claude Code with your local copy loaded as the plugin:

```
claude --plugin-dir /path/to/promptcut
```

Then sign in with `/mcp` and try requests as a user would. If you also installed promptcut from the marketplace, uninstall it first (`claude plugin uninstall promptcut@promptcut`) so the skills and CapCut tools aren't loaded twice. Start a new session after editing a skill so Claude reads the new version.

### Project layout

| Path | Contents |
| --- | --- |
| `.claude-plugin/` | Plugin and marketplace manifests, and the icon |
| `.mcp.json` | Addresses of CapCut's two MCP servers |
| `skills/<name>/SKILL.md` | One folder per skill. The `description` line decides when Claude uses it, and the body holds the workflow and rules. |
| `scripts/` | Node.js helpers (upload, draft editing, subtitles, downloads). Built-in modules only, no npm dependencies. |
| `hooks/` | The session-start setup check |
| `tests/` | Unit tests for the scripts and the hook, run with `npm test` |
| `docs/` | The guides linked from this README |
| `assets/` | Source for the icon |

See [What's inside promptcut](docs/whats-inside.md) for how these pieces work together.

### Guidelines for changes

- **Keep it original.** Don't copy files, text or code from the official CapCut Codex plugin, whose bundle is proprietary.
- **Use synthetic test data only.** Never commit real CapCut responses, drafts, media, tokens or personal paths.
- **Keep scripts dependency-free.** Use Node.js built-in modules so users never need `npm install`.
- **Never let a skill spend credits silently.** Paid actions must show CapCut's quote and wait for the user's approval.
- **Test against a real CapCut account before marking a feature Available.** Automated tests can't reach CapCut.

### Continuous integration

Every pull request runs `npm test` on Windows, macOS and Linux with Node.js 20 and 22 (see `.github/workflows/test.yml`). Open a pull request against `main`, describe what you tested with a real CapCut account, and keep it green.

## Acknowledgements

The uploader is an independent implementation. Volcengine's open-source [Node.js SDK](https://github.com/volcengine/volc-sdk-nodejs) (Apache-2.0) served as a reference for the VOD and ImageX upload protocols.

## Privacy and terms

Your prompts, media and account data are sent to CapCut and handled under CapCut's [Privacy Policy](https://www.capcut.com/clause/privacy) and [Terms of Service](https://www.capcut.com/clause/terms-of-service). You are responsible for following those terms. promptcut itself collects no data.

## License

[MIT](LICENSE). This license covers the code in this repository only, not CapCut's service.
