/**
 * Unit-style test for the expandDescription / isDescriptionExpander
 * logic. Since these functions are embedded in the content script IIFE,
 * we replicate the core logic here and test it against synthetic DOM
 * structures to verify the matching heuristics.
 *
 * Run with:  node test/test_expand_logic.js
 */
var assert = require('assert');

var passed = 0;
var failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name); console.error('    ' + e.message); }
}

// ── Replica of the KNOWN_ANNOTATIONS set (for cleanTranscript) ──
// (Imported from the actual module to avoid duplication.)
var cleanTranscript = require('../lib/clean_transcript.js');

// ── Replica of isDescriptionExpander logic ──────────────────────
// We extract the matching logic from content.js and test it in isolation.

var CONJUNCTIONS = new Set(['and', 'with', 'of', '&', 'the', 'a', 'an', 'to', 'in']);
var KNOWN_ANNOTATIONS = new Set([
  'music', 'applaud', 'applause', 'laugh', 'laughter', 'cheer', 'cheers',
  'crowd', 'noise', 'silence', 'sigh', 'cough', 'snap', 'clap', 'sob',
  'cry', 'groan', 'boo', 'ding', 'beep', 'chuckle', 'snicker', 'whisper',
  'scream', 'shout', 'footstep', 'knock', 'door', 'phone', 'muffled',
  'clears', 'hum', 'buzz', 'tone', 'static', 'ringtone', 'background',
  'doorbell', 'yell', 'keys', 'fades', 'sniffle', 'gulp'
]);

// Simulate isAnnotation to verify annotation detection
function isAnnotation(inner) {
  var lower = inner.toLowerCase().trim();
  if (!lower) return true;

  var words = lower.split(/\s+/).filter(function (w) { return w.length > 0; });
  if (words.length === 0) return true;

  var first = words[0].replace(/[^\w]/g, '');
  if (KNOWN_ANNOTATIONS.has(first)) return true;

  var contentWords = words.filter(function (w) {
    var cleaned = w.replace(/[^\w]/g, '');
    return cleaned && !CONJUNCTIONS.has(cleaned);
  });
  if (contentWords.length > 0 && contentWords.length <= 3 &&
      contentWords.every(function (w) { return KNOWN_ANNOTATIONS.has(w.replace(/[^\w]/g, '')); })) {
    return true;
  }
  return false;
}

// ── Tests ───────────────────────────────────────────────────────

test('isAnnotation: [music] → true', function () {
  assert.strictEqual(isAnnotation('music'), true);
});

test('isAnnotation: [Music] → true (case-insensitive)', function () {
  assert.strictEqual(isAnnotation('Music'), true);
});

test('isAnnotation: [applause] → true', function () {
  assert.strictEqual(isAnnotation('applause'), true);
});

test('isAnnotation: [laughter and applause] → true (first word keyword)', function () {
  assert.strictEqual(isAnnotation('laughter and applause'), true);
});

test('isAnnotation: [background music] → true (all words known, ≤3)', function () {
  assert.strictEqual(isAnnotation('background music'), true);
});

test('isAnnotation: [I love music] → false (spoken text)', function () {
  assert.strictEqual(isAnnotation('I love music'), false);
});

test('isAnnotation: [Chapter 3] → false (not a sound annotation)', function () {
  assert.strictEqual(isAnnotation('Chapter 3'), false);
});

test('isAnnotation: [door opens] → true (keyword + verb)', function () {
  assert.strictEqual(isAnnotation('door opens'), true);
});

test('isAnnotation: empty string → true', function () {
  assert.strictEqual(isAnnotation(''), true);
});

test('isAnnotation: [phone ringing] → true', function () {
  assert.strictEqual(isAnnotation('phone ringing'), true);
});

test('isAnnotation: [door] → true (single keyword)', function () {
  assert.strictEqual(isAnnotation('door'), true);
});

// ── Description expander heuristic tests ───────────────────────
// We test the text-matching part of isDescriptionExpander

function isDescriptionExpanderLabel(ariaLabel, text) {
  // Simplified: check if "more" appears in label or aria-label, and
  // "transcript" does NOT appear (transcript triggers should be excluded).
  var label = (text || '').toLowerCase().trim();
  var aLabel = (ariaLabel || '').toLowerCase().trim();
  var combined = label + ' ' + aLabel;
  if (combined.includes('transcript')) return false;
  return combined.includes('more');
}

