/*
 * EZTranscript — background service worker (Manifest V3)
 *
 * In MV3, the background service worker is required for extension
 * lifecycle management.  It is minimal — the actual work happens in
 * the content script and the popup.
 */
chrome.runtime.onInstalled.addListener(() => {
  // Extension installed or updated — nothing special to do yet.
});

// Listen for messages from the popup and forward them to the content script.
// This is required in MV3 when the popup needs to communicate with a
// content script that may not be injected yet.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'EZTRANSCRIPT_EXTRACT' && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, request)
      .then((response) => {
        sendResponse(response);
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    // Return true to keep the message channel open for async sendResponse.
    return true;
  }
  return false;
});
