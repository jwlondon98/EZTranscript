/*
 * EZTranscript — content script
 *
 * Runs on YouTube watch / shorts pages. Responds to the popup's
 * "EZTRANSCRIPT_EXTRACT" message and returns the full transcript text.
 *
 * Strategy
 * --------
 *  1. DOM approach (primary — uses YouTube's own "Show transcript"
 *     button, exactly as a user would): locate the button, click it,
 *     open the panel, scroll to lazy-load every segment, and read the
 *     text.  YouTube's own JavaScript handles all data fetching, so
 *     this works regardless of API access restrictions.  The search
 *     descends into shadow-DOM custom elements (tp-yt-button-renderer,
 *     etc.) which is where modern YouTube hides its markup.
 *
 *     The "Show transcript" button may be hidden initially because the
 *     video description is collapsed.  The content script tries, in
 *     order:
 *       a) a directly visible trigger,
 *       b) expand the description ("Show more"), then retry,
 *       c) any (even hidden) trigger as a last-ditch click,
 *       d) the overflow menu (⋮) → "Show transcript" menuitem.
 *
 *  2. timedtext API (best-effort fallback): tries the signed caption
 *     <baseUrl> embedded in the page's player-response JSON, then plain
 *     v= variants.  This may succeed in some browser sessions where the
 *     DOM approach is blocked, but is unreliable and may return empty.
 *
 * The clipboard write always happens in the popup (a genuine user
 * gesture), never here.
 */

