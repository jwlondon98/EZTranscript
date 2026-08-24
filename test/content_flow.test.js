/** Regression checks for the YouTube UI automation flow. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var source = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'content.js'),
  'utf8'
);

function bodyBetween(start, end) {
  var from = source.indexOf(start);
  var to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'could not isolate ' + start);
  return source.slice(from, to);
}

var safeClick = bodyBetween('function safeClick', 'Transcript panel helpers');
assert.ok(safeClick.includes('target.click()'), 'safeClick uses a native click');
assert.ok(!safeClick.includes('clickInPageContext('), 'safeClick does not duplicate the click');
assert.ok(!safeClick.includes('dispatchEvent('), 'safeClick does not dispatch another click');

var expand = bodyBetween('function expandDescription', 'function isDescriptionExpander');
assert.ok(
  expand.includes('#description-inline-expander #expand'),
  'description expansion uses YouTube\'s dedicated control'
);
assert.ok(
  !expand.includes('findAll(selector)'),
  'description fallback is not a page-wide More-button search'
);

var panel = bodyBetween('function transcriptPanelEl', 'function isTranscriptOpen');
assert.ok(panel.includes('ytd-transcript-search-panel-renderer'));
assert.ok(panel.includes('engagement-panel-timeline-view-consolidated'));
assert.ok(panel.includes('TRANSCRIPT_SEGMENT_SELECTOR'));
assert.ok(panel.includes('isVisible(panel)'));
assert.ok(panel.includes('EXPANDED'));

assert.ok(
  source.includes(
    "'ytd-transcript-segment-renderer, transcript-segment-view-model'"
  ),
  'classic and modern transcript rows are both supported'
);
assert.ok(
  source.includes('function transcriptSegmentText'),
  'modern rows have a dedicated spoken-text extractor'
);

assert.ok(
  source.includes('safeClick(menuBtn);'),
  'overflow menu is clicked once without transcript-panel retry logic'
);

console.log('content flow regression checks passed');