test('expander: aria-label "Show more" → true', function () {
  assert.strictEqual(isDescriptionExpanderLabel('Show more', ''), true);
});

test('expander: aria-label "show more" (lowercase) → true', function () {
  assert.strictEqual(isDescriptionExpanderLabel('show more', ''), true);
});

test('expander: visible text "Show more" → true', function () {
  assert.strictEqual(isDescriptionExpanderLabel('', 'Show more'), true);
});

test('expander: aria-label "Show transcript" → false (transcript trigger)', function () {
  assert.strictEqual(isDescriptionExpanderLabel('Show transcript', ''), false);
});

test('expander: aria-label "More actions" → true (but not transcript)', function () {
  assert.strictEqual(isDescriptionExpanderLabel('More actions', ''), true);
});

test('expander: no text, no aria-label → false', function () {
  assert.strictEqual(isDescriptionExpanderLabel('', ''), false);
});

// ── cleanTranscript integration with expander flow ─────────────

test('full flow: description expand removed, annotation line, then transcript', function () {
  // Simulates what a real YouTube transcript looks like after the
  // description is expanded: segments separated by \n, with
  // annotation lines between sentences.
  var raw = [
    'Welcome to the video.',
    '[music]',
    'Today we discuss how to code.',
    'It is very important to test your code.',
    '[applause]',
    'Let me show you an example.',
    'Example one is here.',
    'Example two is there.',
    'Example three is everywhere.',
    '[music]',
    'In conclusion, testing is good.',
  ].join('\n');

  var result = cleanTranscript(raw);

  // No annotations remain
  assert.ok(!result.includes('[music]'), 'no [music]');
  assert.ok(!result.includes('[applause]'), 'no [applause]');

  // Annotation-only lines create paragraph breaks
  var paragraphs = result.split('\n\n');
  assert.ok(paragraphs.length >= 3, 'should have at least 3 paragraphs (annotation breaks), got ' + paragraphs.length);

  // Content is preserved
  assert.ok(result.includes('Welcome to the video.'), 'first paragraph');
  assert.ok(result.includes('Today we discuss how to code.'), 'second paragraph');
  assert.ok(result.includes('In conclusion, testing is good.'), 'last paragraph');
});

test('full flow: realistic transcript with multiple topic changes', function () {
  var raw = [
    'Hello everyone and welcome to this talk.',
    'Today we will discuss clean code principles.',
    'Clean code is code that is easy to read and maintain.',
    'Here is the first principle: meaningful names.',
    'Always use descriptive names for variables and functions.',
    '[music]',
    'Now let us move to the second principle.',
    'Functions should do one thing and do it well.',
    'They should be small and focused.',
    'If a function does too much, split it.',
    '[laughter]',
    'The third principle is about error handling.',
    'Always handle errors gracefully.',
    'Use specific exception types, not generic ones.',
    'And never silently swallow exceptions.',
    '[applause]',
    'That concludes my talk. Thank you!',
    '[music]',
  ].join('\n');

  var result = cleanTranscript(raw);
  var paragraphs = result.split('\n\n');

  // Annotation-only lines ([music], [laughter], [applause]) create breaks.
  // This should produce at least 4 paragraphs.
  assert.ok(paragraphs.length >= 4,
    'should have at least 4 paragraphs, got ' + paragraphs.length);

  // No annotations in output
  assert.ok(!result.match(/\[music\]/i), 'no [music]');
  assert.ok(!result.match(/\[laughter\]/i), 'no [laughter]');
  assert.ok(!result.match(/\[applause\]/i), 'no [applause]');

  // All spoken content preserved
  assert.ok(result.includes('Hello everyone and welcome to this talk.'), 'opening');
  assert.ok(result.includes('meaningful names'), 'principle 1');
  assert.ok(result.includes('error handling'), 'principle 3');
  assert.ok(result.includes('silently swallow exceptions'), 'error content');
  assert.ok(result.includes('Thank you!'), 'closing');
});

// ── Summary ───────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log('  Passed: ' + passed + '   Failed: ' + failed);
console.log('────────────────────────────────────────\n');

if (failed > 0) {
  process.exit(1);
}
