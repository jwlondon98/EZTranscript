# EZTranscript

> Copy a YouTube video's **full transcript** to your clipboard in one click.

EZTranscript automatically opens YouTube's *"Show transcript"* panel, loads
every segment (YouTube lazy-loads them as you scroll), and copies the
complete text to your clipboard — no manual expanding or selecting required.

## How it works

1. Open any YouTube watch page.
2. Click the extension icon ₤ to open the popup.
3. Hit **Copy Transcript**.
4. The script finds and clicks YouTube's *"Show transcript"* button, scrolls
   the panel until every line is loaded, then reads the assembled text.
5. The raw text is passed through a **deterministic local cleaner** that:
   - Removes bracketed sound annotations (`[music]`, `[applause]`, `[laughter]`, etc.)
   - Joins YouTube's caption line fragments into full sentences
   - Normalizes whitespace (collapses spaces, fixes punctuation spacing)
   - Creates readable paragraph breaks (3–6 sentences per paragraph)
6. The cleaned transcript is written to your clipboard.
7. Paste (`Ctrl/⌘+V`) into any text editor, notes app, AI tool, etc.

## Installing (development / local)

Because this isn't published to the Chrome Web Store yet, load it as an
**unpacked** extension:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the `EZTranscript/` folder.
5. Pin the new 🗏 EZTranscript icon to your toolbar for quick access.

## Usage

| Action | Result |
|---|---|
| Click the 🗏 icon on a YouTube video | Opens the popup |
| Click **Copy Transcript** | Extracts + copies the full transcript |

The popup shows a status bar with character & word counts after copying.

## Files

```
EZTranscript/
├── manifest.json          # Manifest V3 definition
├── content/
│   └── content.js         # Injects into YouTube pages: opens panel,
│                          #   loads all segments, extracts text
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styling (light/dark aware)
│   └── popup.js           # Popup logic: tab detection, message passing,
│                          #   clipboard write, calls cleanTranscript()
├── lib/
│   └── clean_transcript.js  # Deterministic transcript cleaner (local, no LLM)
├── test/
│   ├── clean_transcript.test.js  # Unit tests for the cleaner
│   └── test_e2e_flow.js          # End-to-end flow simulation tests
├── icons/
│   ├── icon-16.svg
│   ├── icon-32.svg
│   ├── icon-48.svg
│   └── icon-128.svg
└── README.md
```

## How it works (technical)

- **`manifest.json`** declares a Manifest V3 extension with a browser action
  (popup) and a content script scoped to `youtube.com/watch` and
  `youtube.com/shorts`. It requests the `clipboardWrite` permission.
- **`content/content.js`** listens for `EZTRANSCRIPT_EXTRACT` messages. When
  triggered it:
  1. Locates and clicks the *"Show transcript"* button. The search is
     shadow-DOM-aware (modern YouTube nests controls inside shadow roots).
     Multiple strategies are tried in order:
     - **Visible trigger** — a button whose text mentions "transcript" and is
       actually rendered (non-zero size).
     - **Expand description** — if the button isn't visible yet (the video
       description is collapsed), the script finds and clicks the *"Show
       more"* button in the description, then retries.
     - **Hidden trigger** — as a last-ditch attempt, any element whose text
       matches "transcript" is clicked even if it isn't currently visible.
     - **Overflow menu** — the three-dot (⋮) menu below the player is opened
       and the *"Show transcript"* menuitem is clicked.
  2. Waits for the `ytd-transcript-renderer` panel to appear.
  3. Scrolls the panel to the bottom repeatedly until no new segments load
     (YouTube lazy-loads segments only as they enter the viewport).
  4. Reads every `ytd-transcript-segment-renderer`, strips leading
     timestamps, and returns the full text.
- **Fallback (best-effort)** — if the DOM approach fails (e.g. the page
  structure has changed or YouTube blocks programmatic clicks), the script
  tries the YouTube timedtext API by fetching the caption `baseUrl` embedded
  in the page's player-response JSON. This fallback is unreliable and may
  return empty on some sessions, but costs only a couple of seconds.
- **`lib/clean_transcript.js`** — A standalone, deterministic transcript
  parser that runs entirely locally (no LLM, no external API). It is loaded
  into the popup via a `<script>` tag. The cleaning pipeline:
  1. **Annotation removal** — strips bracketed sound/event markers like
     `[music]`, `[applause]`, `[laughter]`, `[crowd]`, etc. (case-insensitive).
     Legitimate bracketed spoken text (e.g. `[Chapter 3]`) is preserved.
  2. **Fragment joining** — YouTube captions split sentences every few words.
     Lines that don't end with sentence punctuation (`.!?…`) are merged with
     the next line.
  3. **Paragraph creation** — explicit breaks (blank lines / annotation-only
     lines in the source) are preserved; implicit breaks are added after
     ~5 sentences or ~700 characters.
  4. **Whitespace normalization** — collapses repeated spaces, removes spaces
     before punctuation, trims leading/trailing whitespace.
  - **Preserves all spoken wording** — no summarization, paraphrasing, or
    grammar correction. Filler words, repetitions, slang, and transcription
    errors are kept verbatim.

- **`popup/popup.js`** sends the extraction message and receives the **raw**
  transcript from the content script. It then calls
  `cleanTranscript(rawTranscript)` before writing to the clipboard. The flow
  is: `extractTranscript()` → `cleanTranscript(rawTranscript)` →
  `copyToClipboard(cleanedTranscript)`. If the cleaner fails to load, the
  popup gracefully falls back to copying the raw transcript.

## Notes / limitations

- The video **must have a transcript** available (most do; auto-generated
  transcripts work too).
- The *"Show transcript"* button must be visible/clickable in YouTube's
  interface. In rare cases YouTube hides it behind an expandable description
  — the content script handles this automatically.
- YouTube occasionally updates its DOM class names. If copying stops working,
  refresh the page and try again. The content script uses resilient
  text-based lookups for the trigger button and multiple extraction paths.
- The cleaner removes bracketed sound annotations (music, applause, etc.) and
  joins caption fragments, but does **not** summarize or correct the spoken
  content. What the speaker said is preserved verbatim — including fillers,
  repetitions, and transcription errors.

## License

MIT