(() => {
  'use strict';

  // NOTE: We intentionally do NOT bail out early on non-watch pages.
  // YouTube is a single-page app — when a user clicks a video link the URL
  // changes via history.pushState() and the content script is NOT
  // re-injected.  If we returned early here (when the script first ran on,
  // say, the homepage) the message listener below would never be set up,
  // and chrome.tabs.sendMessage from the popup would fail with
  // "Extension not active on this tab."  Instead we always register the
  // listener and let extractFullTranscript() verify the URL at call time.

  /* ================================================================ */
  /*  Small async helpers                                             */
  /* ================================================================ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve true once `predicate()` returns truthy, or false after `ms`. */
  const waitFor = (predicate, ms = 8000, interval = 100) =>
    new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (predicate()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start >= ms) {
          clearInterval(timer);
          resolve(false);
        }
      }, interval);
    });

  /* ================================================================ */
  /*  Shadow-DOM-aware DOM traversal                                  */
  /* ================================================================ */

  /**
   * Collect every element matching `selector`, descending into open
   * shadow roots.  YouTube renders many controls inside shadow DOM.
   *
   * NB: we start from document.documentElement (<html>), not document,
   * because document has nodeType 9 and would be skipped by the
   * ELEMENT_NODE guard, starving the traversal of all children.
   */
  function findAll(selector) {
    const out = [];
    const stack = [document.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      try {
        if (node.matches(selector)) out.push(node);
      } catch { /* node isn't a real element */ }
      // Light-DOM children
      for (const child of node.children || []) stack.push(child);
      // Shadow-DOM children (open roots only)
      const sr = node.shadowRoot;
      if (sr) {
        for (const child of sr.children || []) stack.push(child);
      }
    }
    return out;
  }

  /** Like findAll but starting from a specific root element. */
  function findAllIn(root, selector) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
      try {
        if (node.matches(selector)) out.push(node);
      } catch { /* skip */ }
      for (const child of node.children || []) stack.push(child);
      const sr = node.shadowRoot;
      if (sr) {
        for (const child of sr.children || []) stack.push(child);
      }
    }
    return out;
  }

  /**
   * Concatenate all text inside an element — light DOM *plus* any open
   * shadow DOM.  (textContent alone omits shadow-DOM text.)
   */
  function fullText(el) {
    if (!el) return '';
    let t = el.textContent || '';
    const sr = el.shadowRoot;
    if (sr) t += ' ' + (sr.textContent || '');
    return t;
  }

  /** True when the element is actually rendered and visible. */
  function isVisible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' &&
      s.visibility !== 'hidden' &&
      parseFloat(s.opacity) !== 0;
  }

  /** Click a YouTube control, piercing its shadow root if needed. */
  function safeClick(el) {
    if (el.shadowRoot) {
      const inner = el.shadowRoot.querySelector(
        'button, tp-yt-button-renderer, tp-yt-button, ' +
        'ytd-button-renderer, tp-yt-paper-button'
      );
      if (inner) {
        inner.click();
        return;
      }
    }
    el.click();
  }

  /* ================================================================ */
  /*  Transcript panel helpers                                        */
  /* ================================================================ */

  /** The open transcript panel (if any), searched via shadow DOM too. */
  function transcriptPanelEl() {
    return document.querySelector('ytd-transcript-renderer') ||
      findAll('ytd-transcript-renderer').shift() ||
      null;
  }

  function isTranscriptOpen() {
    return !!transcriptPanelEl();
  }

  /* ================================================================ */
  /*  Finding the "Show transcript" button                            */
  /* ================================================================ */

  /** Returns true if the element's text references the transcript. */
  function isTranscriptTrigger(el) {
    const label = fullText(el).toLowerCase();
    return label.includes('transcript') && !label.includes('hide transcript');
  }

  /**
   * Find a visible "Show transcript" trigger on the page.
   * Searches button-like elements including those hidden in shadow DOM.
   */
  function findVisibleTranscriptButton() {
    const selector =
      'button, tp-yt-button-renderer, tp-yt-button, ' +
      'tp-yt-paper-menuitem, ytd-button-renderer, ' +
      'ytd-menu-entry-renderer, ytd-toggle-button-renderer, ' +
      'ytd-icon-button-renderer, a';

    // First check the fast light-DOM query.
    const quick = document.querySelectorAll(selector);
    for (const el of quick) {
      if (isTranscriptTrigger(el) && isVisible(el)) return el;
    }

    // Full shadow-DOM search (slower but thorough).
    const all = findAll(selector);
    for (const el of all) {
      if (isTranscriptTrigger(el) && isVisible(el)) return el;
    }
    return null;
  }

  /**
   * Find the overflow ("⋮") menu button that reveals "Show transcript"
   * as a menu item.
   */
  function findOverflowMenuButton() {
    // Search inside ytd-menu-renderer hosts first.
    let menus = document.querySelectorAll('ytd-menu-renderer');
    if (menus.length === 0) menus = findAll('ytd-menu-renderer');

    for (const menu of menus) {
      const btn = findAllIn(menu, 'button, tp-yt-button-renderer');
      for (const el of btn) {
        if (!isVisible(el)) continue;
        const label = fullText(el).toLowerCase();
        // Skip the description-expand "Show more" button.
        if (el.closest && el.closest('#description, #meta-contents')) continue;
        if (label.includes('show more') ||
            label === 'more' ||
            label.includes('more actions') ||
            label.includes('actions')) {
          return el;
        }
      }
    }

    // Broader fallback: any visible button whose aria-label hints at a menu.
    const all = findAll(
      'button[aria-label], tp-yt-button-renderer[aria-label]'
    );
    for (const el of all) {
      if (!isVisible(el)) continue;
      if (el.closest && el.closest('#description, #meta-contents')) continue;
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('more') || label.includes('action')) return el;
    }
    return null;
  }

  /**
   * Find any "Show transcript" trigger on the page — even hidden ones.
   * This is a *last resort*: `element.click()` can sometimes activate a
   * button that exists in the DOM but isn't yet visible (e.g. the
   * description section is collapsed but the button element is present).
   *
   * The caller must be careful because clicking a display:none element
   * usually does nothing. Use only when the visible search has failed.
   */
  function findAnyTranscriptButton() {
    const selector =
      'button, tp-yt-button-renderer, tp-yt-button, ' +
      'tp-yt-paper-menuitem, ytd-button-renderer, ' +
      'ytd-menu-entry-renderer, ytd-toggle-button-renderer, ' +
      'ytd-icon-button-renderer, a';

    const all = findAll(selector);
    for (const el of all) {
      if (isTranscriptTrigger(el)) {
        // Never target a "Hide transcript" button.
        if (fullText(el).toLowerCase().includes('hide transcript')) continue;
        return el;
      }
    }
    return null;
  }

  /**
   * Expand the video description by clicking its "Show more" / "more"
   * button.  Returns true if a click was dispatched.
   *
   * The transcript button lives inside
   * <ytd-video-description-transcript-section-renderer> within #description,
   * which is collapsed by default. Expanding the description is what makes
   * the button appear (and become visible).
   */
  function expandDescription() {
    // Look in the description container specifically.
    const desc = document.querySelector('#description') ||
      document.querySelector('ytd-video-description-renderer');
    if (!desc) {
      // Fallback: search the whole page but exclude known areas.
      const all = findAll('button, ytd-button-renderer, tp-yt-button-renderer');
      for (const el of all) {
        const label = fullText(el).toLowerCase();
        if ((label.includes('show more') || label === 'more')) {
          // Skip the description-transcript-section's own expander.
          if (el.closest && el.closest('ytd-video-description-transcript-section-renderer')) continue;
          safeClick(el);
          return true;
        }
      }
      return false;
    }

    const buttons = findAllIn(desc, 'button, ytd-button-renderer, tp-yt-button-renderer');
    for (const el of buttons) {
      const label = fullText(el).toLowerCase();
      if (label.includes('show more') || label === 'more') {
        safeClick(el);
        return true;
      }
    }
    return false;
  }

  /** Open the transcript panel. Returns true on success. */
  async function ensureTranscriptOpen() {
    if (isTranscriptOpen()) return true;

    // Attempt 1 — a directly visible "Show transcript" button.
    let btn = findVisibleTranscriptButton();
    if (btn) {
      safeClick(btn);
      await waitFor(() => isTranscriptOpen(), 6000);
      if (isTranscriptOpen()) return true;
    }

    // Attempt 2 — expand the video description first (which reveals the
    // transcript button inside ytd-video-description-transcript-section),
    // then look for a now-visible trigger.
    if (expandDescription()) {
      await sleep(1200);
      btn = findVisibleTranscriptButton();
      if (btn) {
        safeClick(btn);
        await waitFor(() => isTranscriptOpen(), 6000);
        if (isTranscriptOpen()) return true;
      }

      // Attempt 2b — the expanded description still has a (now possibly
      // visible) button we can try clicking directly.
      btn = findAnyTranscriptButton();
      if (btn) {
        safeClick(btn);
        await waitFor(() => isTranscriptOpen(), 6000);
        if (isTranscriptOpen()) return true;
      }
    }

    // Attempt 3 — click any transcript trigger that is in the DOM even
    // though we can't see it (handles edge cases / timing).
    btn = findAnyTranscriptButton();
    if (btn) {
      safeClick(btn);
      await waitFor(() => isTranscriptOpen(), 6000);
      if (isTranscriptOpen()) return true;
    }

    // Attempt 4 — open the overflow menu (⋮), then look for the option.
    const menuBtn = findOverflowMenuButton();
    if (menuBtn) {
      safeClick(menuBtn);
      // Wait for the menu popup to appear.
      await waitFor(
        () =>
          document.querySelector('tp-yt-paper-menu, ytd-menu-popup-renderer, ' +
            'tp-yt-paper-dialog') ||
          findAll('tp-yt-paper-menu, ytd-menu-popup-renderer').length > 0,
        3000
      );
      await sleep(400);

      btn = findVisibleTranscriptButton();
      if (btn) {
        safeClick(btn);
        await waitFor(() => isTranscriptOpen(), 6000);
        if (isTranscriptOpen()) return true;
      }

      // Fallback inside the open menu: try a non-visible trigger too.
      btn = findAnyTranscriptButton();
      if (btn) {
        safeClick(btn);
        await waitFor(() => isTranscriptOpen(), 6000);
        if (isTranscriptOpen()) return true;
      }
    }

    return false;
  }

  /* ================================================================ */
  /*  Lazy-load every segment                                         */
  /* ================================================================ */

  /**
   * YouTube only renders the transcript segments visible in the
   * scrollable panel. We scroll to the bottom repeatedly until the
   * segment count stops growing.
   */
  async function loadAllSegments() {
    await waitFor(() => isTranscriptOpen(), 4000);
    const panel = transcriptPanelEl();
    if (!panel) return;

    // Find the scrollable container (may live inside shadow DOM).
    let scrollEl = null;
    const allChildren = findAllIn(panel, '*');
    for (const el of allChildren) {
      const ov = getComputedStyle(el).overflowY;
      if ((ov === 'auto' || ov === 'scroll') &&
          el.getBoundingClientRect().height > 0) {
        scrollEl = el;
        break;
      }
    }
    if (!scrollEl) scrollEl = panel;

    const count = () =>
      findAllIn(panel, 'ytd-transcript-segment-renderer').length;

    let last = 0;
    for (let i = 0; i < 30; i++) {
      last = count();
      try {
        scrollEl.scrollTo(0, scrollEl.scrollHeight);
      } catch { /* ignore */ }
      await sleep(300);
      if (count() === last) {
        await sleep(200); // double-check
        if (count() === last) break;
      }
    }
  }

  /* ================================================================ */
  /*  Text extraction                                                 */
  /* ================================================================ */

  /** Strip a leading timestamp (0:12 / 1:23:45) and tidy whitespace. */
  function cleanSegment(text) {
    let t = (text || '').trim();
    if (!t) return '';
    t = t.replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '');
    t = t.replace(/\s+/g, ' ');
    return t.trim();
  }

  /** Read every segment renderer's text from the open panel. */
  function extractFromPanel() {
    const panel = transcriptPanelEl();
    if (!panel) return '';

    const segments = findAllIn(
      panel, 'ytd-transcript-segment-renderer'
    );
    const lines = [];

    if (segments.length) {
      segments.forEach((seg) => {
        const cleaned = cleanSegment(fullText(seg));
        if (cleaned) lines.push(cleaned);
      });
    } else {
      // Fallback: split the panel's text on newlines.
      fullText(panel).split(/\n/).forEach((l) => {
        const c = cleanSegment(l);
        if (c) lines.push(c);
      });
    }

    return lines.join('\n');
  }

  /** Open the panel, load segments, and return the text (or null). */
  async function tryDomApproach() {
    const opened = await ensureTranscriptOpen();
    if (!opened) {
      return {
        success: false,
        error: 'Could not open the "Show transcript" panel.',
      };
    }

    // Wait for at least some segments to render.
    await waitFor(
      () =>
        transcriptPanelEl() &&
        findAllIn(transcriptPanelEl(), 'ytd-transcript-segment-renderer')
          .length > 0,
      5000
    );

    await loadAllSegments();
    const transcript = extractFromPanel();

    if (!transcript.trim()) {
      return {
        success: false,
        error: 'Transcript panel opened but no text could be read.',
      };
    }
    return { success: true, transcript };
  }

  /* ================================================================ */
  /*  API fallback — timedtext                                        */
  /* ================================================================ */

  /** Extract the caption-track <baseUrl> from the page's player response. */
  function extractCaptionBaseUrl() {
    const html = document.documentElement.innerHTML;
    // The player response embeds captionTracks in a JSON blob. Grab the
    // first baseUrl that points at api/timedtext.
    const m = html.match(
      /"baseUrl":"(https:\/\/[^"]*api\/timedtext[^"]+)"/
    );
    if (!m) return null;
    return m[1].replace(/\\u0026/g, '&').replace(/\\u003d/g, '=');
  }

  function parseJson3(data) {
    const lines = [];
    for (const event of data.events || []) {
      for (const seg of event.segs || []) {
        if (seg.utf8) {
          const txt = seg.utf8
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
          if (txt) lines.push(txt);
        }
      }
    }
    return lines.join('\n');
  }

  function parseXml(xmlText) {
    if (!xmlText || !xmlText.includes('<text')) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const lines = [];
    for (const t of doc.getElementsByTagName('text')) {
      const txt = (t.textContent || '').trim();
      if (txt) lines.push(txt);
    }
    return lines.length ? lines.join('\n') : null;
  }

  /** Fetch transcript text via the YouTube timedtext API. */
  async function fetchViaApi() {
    const videoId = getVideoId();
    if (!videoId) {
      return { success: false, error: 'Could not determine the video ID.' };
    }

    // Build candidate URLs: signed baseUrl first, then plain v= variants.
    const urls = [];
    const signed = extractCaptionBaseUrl();
    if (signed) urls.push(signed);
    urls.push(
      `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&fmt=json3`,
      `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}`,
      `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&caps=asr&key=yt8&lang=en`,
    );

    for (const url of urls) {
      let text = '';
      try {
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        text = await resp.text();
      } catch {
        continue;
      }
      if (!text || text.length < 10) continue;

      // Try JSON3.
      if (text.trim().startsWith('{')) {
        try {
          const transcript = parseJson3(JSON.parse(text));
          if (transcript.trim()) return { success: true, transcript };
        } catch { /* not JSON */ }
      }
      // Try XML.
      const transcript = parseXml(text);
      if (transcript && transcript.trim()) return { success: true, transcript };
    }

    return { success: false, error: 'API returned no caption text.' };
  }

  /* ================================================================ */
  /*  Video ID                                                        */
  /* ================================================================ */

  function getVideoId() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname.startsWith('/watch')) {
        return url.searchParams.get('v');
      }
      const m = url.pathname.match(/^\/(?:shorts|embed)\/([a-zA-Z0-9_-]+)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /* ================================================================ */
  /*  Orchestrator                                                    */
  /* ================================================================ */

  /**
   * @returns {Promise<{success:boolean, transcript?:string, error?:string, method?:string}>}
   */
  async function extractFullTranscript() {
    if (!window.location.pathname.startsWith('/watch') &&
        !window.location.pathname.startsWith('/shorts')) {
      return {
        success: false,
        error: 'This only works on YouTube watch / shorts pages.',
      };
    }

    // 1) Primary: drive YouTube's "Show transcript" button in the DOM.
    try {
      const result = await tryDomApproach();
      if (result.success && result.transcript) {
        return { ...result, method: 'dom' };
      }
    } catch (err) {
      /* DOM approach threw — try the API below. */
    }

    // 2) Fallback: YouTube timedtext API (browser context).
    const apiResult = await fetchViaApi();
    if (apiResult.success) {
      return { ...apiResult, method: 'api' };
    }

    return {
      success: false,
      error:
        'Could not retrieve the transcript. Make sure the video has a ' +
        'captions/transcript track available, then try again.',
    };
  }

  /* ================================================================ */
  /*  Message listener                                                */
  /* ================================================================ */

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'EZTRANSCRIPT_EXTRACT') {
      extractFullTranscript()
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({ success: false, error: err.message })
        );
      return true; // keep channel open for async sendResponse
    }
    return false;
  });
})();
