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
 *     <baseUrl> from window.ytInitialPlayerResponse, then from the
 *     page HTML, then plain v= variants.  In a real browser session
 *     this can succeed when the DOM approach is blocked, but it's
 *     unreliable (YouTube may return empty bodies).
 *
 * The clipboard write always happens in the popup (a genuine user
 * gesture), never here.
 */

(() => {
  'use strict';

  // We do NOT bail out early on non-watch pages. YouTube is a
  // single-page app — when a user clicks a video link the URL changes
  // via history.pushState() and the content script is NOT
  // re-injected.  If we returned early here (when the script first ran
  // on, e.g., the homepage) the message listener below would never be
  // set up, and chrome.tabs.sendMessage from the popup would fail with
  // "Extension not active on this tab."  Instead we always register the
  // listener and let extractFullTranscript() verify the URL at call time.

  const DEBUG = []; // collected diagnostic messages for error reporting

  function log(msg) {
    DEBUG.push(msg);
    // Also log to console for debugging via chrome://extensions.
    try { console.log('[EZTranscript]', msg); } catch { /* no-op */ }
  }

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

  /**
   * Like waitFor, but returns the truthy value of `fn()` (not just true).
   * Useful for polling for an element that might appear gradually
   * (e.g. after a description-expand animation).
   */
  const waitForFound = (fn, ms = 8000, interval = 100) =>
    new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const val = fn();
        if (val) {
          clearInterval(timer);
          resolve(val);
        } else if (Date.now() - start >= ms) {
          clearInterval(timer);
          resolve(null);
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
      // Light-DOM children — push in reverse so pop() yields DOM order.
      const ch = node.children || [];
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
      // Shadow-DOM children (open roots only) — same reverse trick.
      const sr = node.shadowRoot;
      if (sr) {
        const srCh = sr.children || [];
        for (let i = srCh.length - 1; i >= 0; i--) stack.push(srCh[i]);
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
      // Push children in reverse so pop() yields DOM order.
      const ch = node.children || [];
      for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
      const sr = node.shadowRoot;
      if (sr) {
        const srCh = sr.children || [];
        for (let i = srCh.length - 1; i >= 0; i--) stack.push(srCh[i]);
      }
    }
    return out;
  }

  /**
   * Recursively collect ALL text inside an element — light DOM *plus*
   * every level of open shadow DOM.  A single-level shadowRoot.textContent
   * lookup misses text that lives inside nested shadow roots (YouTube
   * buttons are typically nested 2-3 levels deep:
   *   tp-yt-button-renderer > shadow > tp-yt-button-shape > shadow > button > "Show transcript"
   * so we recurse.
   */
  function fullText(el) {
    if (!el || typeof el !== 'object') return '';
    // Light-DOM textContent (includes all descendant text in light DOM).
    let t = el.textContent || '';
    const sr = el.shadowRoot;
    if (sr) {
      // sr.textContent captures the shadow DOM's light-DOM text
      // (text in elements that do NOT have their own shadow root).
      // This is ESSENTIAL because button labels like "Show transcript"
      // often live directly inside a shadow root:
      //   tp-yt-button-shape > shadow-root > <button>Show transcript</button>
      // Without this line, that text is never captured.
      t += ' ' + (sr.textContent || '');
      // Recurse into children that have their own shadow roots to
      // capture text in *nested* shadow roots (sr.textContent does not
      // include nested shadow-root text).
      const children = sr.children || [];
      for (let i = 0; i < children.length; i++) {
        if (children[i].shadowRoot) {
          t += ' ' + fullText(children[i]);
        }
      }
    }
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

  /**
   * Click an element from inside the PAGE's main JavaScript context
   * (not the content script's isolated world).  YouTube buttons are
   * managed by React-like frameworks that attach listeners in the page
   * context; synthetic .click() / dispatchEvent calls from the
   * isolated world sometimes fail to trigger them.  Injecting a
   * <script> tag runs in the page context, so target.click() there
   * fires all listeners.
   *
   * Returns true if the injected script executed without throwing.
   */
  function clickInPageContext(el) {
    if (!el) return false;
    try {
      const uid = '__ezt_click_' + Date.now() + '_' +
        Math.random().toString(36).slice(2, 8);
      el.setAttribute('data-ezt-uid', uid);

      const script = document.createElement('script');
      script.textContent = [
        '(function() {',
        '  var uid = "' + uid + '";',
        '  var found = null;',
        '  var visited = 0;',
        '  var MAX = 16000;',
        '  function findUid(root) {',
        '    if (!root || visited > MAX) return null;',
        '    if (root.getAttribute && root.getAttribute("data-ezt-uid") === uid) return root;',
        '    visited++;',
        '    var kids = root.children || [];',
        '    for (var i = 0; i < kids.length; i++) {',
        '      var f = findUid(kids[i]);',
        '      if (f) return f;',
        '      if (kids[i].shadowRoot) {',
        '        f = findUid(kids[i].shadowRoot);',
        '        if (f) return f;',
        '      }',
        '    }',
        '    return null;',
        '  }',
        // First, try to find the element by its UID attribute.
        '  found = findUid(document.documentElement);',
        // Fallback: if UID search fails, search by text content.
        '  if (!found) {',
        '    visited = 0;',
        '    function findByText(root) {',
        '      if (!root || visited > MAX) return null;',
        '      visited++;',
        '      if (root.getAttribute) {',
        '        var txt = (root.textContent || "").toLowerCase();',
        '        var aria = (root.getAttribute("aria-label") || "").toLowerCase();',
        '        if ((txt.indexOf("show transcript") >= 0 || aria.indexOf("show transcript") >= 0) && txt.indexOf("hide") < 0 && aria.indexOf("hide") < 0) {',
        '          return root;',
        '        }',
        '      }',
        '      var kids = root.children || [];',
        '      for (var i = 0; i < kids.length; i++) {',
        '        var f = findByText(kids[i]);',
        '        if (f) return f;',
        '        if (kids[i].shadowRoot) {',
        '          f = findByText(kids[i].shadowRoot);',
        '          if (f) return f;',
        '        }',
        '      }',
        '      return null;',
        '    }',
        '    found = findByText(document.documentElement);',
        '  }',
        '  if (!found) return;',
        '  found.removeAttribute("data-ezt-uid");',
        '  var target = found;',
        '  var guard = 0;',
        '  while (target.shadowRoot && guard < 5) {',
        '    var inner = target.shadowRoot.querySelector(',
        '      "button, tp-yt-button-renderer, tp-yt-button, ytd-button-renderer, tp-yt-paper-button, yt-button-shape"',
        '    );',
        '    if (inner) { target = inner; } else { break; }',
        '    guard++;',
        '  }',
        '  try { target.focus(); } catch(e) {}',
        '  try { target.click(); } catch(e) {}',
        '  var r = target.getBoundingClientRect();',
        '  var x = r ? r.left + r.width / 2 : 0;',
        '  var y = r ? r.top + r.height / 2 : 0;',
        '  ["mouseenter","mouseover","mousedown","mouseup","click"].forEach(function(t) {',
        '    try { target.dispatchEvent(new MouseEvent(t, {',
        '      view: window, bubbles: true, cancelable: true,',
        '      clientX: x, clientY: y, detail: 1, button: 0',
        '    })); } catch(e) {}',
        '  });',
        '})();'
      ].join('\n');
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Click a YouTube control, piercing shadow roots if needed.
   *
   * Strategy (in order):
   *   1. Inject a script into the PAGE's main context and click there.
   *      This is the most reliable method for React-managed buttons.
   *   2. Native .click() from the content script.
   *   3. Dispatched MouseEvent at the element's center.
   */
  function safeClick(el) {
    if (!el) return;

    // Drill into nested shadow roots to find the actual clickable element.
    let target = el;
    let guard = 0;
    while (target.shadowRoot && guard < 5) {
      const inner = target.shadowRoot.querySelector(
        'button, tp-yt-button-renderer, tp-yt-button, ' +
        'ytd-button-renderer, tp-yt-paper-button, yt-button-shape'
      );
      if (inner) target = inner;
      else break;
      guard++;
    }

    // 1) Click from inside the page's JavaScript context (most reliable).
    clickInPageContext(el);

    // 2) Native .click() from the content script.
    try { target.click(); } catch { /* element might not be clickable */ }

    // 3) Dispatched MouseEvent at the element's center.
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Element has zero size (hidden/collapsed) — borrow a parent's
      // coordinates for the event position, but STILL dispatch on the
      // target so its own listeners fire (events bubble up, not down).
      let x = rect.left;
      let y = rect.top;
      let parent = target.parentElement;
      let tries = 0;
      while (parent && tries < 5) {
        const pr = parent.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          x = pr.left + pr.width / 2;
          y = pr.top + pr.height / 2;
          break;
        }
        parent = parent.parentElement;
        tries++;
      }
      const event = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(event);
    } else {
      const event = new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      target.dispatchEvent(event);
    }
  }

  /* ================================================================ */
  /*  Transcript panel helpers                                        */
  /* ================================================================ */

  /**
   * The open transcript panel (if any).  Checks several possible
   * selectors because YouTube's DOM structure evolves.
   */
  function transcriptPanelEl() {
    // Most common: ytd-transcript-renderer
    const byQuery = document.querySelector('ytd-transcript-renderer');
    if (byQuery) return byQuery;

    // Shadow-DOM search for the panel (in case it's nested).
    const found = findAll('ytd-transcript-renderer');
    if (found.length) return found[0];

    // Some YouTube versions use a dialog or engagement panel.
    const alt = findAll('ytd-transcript-modal-renderer, ' +
      'tp-yt-paper-dialog ytd-transcript-renderer, ' +
      '.ytp-transcript-panel, #transcript-content, ' +
      'ytd-engagement-panel-container[transcript], ' +
      'ytd-engagement-panel-container[target-id*="transcript"], ' +
      'ytd-engagement-panel-container[target-id*="transcript-renderer"], ' +
      '[target-id="engagement-panel-ytd-transcript"], ' +
      '[target-id*="transcript"]');
    if (alt.length) return alt[0];

    // Last resort: any element whose text contains "transcript" and
    // has segment-like children.
    const candidates = findAll('ytd-transcript-segment-renderer');
    if (candidates.length) {
      // Walk up to find the panel container.
      let p = candidates[0];
      for (let i = 0; i < 5 && p.parentElement; i++) p = p.parentElement;
      return p;
    }

    return null;
  }

  function isTranscriptOpen() {
    return !!transcriptPanelEl();
  }

  /* ================================================================ */
  /*  Finding the "Show transcript" button                            */
  /* ================================================================ */

  /** Returns true if the element's text references the transcript. */
  function isTranscriptTrigger(el) {
    if (!el) return false;
    const label = fullText(el).toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const combined = label + ' ' + ariaLabel + ' ' + title;
    return combined.includes('transcript') &&
      !combined.includes('hide transcript') &&
      !combined.includes('transcript settings');
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
      'ytd-icon-button-renderer, yt-button-shape, a, ' +
      'div[role="button"], span[role="button"]';

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
   * Find any "Show transcript" trigger — even hidden ones.
   * Last-resort click attempt for elements that exist in the DOM
   * but aren't currently rendered with non-zero dimensions.
   */
  function findAnyTranscriptButton() {
    const selector =
      'button, tp-yt-button-renderer, tp-yt-button, ' +
      'tp-yt-paper-menuitem, ytd-button-renderer, ' +
      'ytd-menu-entry-renderer, ytd-toggle-button-renderer, ' +
      'ytd-icon-button-renderer, yt-button-shape, a, ' +
      'div[role="button"], span[role="button"]';

    const all = findAll(selector);
    for (const el of all) {
      if (isTranscriptTrigger(el)) {
        if (fullText(el).toLowerCase().includes('hide transcript')) continue;
        return el;
      }
    }

    // Fallback: search ALL elements for "transcript" in aria-label.
    const everything = findAll('*');
    for (const el of everything) {
      const aria = (el.getAttribute && el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('show transcript') && !aria.includes('hide')) {
        return el;
      }
      if (aria.includes('transcript') && !aria.includes('hide') && !aria.includes('settings')) {
        return el;
      }
    }
    return null;
  }

  /**
   * Expand the video description by clicking its "Show more" button.
   * Returns true if a click was dispatched.
   *
   * This is critical because YouTube hides the "Show transcript" button
   * behind the collapsed description.  We must expand the description
   * *before* the transcript trigger becomes clickable.
   *
   * Strategy: look for buttons whose text or aria-label contains "more"
   * and that have aria-expanded="false" (the expander state).  These are
   * searched both within the description container and as a page-wide
   * fallback inside the video-info / meta area.
   */
  function expandDescription() {
    const selector =
      'button, tp-yt-button-renderer, tp-yt-button, ytd-button-renderer, ' +
      'yt-button-shape, tp-yt-paper-button, tp-yt-paper-menuitem';

    // 1) Try within known description containers (light DOM + shadow).
    let containers = document.querySelectorAll(
      '#description, ytd-video-description-renderer, ' +
      '#meta-contents, #info-contents, #menu-container, ' +
      'ytd-watch-flexy'
    );
    if (containers.length === 0) {
      containers = findAll('ytd-video-description-renderer');
    }

    for (const container of containers) {
      const all = findAllIn(container, selector);
      for (const el of all) {
        if (isDescriptionExpander(el)) {
          safeClick(el);
          return true;
        }
      }
    }

    // 2) Page-wide fallback: look for any expander that's *not* inside
    //    the transcript section or the engagement menu.
    const allButtons = findAll(selector);
    for (const el of allButtons) {
      if (isDescriptionExpander(el)) {
        // Skip buttons that belong to the transcript panel itself.
        if (el.closest &&
            el.closest('ytd-transcript-segment-renderer, ytd-transcript-renderer')) continue;
        safeClick(el);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if an element is a description "Show more" expander.
   * Looks at both visible text and aria-label, and also checks
   * aria-expanded to confirm it's in the collapsed state.
   */
  function isDescriptionExpander(el) {
    if (!el) return false;
    const label = fullText(el).toLowerCase().trim();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    const combined = label + ' ' + ariaLabel;

    if (!combined.includes('more')) return false;

    // Skip explicit "show transcript" triggers (we only want the
    // description expander here).
    if (combined.includes('transcript')) return false;

    // Skip buttons that are in the engagement / overflow area.
    if (el.closest && el.closest(
      'ytd-engagement-panel-container[transcript], ' +
      'ytd-transcript-segment-renderer, ' +
      'ytd-transcript-renderer, ' +
      'tp-yt-paper-dialog[transcript]'
    )) return false;

    // Prefer buttons that have aria-expanded="false" (collapsed state).
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'false') return true;
    if (expanded === 'true') return false;

    // No aria-expanded — use text match as the heuristic.
    return true;
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
      'button[aria-label], tp-yt-button-renderer[aria-label], yt-button-shape[aria-label]'
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
   * Click an element and wait for the transcript panel to appear.
   * Retries up to 3 times: YouTube sometimes misses the first click
   * on a freshly-rendered button.
   */
  async function clickWithRetry(el, waitMs = 6000) {
    if (!el) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      log(`Click attempt ${attempt + 1} on: ${fullText(el).substring(0, 60)}`);
      safeClick(el);
      if (await waitFor(() => isTranscriptOpen(), waitMs)) {
        log('Panel opened!');
        return true;
      }
      if (attempt < 2) await sleep(300);
    }
    return false;
  }

  /**
   * Last-resort fallback: look for a transcript panel that YouTube has
   * already rendered into the DOM but hidden (e.g., behind a hidden
   * attribute or zero-opacity).  Reveal it by removing hiding attributes.
   */
  function tryRevealTranscriptPanel() {
    const selectors = [
      'ytd-engagement-panel-container[transcript]',
      'ytd-engagement-panel-container[target-id*="transcript"]',
      'ytd-engagement-panel-container[target-id="engagement-panel-ytd-transcript"]',
      'ytd-transcript-renderer',
      'tp-yt-paper-dialog ytd-transcript-renderer',
      'ytd-engagement-panel-container ytd-transcript-renderer',
      'ytd-transcript-modal-renderer',
    ];

    // Light-DOM search first.
    for (const sel of selectors) {
      const panel = document.querySelector(sel);
      if (panel) {
        panel.removeAttribute('hidden');
        panel.style.removeProperty('display');
        panel.style.removeProperty('visibility');
        panel.style.removeProperty('opacity');
        log(`Revealed panel via selector: ${sel}`);
        // Return even if segments aren't loaded yet — the caller
        // will poll for them.
        return panel;
      }
    }

    // Shadow-DOM search (YouTube nests containers in shadow roots).
    for (const sel of ['ytd-engagement-panel-container', 'ytd-transcript-renderer']) {
      const containers = findAll(sel);
      for (const container of containers) {
        if (container.getAttribute && container.getAttribute('transcript') !== null) {
          container.removeAttribute('hidden');
          container.style.removeProperty('display');
          container.style.removeProperty('visibility');
          container.style.removeProperty('opacity');
          // Also try to open the panel by clicking its toggle button.
          const toggle = findAllIn(container, 'button, tp-yt-button-renderer');
          for (const t of toggle) {
            safeClick(t);
          }
          log('Tried revealing engagement panel container directly.');
          return container;
        }
      }
    }

    // Last resort: look for any element with "transcript" in its ID or
    // class name that might be a panel container.
    const allEls = findAll('*');
    for (const el of allEls) {
      const id = (el.id || '').toLowerCase();
      const className = (el.className || '').toLowerCase();
      const tag = (el.tagName || '').toLowerCase();
      if ((id.includes('transcript') || className.includes('transcript')) &&
          (tag.includes('panel') || tag.includes('container') || tag.includes('renderer'))) {
        el.removeAttribute('hidden');
        el.style.removeProperty('display');
        el.style.removeProperty('visibility');
        el.style.removeProperty('opacity');
        log('Revealed panel by ID/class match: ' + el.tagName);
        return el;
      }
    }

    return null;
  }

  /**
   * Open the transcript panel. Returns true on success.
   *
   * The key insight: YouTube only renders the "Show transcript" button
   * inside the *expanded* video description.  We expand the description
   * first, then find and click the button.
   *
   * Clicks are dispatched from the PAGE's JavaScript context via
   * clickInPageContext() (most reliable), with native .click() and
   * MouseEvent dispatch as fallbacks.
   */
  async function ensureTranscriptOpen() {
    if (isTranscriptOpen()) return true;

    log('Checking if transcript is already open...');

    // ── Attempt 1: directly visible "Show transcript" button ──────
    let btn = findVisibleTranscriptButton();
    if (btn) {
      log('Found visible transcript button, clicking...');
      if (await clickWithRetry(btn, 4000)) return true;
      log('Visible button click did not open panel.');
    } else {
      log('No visible transcript button found — will expand description.');
      // Diagnostic: look at what "transcript" elements exist.
      const allButtons = findAll(
        'button, tp-yt-button-renderer, tp-yt-button, yt-button-shape, ' +
        'ytd-button-renderer, div[role="button"], span[role="button"], a'
      );
      log(`Total button-like elements on page: ${allButtons.length}`);
      let transcriptEls = 0;
      let sampleTexts = [];
      for (const el of allButtons) {
        const txt = fullText(el).toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (txt.includes('transcript') || aria.includes('transcript')) {
          transcriptEls++;
          if (sampleTexts.length < 5) {
            sampleTexts.push((txt + ' ' + aria).substring(0, 80).trim());
          }
        }
      }
      log(`Elements with 'transcript' in text/aria: ${transcriptEls}`);
      if (sampleTexts.length > 0) {
        log(`Sample texts: ${sampleTexts.join(' | ')}`);
      }
    }

    // ── Attempt 2: expand the description, then look for button ─────
    const expanded = expandDescription();
    if (expanded) {
      log('Description expand requested, waiting for button to render...');
      // Poll for the button to appear after the expand animation.
      btn = await waitForFound(
        () => findVisibleTranscriptButton(),
        5000
      );
      if (btn) {
        log('Found transcript button after expand, clicking...');
        if (await clickWithRetry(btn, 4000)) return true;
      }
      // Try hidden button as well (exists in DOM but maybe zero-size).
      btn = findAnyTranscriptButton();
      if (btn) {
        log('Trying hidden button after expand...');
        if (await clickWithRetry(btn, 4000)) return true;
      }
      // Diagnostic: if still no button after expand, log what we found.
      if (!btn) {
        const allButtons = findAll(
          'button, tp-yt-button-renderer, tp-yt-button, yt-button-shape, ' +
          'ytd-button-renderer, div[role="button"], span[role="button"], a'
        );
        let transcriptEls = 0;
        let sampleTexts = [];
        for (const el of allButtons) {
          const txt = fullText(el).toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (txt.includes('transcript') || aria.includes('transcript')) {
            transcriptEls++;
            if (sampleTexts.length < 5) {
              sampleTexts.push((txt + ' ' + aria).substring(0, 80).trim());
            }
          }
        }
        log(`After expand: ${transcriptEls} elements with 'transcript' found`);
        if (sampleTexts.length > 0) {
          log(`Sample texts: ${sampleTexts.join(' | ')}`);
        } else {
          log('No elements with "transcript" found at all on the page!');
        }
      }
    } else {
      log('Description already expanded or no expander found.');
    }

    // ── Attempt 3: click any transcript trigger (even hidden) ───────
    btn = findAnyTranscriptButton();
    if (btn) {
      log('Trying hidden transcript button click...');
      if (await clickWithRetry(btn, 4000)) return true;
      log('Hidden button click did not open panel.');
    } else {
      log('No transcript trigger found at all.');
    }

    // ── Attempt 4: open the overflow menu (⋮), then look ───────────
    const menuBtn = findOverflowMenuButton();
    if (menuBtn) {
      log('Found overflow menu button, opening...');
      await clickWithRetry(menuBtn, 3000);
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
        log('Found transcript in menu, clicking...');
        if (await clickWithRetry(btn, 4000)) return true;
      }

      btn = findAnyTranscriptButton();
      if (btn) {
        log('Trying hidden transcript button in menu...');
        if (await clickWithRetry(btn, 4000)) return true;
      }
    } else {
      log('No overflow menu button found.');
    }

    // ── Attempt 5: direct DOM manipulation ──────────────────────────
    // If all click attempts have failed, try to reveal a hidden
    // transcript panel that YouTube has already rendered (but hidden).
    log('Trying direct DOM manipulation as last resort...');
    const panel = tryRevealTranscriptPanel();
    if (panel) {
      log('Revealed a panel container, waiting for segments to load...');
      const loaded = await waitFor(
        () => findAllIn(panel, 'ytd-transcript-segment-renderer').length > 0,
        5000
      );
      if (loaded) {
        log('Segments found after revealing panel!');
        return true;
      }
      log('Panel revealed but no segments found after 5s.');
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
    log(`Loaded ${count()} transcript segments.`);
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
      log(`Found ${segments.length} segment renderers in panel.`);
      segments.forEach((seg) => {
        const cleaned = cleanSegment(fullText(seg));
        if (cleaned) lines.push(cleaned);
      });
    } else {
      log('No segment renderers found, trying text fallback.');
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
    log('Starting DOM approach...');
    const opened = await ensureTranscriptOpen();
    if (!opened) {
      return {
        success: false,
        error: 'Could not open the "Show transcript" panel.',
      };
    }
    log('Transcript panel opened!');

    // Wait for at least some segments to render.
    const waited = await waitFor(
      () =>
        transcriptPanelEl() &&
        findAllIn(transcriptPanelEl(), 'ytd-transcript-segment-renderer')
          .length > 0,
      5000
    );
    if (!waited) {
      log('Warning: no segments found within 5s, trying anyway.');
    }

    await loadAllSegments();
    const transcript = extractFromPanel();

    if (!transcript.trim()) {
      return {
        success: false,
        error: 'Transcript panel opened but no text could be read.',
      };
    }
    log(`Extracted ${transcript.length} characters of transcript.`);
    return { success: true, transcript };
  }

  /* ================================================================ */
  /*  API fallback — timedtext                                        */
  /* ================================================================ */

  /**
   * Extract the caption-track <baseUrl> from the page's player response.
   * Tries the live JS object first (reliable in real browsers), then
   * falls back to the static HTML embedded in the page.
   */
  function extractCaptionBaseUrl() {
    // 1) Try the live JavaScript object on the page.
    try {
      const resp = window.ytInitialPlayerResponse;
      if (resp && resp.captions) {
        const list = resp.captions.list || resp.captions;
        if (list && list.captionTracks && list.captionTracks.length > 0) {
          const track = list.captionTracks.find(
            (t) => t.baseUrl
          );
          if (track && track.baseUrl) {
            log('Found caption baseUrl in ytInitialPlayerResponse.');
            return track.baseUrl
              .replace(/\\u0026/g, '&')
              .replace(/\\u003d/g, '=');
          }
        }
      }
    } catch (e) { /* fall through */ }

    // 2) Fallback: extract from raw HTML (server-rendered JSON blob).
    const html = document.documentElement.innerHTML;
    const m = html.match(
      /"baseUrl":"(https:\/\/[^"]*api\/timedtext[^"]+)"/
    );
    if (!m) {
      log('No caption baseUrl found in page HTML or player response.');
      return null;
    }
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
      let resp;
      try {
        resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) continue;
        text = await resp.text();
      } catch {
        continue;
      }
      log(`API fetch: ${url.substring(0, 60)}... → status ${resp?.status || 'n/a'}, len ${text.length}`);
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
   * @returns {Promise<{success:boolean, transcript?:string, error?:string, method?:string, debug?:string[]}>}
   */
  async function extractFullTranscript() {
    const path = window.location.pathname;
    if (!path.startsWith('/watch') && !path.startsWith('/shorts')) {
      return {
        success: false,
        error: 'This only works on YouTube watch / shorts pages.',
      };
    }

    // Wait for YouTube's page to be ready (it's a SPA).
    log(`Starting extraction on ${path}`);
    const ready = await waitFor(() => {
      const app = document.querySelector('ytd-app, ytd-watch-flexy');
      const player = document.querySelector('video, ytd-watch-flexy');
      return !!app || !!player;
    }, 8000);
    if (!ready) log('Warning: ytd-app not found within 8s, proceeding anyway.');

    // 1) Primary: drive YouTube's "Show transcript" button in the DOM.
    try {
      const result = await tryDomApproach();
      if (result.success && result.transcript) {
        return { ...result, method: 'dom', debug: DEBUG };
      }
    } catch (err) {
      log(`DOM approach threw: ${err.message}`);
    }

    // 2) Fallback: YouTube timedtext API (browser context).
    try {
      log('Starting API fallback...');
      const apiResult = await fetchViaApi();
      if (apiResult.success) {
        return { ...apiResult, method: 'api', debug: DEBUG };
      }
    } catch (err) {
      log(`API approach threw: ${err.message}`);
    }

    return {
      success: false,
      error:
        'Could not retrieve the transcript. Make sure the video has a ' +
        'captions/transcript track available, then try again.',
      debug: DEBUG,
    };
  }

  /* ================================================================ */
  /*  Message listener                                                */
  /* ================================================================ */

  try {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request.action === 'EZTRANSCRIPT_EXTRACT') {
        DEBUG.length = 0; // reset for each invocation
        extractFullTranscript()
          .then((result) => sendResponse(result))
          .catch((err) =>
            sendResponse({ success: false, error: err.message })
          );
        return true; // keep channel open for async sendResponse
      }
      return false;
    });
  } catch (e) {
    console.error('[EZTranscript] Failed to register message listener:', e.message);
  }
})();
