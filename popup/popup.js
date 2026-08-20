/*
 * EZTranscript — popup controller
 *
 * Wires the popup UI to the content script running in the active
 * YouTube tab. The clipboard write happens here (in the popup) so it
 * always executes under a real user gesture — the button click.
 */
(() => {
  'use strict';

  const btn = document.getElementById('copy-btn');
  const statusEl = document.getElementById('status');
  const statusIcon = document.getElementById('status-icon');
  const statusText = document.getElementById('status-text');
  const detailEl = document.getElementById('detail');
  const detailText = document.getElementById('detail-text');

  /* ------------------------------------------------------------------ */
  /*  UI helpers                                                        */
  /* ------------------------------------------------------------------ */

  function setStatus(type, message, detail = '') {
    statusEl.className = `status ${type}`;
    statusEl.hidden = false;
    if (type === 'success') {
      statusIcon.textContent = '✅';
    } else if (type === 'error') {
      statusIcon.textContent = '⚠️';
    } else {
      statusIcon.textContent = '⏳';
    }
    statusText.textContent = message;
    detailEl.hidden = !detail;
    detailText.textContent = detail;
  }

  function setLoading(isLoading) {
    btn.disabled = isLoading;
    if (isLoading) {
      btn.classList.add('loading');
      const icon = btn.querySelector('.btn-icon');
      const text = btn.querySelector('.btn-text');
      if (icon) icon.textContent = '⏳';
      if (text) text.textContent = 'Working…';
    } else {
      btn.classList.remove('loading');
      const icon = btn.querySelector('.btn-icon');
      const text = btn.querySelector('.btn-text');
      if (icon) icon.textContent = '📋';
      if (text) text.textContent = 'Copy Transcript';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Tab detection                                                     */
  /* ------------------------------------------------------------------ */

  async function getActiveYoutubeTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab;
  }

  async function isYoutubeWatch(tab) {
    if (!tab || !tab.url) return false;
    try {
      const u = new URL(tab.url);
      return u.hostname.includes('youtube.com') && u.pathname.startsWith('/watch');
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Clipboard                                                         */
  /* ------------------------------------------------------------------ */

  async function copyToClipboard(text) {
    // Preferred modern API (works because of the popup button gesture).
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback for older / non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------------ */
  /*  Main flow                                                         */
  /* ------------------------------------------------------------------ */

  async function onCopyClick() {
    statusEl.hidden = true;
    detailEl.hidden = true;

    const tab = await getActiveYoutubeTab();

    if (!(await isYoutubeWatch(tab))) {
      setStatus(
        'error',
        'Navigate to a YouTube watch page first.',
        'The icon turns blue when you’re on youtube.com/watch.'
      );
      return;
    }

    setLoading(true);

    let response;
    try {
      response = await chrome.tabs.sendMessage(
        tab.id,
        { action: 'EZTRANSCRIPT_EXTRACT' },
        // tabs.sendMessage resolves to undefined when no listener handles it,
        // so we wrap the await explicitly.
      );
    } catch (err) {
      // "Could not establish connection" etc. — treat as not-on-youtube.
      setStatus(
        'error',
        'Extension not active on this tab.',
        'Make sure you are on a YouTube watch page.'
      );
      setLoading(false);
      return;
    }

    setLoading(false);

    // No response means the content script didn't handle the message.
    if (!response || typeof response !== 'object') {
      setStatus(
        'error',
        'No response from the page.',
        'Try refreshing the YouTube tab.'
      );
      return;
    }

    if (!response.success) {
      setStatus('error', response.error || 'Something went wrong.');
      return;
    }

    // Copy to clipboard.
    try {
      await copyToClipboard(response.transcript);
    } catch (err) {
      setStatus(
        'error',
        'Copied to clipboard failed.',
        'Try copying manually: the text is shown below is NOT retained.'
      );
      return;
    }

    const charLen = response.transcript.length;
    const wordCount = response.transcript
      .split(/\s+/)
      .filter((w) => w.length).length;

    setStatus(
      'success',
      'Transcript copied to clipboard!',
      `${charLen.toLocaleString()} characters • ${wordCount.toLocaleString()} words`
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Init                                                              */
  /* ------------------------------------------------------------------ */

  btn.addEventListener('click', onCopyClick);

  // On open, let the user know we're ready and remind them where it works.
  (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!(await isYoutubeWatch(tab))) {
      setStatus(
        'error',
        'Not a YouTube watch page.',
        'Open a video on youtube.com and click Copy Transcript.'
      );
    }
  })();
})();
