/**
 * End-to-end integration test for the extract → clean → copy flow.
 *
 * Simulates what happens inside the popup:
 *   1. The content script returns a raw transcript (simulated)
 *   2. The popup calls cleanTranscript(rawTranscript)
 *   3. The popup copies the cleaned transcript to clipboard (simulated)
 *
 * Run with:  node test/test_e2e_flow.js
 */
var assert = require('assert');
var cleanTranscript = require('../lib/clean_transcript.js');

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + e.message);
  }
}

console.log('E2E — extract → clean → copy flow simulation\n');

// ── Mock the content-script extraction result ──────────────────
// In the real extension, the content script returns an object like:
//   { success: true, transcript: <raw lines>, method: 'dom', debug: [...] }
// The popup then calls cleanTranscript(response.transcript)
// and copies the result.

test('simulates full popup flow with raw YouTube caption text', function () {
  var rawTranscript = [
    '[music]',
    'So there I was, standing in front of the whole class',
    'and I was like, what am I going to do?',
    '[laughter]',
    'And then the professor said something that changed',
    'everything about how I think about public speaking.',
    'He said, "The secret is to just be yourself."',
    '[applause]',
    'But I didn\'t believe him at first.',
    'I thought he was crazy.',
    'Turns out he was right.',
    'Now I love speaking in public.',
  ].join('\n');

  // Step 1: "Extraction" (simulated — the content script returns this)
  var response = { success: true, transcript: rawTranscript, method: 'dom' };

  // Step 2: Clean (exactly what popup.js does)
  var transcript = cleanTranscript(response.transcript);

  // Step 3: "Copy to clipboard" (simulated — we just check the result)
  assert.ok(transcript.length > 0, 'cleaned transcript should not be empty');
  assert.ok(!transcript.includes('[music]'), 'no [music] in cleaned');
  assert.ok(!transcript.includes('[laughter]'), 'no [laughter] in cleaned');
  assert.ok(!transcript.includes('[applause]'), 'no [applause] in cleaned');
  assert.ok(transcript.includes('standing in front of the whole class'),
    'should contain spoken content (fragment joined)');
  assert.ok(transcript.includes('what am I going to do?'),
    'should preserve question mark');
  assert.ok(transcript.includes('changed everything'),
    'should join fragments across lines');
  assert.ok(!transcript.match(/  /), 'no double spaces');

  console.log('\n    --- Simulated clipboard output ---');
  console.log('    ' + transcript.split('\n\n')[0].substring(0, 120) + '...');
  console.log('    --- ' + transcript.split('\n\n').length + ' paragraphs ---\n');
});

test('simulates flow with empty transcript (video has no captions)', function () {
  var response = { success: true, transcript: '', method: 'dom' };
  var transcript = cleanTranscript(response.transcript);
  assert.strictEqual(transcript, '', 'empty transcript stays empty');
  assert.strictEqual(transcript.length, 0, 'zero-length output');
});

test('simulates flow with only annotations', function () {
  var response = {
    success: true,
    transcript: '[music]\n[applause]\n[laughter]\n[music]',
    method: 'dom'
  };
  var transcript = cleanTranscript(response.transcript);
  assert.strictEqual(transcript, '', 'all-annotation transcript → empty');
});

test('simulates flow with multiline caption fragments', function () {
  var response = {
    success: true,
    transcript: [
      "There's like a lot of people that talk about how they're sort of",
      'in their own heads and they spend a lot of time',
      'ruminating.',
      '[music]',
      'So the question is what should we do about it.',
      'Well, I think we should just move forward.',
      'That\'s right moving forward is the best strategy.',
      'Some people prefer to stay still but that doesn\'t help anyone.',
      'In fact, staying still is worse than moving in the wrong direction.',
      'At least if you move you\'re making progress even if it\'s not the',
      'right progress.',
      'The key insight is that action beats inaction.',
      '[Music]',
      'Let me repeat that action beats inaction.',
      'This is a universal truth that applies to everything.',
      'From personal relationships to business ventures.',
      'You can\'t succeed by doing nothing.',
      '[applause]',
      'So take that first step today.',
      'What are you waiting for?',
    ].join('\n'),
    method: 'dom'
  };

  var transcript = cleanTranscript(response.transcript);
  assert.ok(transcript.length > 100, 'should produce substantial text');
  assert.ok(!transcript.includes('[music]'), 'no [music]');
  assert.ok(!transcript.includes('[applause]'), 'no [applause]');
  assert.ok(transcript.includes("There's like a lot of people"), 'should contain opening');
  assert.ok(transcript.includes('ruminating.'), 'should end joined fragment with period');
  assert.ok(transcript.includes('action beats inaction.'), 'should contain key sentence');

  // Verify paragraph breaks exist
  var paragraphs = transcript.split('\n\n');
  assert.ok(paragraphs.length >= 2, 'should have multiple paragraphs (' + paragraphs.length + ')');

  // Verify no paragraph is just whitespace or empty
  paragraphs.forEach(function (p, i) {
    assert.ok(p.trim().length > 0, 'paragraph ' + i + ' should not be empty');
  });

  console.log('\n    --- Simulated clipboard output (first paragraph) ---');
  console.log('    ' + transcript.split('\n\n')[0].substring(0, 150) + '...');
  console.log('    --- ' + paragraphs.length + ' paragraphs total ---\n');
});

test('simulates popup fallback when cleanTranscript is not loaded', function () {
  // If window.cleanTranscript is not defined (e.g., script failed to load),
  // the popup falls back to the raw transcript.
  var rawTranscript = 'Hello [music] world. This is a test.';
  var transcript = rawTranscript; // fallback path in popup.js
  assert.ok(transcript.includes('[music]'), 'fallback keeps raw text with annotations');
});

test('simulates clipboard character/word count display', function () {
  var response = {
    success: true,
    transcript: 'He said hello. She said goodbye.\n[music]\nThey met again.',
    method: 'dom'
  };
  var transcript = cleanTranscript(response.transcript);
  var charLen = transcript.length;
  var wordCount = transcript.split(/\s+/).filter(function (w) { return w.length; }).length;

  assert.ok(charLen > 0, 'char count should be positive');
  assert.ok(wordCount > 0, 'word count should be positive');
  // With annotations removed, fewer chars than raw
  assert.ok(charLen < response.transcript.length,
    'cleaned text should be shorter than raw (annotations removed)');

  console.log('    ' + charLen + ' characters • ' + wordCount + ' words');
});

// ── Summary ───────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log('  E2E Passed: ' + passed + '   Failed: ' + failed);
console.log('────────────────────────────────────────\n');

if (failed > 0) {
  process.exit(1);
}
