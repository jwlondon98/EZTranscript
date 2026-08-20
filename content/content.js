/*
 * EZTranscript — content script
 *
 * Runs on YouTube watch / shorts pages. Listens for messages from the popup
 * (and future commands) and is responsible for:
 *
 *   1. Opening the transcript panel (clicking "Show transcript" if it is
 *      not already open).
 *   2. Scrolling the panel so every segment is loaded (YouTube lazy-loads
 *      transcript lines as you scroll).
 *   3. Extracting the assembled transcript text and returning it.
 *
 * The clipboard write itself is performed in the popup so it runs under a
 * genuine user gesture (the popup button click).
 */

(() => {
  'use strict';

  // Only run on YouTube watch / shorts pages.
  if (!window.location.pathname.startsWith('/watch') &&
      !window.location.pathname.startsWith('/shorts')) {
    return;
  }

  /* ------------------------------------------------------------------ */
  /*  Small async helpers                                               */
  /* ------------------------------------------------------------------ */

  /** Resolve when a matching element appears (or reject after `ms`). */
  function waitForSelector(selector, ms = 8000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() - start >= ms) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for "${selector}"`));
        }
      }, 100);
    });
  }

  /** Resolve with true as soon as `predicate()` returns truthy. */
  function waitFor(predicate, ms = 8000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start >= ms) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  }

  /** Tiny promise-friendly sleep. */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /* ------------------------------------------------------------------ */
  /*  Transcript panel detection & opening                              */
  /* ------------------------------------------------------------------ */

  /** True when the right-hand transcript panel is present in the DOM. */
  function transcriptPanelEl() {
    return (
      document.querySelector('ytd-transcript-renderer') ||
      document.querySelector('ytd-transcript-renderer, ytd-transcript') ||
      document.querySelector('ytd-transcript-search-box')
    );
  }

  function isTranscriptOpen() {
    return !!transcriptPanelEl();
  }

  /**
   * Find the "Show transcript" trigger.
   *
   * YouTube exposes this entry point in (at least) two places:
   *   - a stand-alone button sometimes shown near the description, and
   *   - the three-dot "overflow" menu under the video player.
   *
   * We scan for any button / menu item whose text or aria-label contains
   * "transcript" (but not "hide").
   */
  function findShowTranscriptButton() {
    const roots = [
      document,
      document.querySelector('ytd-watch-metadata'),   // the metadata row
      document.querySelector('#menu-container'),       // overflow menu host
      document.querySelector('tp-yt-app-drawer'),
    ].filter(Boolean);

    const selector = [
      'button',
      'tp-yt-button-renderer',
      'ytd-button-renderer',
      'ytd-menu-entry-renderer a',
      'a.yt-formatted-link-behavior',
      'a',
    ].join(', ');

    for (const root of roots) {
      const candidates = root.querySelectorAll(selector);
      for (const el of candidates) {
        const label = (
          (el.getAttribute('aria-label') || '') +
          ' ' +
          (el.textContent || '') +
          ' ' +
          (el.title || '')
        ).toLowerCase();

        if (!label.includes('transcript')) continue;

        // Skip the "Hide transcript" toggle that appears once it's open.
        if (label.includes('hide transcript')) continue;

        // The overflow menu label reads "Open transcript" in some locales
        // but "Show transcript" in others; accept anything that's not "hide".
        return el;
      }
    }
    return null;
  }

  /**
   * Ensure the transcript panel is open. Returns true on success.
   */
  async function ensureTranscriptOpen() {
    // Already open — nothing to do.
    if (isTranscriptOpen()) return true;

    const btn = findShowTranscriptButton();
    if (!btn) {
      throw new Error(
        'Could not locate the "Show transcript" button on this page.'
      );
    }

    btn.click();

    // Wait for the panel to materialise.
    try {
      await waitForSelector('ytd-transcript-renderer, ytd-transcript', 6000);
    } catch {
      // The click may have targeted a menu entry that lives inside a
      // separate overlay; give the DOM a moment and re-check.
      await waitFor(() => isTranscriptOpen(), 4000);
    }

    return isTranscriptOpen();
  }

  /* ------------------------------------------------------------------ */
  /*  Lazy-load every segment                                           */
  /* ------------------------------------------------------------------ */

  /**
   * YouTube only renders the transcript segments that are currently
   * visible inside the (scrollable) panel. We repeatedly scroll to the
   * bottom until the segment count stops growing, which loads the whole
   * transcript.
   */
  async function loadAllSegments() {
    await waitFor(() => transcriptPanelEl(), 4000);

    const panel = transcriptPanelEl();

    // The scrollable container is usually the first scrollable ancestor
    // of the segment list, but we try a few candidate selectors.
    let scrollEl = null;
    for (const sel of [
      'ytd-transcript-renderer ytd-transcript-segment-list-renderer',
      'ytd-transcript-renderer #segments-container',
      'ytd-transcript-renderer .scrollable',
    ]) {
      const c = panel.querySelector(sel);
      if (c && c.parentElement) {
        // Find the actually-scrollable parent.
        let p = c;
        while (p && p !== document.body) {
          const ov = getComputedStyle(p).overflowY;
          if (ov === 'auto' || ov === 'scroll') {
            scrollEl = p;
            break;
          }
          p = p.parentElement;
        }
        if (scrollEl) break;
      }
    }

    if (!scrollEl) {
      // Fall back to the panel itself.
      scrollEl = panel;
    }

    const countSegments = () =>
      panel.querySelectorAll('ytd-transcript-segment-renderer').length;

    let last = 0;
    // Scroll a few times to be sure we've pulled everything in.
    for (let i = 0; i < 25; i++) {
      last = countSegments();
      try {
        scrollEl.scrollTo(0, scrollEl.scrollHeight);
      } catch { /* ignore */ }
      await sleep(350);
      const now = countSegments();
      if (now === last) {
        // No growth after a couple of attempts — we're done.
        await sleep(200);
        if (countSegments() === now) break;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Text extraction                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Pull the human-readable text out of every segment renderer.
   *
   * Each segment typically renders as:
   *   <ytd-transcript-segment-renderer>
   *     <span class="...timestamp...">0:12</span>
   *     <span class="...text...">Hello world</span>
   *   </ytd-transcript-segment-renderer>
   *
   * Because YouTube mutates class names often, we grab every non-empty
   * text node and strip leading timestamps.
   */
  function extractText() {
    const panel = transcriptPanelEl();
    if (!panel) return '';

    const segments = panel.querySelectorAll(
      'ytd-transcript-segment-renderer, ytd-transcript-segment-renderer'
    );

    const lines = [];

    // If the structured segment renderers exist, prefer them.
    if (segments.length) {
      segments.forEach((seg) => {
        const raw = seg.textContent || '';
        const cleaned = cleanSegment(raw);
        if (cleaned) lines.push(cleaned);
      });
    } else {
      // Fallback: grab the panel's own text, splitting on newlines.
      const raw = panel.textContent || '';
      raw.split('\n').forEach((l) => {
        const c = cleanSegment(l);
        if (c) lines.push(c);
      });
    }

    return lines.join('\n');
  }

  /** Remove a leading timestamp (e.g. "0:12", "1:23:45") and tidy spacing. */
  function cleanSegment(text) {
    let t = text.trim();
    if (!t) return '';

    // Drop a leading timestamp such as 9:30 or 1:23:45
    t = t.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '').trim();

    // Collapse any stray double spaces that the split may have created.
    t = t.replace(/\s+/g, ' ');

    return t;
  }

  /* ------------------------------------------------------------------ */
  /*  Main entry point                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * @returns {Promise<{success:boolean, transcript?:string, error?:string}>}
   */
  async function extractFullTranscript() {
    if (!window.location.pathname.startsWith('/watch')) {
      return {
        success: false,
        error: 'This only works on YouTube watch pages.',
      };
    }

    const opened = await ensureTranscriptOpen();
    if (!opened) {
      return {
        success: false,
        error:
          'Could not open the transcript panel. Make sure the video has ' +
          'a transcript available, then try again.',
      };
    }

    // Give the first batch of segments a moment, then load the rest.
    await waitFor(
      () =>
        transcriptPanelEl() &&
        transcriptPanelEl().querySelector('ytd-transcript-segment-renderer'),
      5000
    );

    await loadAllSegments();

    const transcript = extractText();

    if (!transcript) {
      return {
        success: false,
        error: 'Transcript panel opened but no text could be read.',
      };
    }

    return { success: true, transcript };
  }

  /* ------------------------------------------------------------------ */
  /*  Message listener                                                  */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'EZTRANSCRIPT_EXTRACT') {
      extractFullTranscript()
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      // Returning true keeps the message channel open for async sendResponse.
      return true;
    }
    return false;
  });
})();
