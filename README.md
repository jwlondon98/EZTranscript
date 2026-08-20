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
   the panel until every line is loaded, then copies the assembled text.
5. Paste (`Ctrl/⌘+V`) into any text editor, notes app, AI tool, etc.

The transcript includes timestamps from each segment line.

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
│                          #   clipboard write
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
  1. Locates and clicks the *"Show transcript"* button (handles both the
     standalone button and the overflow- menu variant).
  2. Waits for the `ytd-transcript-renderer` panel to appear.
  3. Scrolls the panel to the bottom repeatedly until no new segments load.
  4. Reads every `ytd-transcript-segment-renderer`, strips leading
     timestamps, and returns the full text.
- **`popup/popup.js`** sends the extraction message, receives the text, and
  writes it to the clipboard via `navigator.clipboard.writeText()` (falling
  back to `document.execCommand('copy')`). The clipboard write happens in the
  popup under the button-click gesture, which Chrome requires.

## Notes / limitations

- The video **must have a transcript** available (most do; auto-generated
  transcripts work too).
- YouTube occasionally updates its DOM class names. If copying stops working,
  refresh the page and try again. The content script uses resilient
  text-based lookups for the trigger button and multiple extraction paths.
- Works on standard watch pages. Shorts support is included but YouTube's
  transcript UI on Shorts is limited.

## License

MIT
