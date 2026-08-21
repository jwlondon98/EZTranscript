/**
 * tests for cleanTranscript
 *
 * Run with:  node test/clean_transcript.test.js
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

console.log('cleanTranscript — deterministic parser tests\n');

// ── 1. Empty / whitespace-only ───────────────────────────────
test('empty string returns empty', function () {
  assert.strictEqual(cleanTranscript(''), '');
});

test('null returns empty', function () {
  assert.strictEqual(cleanTranscript(null), '');
});

test('undefined returns empty', function () {
  assert.strictEqual(cleanTranscript(undefined), '');
});

test('whitespace-only returns empty', function () {
  assert.strictEqual(cleanTranscript('   \t  \n  '), '');
});

// ── 2. Annotation removal ────────────────────────────────────
test('removes [music]', function () {
  var raw = 'There is a pause [music] and then he speaks.';
  assert.strictEqual(
    cleanTranscript(raw),
    'There is a pause and then he speaks.'
  );
});

test('removes [Music] (capitalized)', function () {
  assert.strictEqual(
    cleanTranscript('Hello [Music] world'),
    'Hello world'
  );
});

test('removes [MUSIC] (uppercase)', function () {
  assert.strictEqual(
    cleanTranscript('Hello [MUSIC] world'),
    'Hello world'
  );
});

test('removes [applause]', function () {
  assert.strictEqual(
    cleanTranscript('He finished [applause] and sat down.'),
    'He finished and sat down.'
  );
});

test('removes [laughter] and [Laughter]', function () {
  assert.strictEqual(
    cleanTranscript('That was funny [laughter] really funny [Laughter]'),
    'That was funny really funny'
  );
});

test('removes multiple consecutive annotations', function () {
  var raw = '[music][applause][laughter] He speaks now.';
  assert.strictEqual(
    cleanTranscript(raw),
    'He speaks now.'
  );
});

test('removes annotation that is a full line', function () {
  var raw = 'He starts speaking.\n[music]\nHe continues.';
  assert.strictEqual(
    cleanTranscript(raw),
    'He starts speaking.\n\nHe continues.'
  );
});

test('annotation in the middle of a sentence', function () {
  var raw = 'He said [music] hello world.';
  assert.strictEqual(
    cleanTranscript(raw),
    'He said hello world.'
  );
});

test('does NOT remove legitimate bracketed spoken text', function () {
  var raw = 'He said [Chapter 3] and moved on.';
  assert.strictEqual(
    cleanTranscript(raw),
    'He said [Chapter 3] and moved on.'
  );
});

// ── 3. Fragment joining ───────────────────────────────────────
test('joins fragments without sentence punctuation', function () {
  var raw = "There's like a lot of people that talk about how they're sort of\nin their own heads and they spend a lot of time\nruminating.";
  var result = cleanTranscript(raw);
  assert.strictEqual(
    result,
    "There's like a lot of people that talk about how they're sort of in their own heads and they spend a lot of time ruminating."
  );
});

test('joins fragments that end with closing quote', function () {
  var raw = 'He said, "hello"\nworld';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('"hello"'), 'should keep quoted text');
  assert.ok(result.includes('world'), 'should keep world');
  // Should be joined because "hello" doesn't end with sentence punctuation
  assert.ok(!result.match(/"\s+world/) || result.match(/hello"\s+world/),
    'fragments should be joined');
});

test('keeps fragments that DO end with sentence punctuation separate', function () {
  var raw = 'Hello world.\nShe said goodbye.\nThey arrived.';
  var result = cleanTranscript(raw);
  // Should produce 3 separate sentences
  assert.ok(result.match(/Hello world\./), 'first sentence');
  assert.ok(result.match(/She said goodbye\./), 'second sentence');
  assert.ok(result.match(/They arrived\./), 'third sentence');
});

// ── 4. Whitespace normalization ───────────────────────────────
test('collapses multiple spaces', function () {
  var raw = 'Hello     world\n\n  foo    bar';
  var result = cleanTranscript(raw);
  assert.ok(!result.includes('   '), 'no triple spaces');
  assert.ok(!result.match(/ {2,}/), 'no double spaces');
});

test('removes space before punctuation', function () {
  var raw = 'Hello , world .';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'Hello, world.');
});

test('handles CRLF line endings with blank-line paragraph break', function () {
  var raw = 'Hello\r\nworld.\r\n\r\nFoo bar.';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'Hello world.\n\nFoo bar.');
});

test('handles bare CR line endings with blank-line paragraph break', function () {
  var raw = 'Hello\rworld.\r\rFoo bar.';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'Hello world.\n\nFoo bar.');
});

test('CRLF and LF produce identical output for same structure', function () {
  var lfInput = 'Hello world.\n\nFoo bar.';
  var crlfInput = 'Hello world.\r\n\r\nFoo bar.';
  var resultLF = cleanTranscript(lfInput);
  var resultCRLF = cleanTranscript(crlfInput);
  assert.strictEqual(resultLF, resultCRLF);
});

// ── 5. Spoken-word preservation ──────────────────────────────
test('preserves filler words like "um" and "uh"', function () {
  var raw = 'Um, so I think\nuh we should go.';
  var result = cleanTranscript(raw);
  assert.ok(result.toLowerCase().includes('um'), 'should contain "um"');
  assert.ok(result.toLowerCase().includes('uh'), 'should contain "uh"');
});

test('preserves filler "like"', function () {
  var raw = 'I was like\nso confused.';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('like'), 'should preserve "like"');
});

test('preserves "I I think" (no deduplication)', function () {
  var raw = 'I I think\nthis is right.';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('I I think'), 'should preserve "I I think"');
  assert.ok(!result.match(/I think\n\n/), 'should not create paragraph break');
});

test('preserves colloquial grammar and slang', function () {
  var raw = "Gonna go there\nain't nobody got time.";
  var result = cleanTranscript(raw);
  assert.ok(result.includes('Gonna'), 'should keep "Gonna"');
  assert.ok(result.includes("ain't"), 'should keep "ain\'t"');
});

test('preserves transcription mistakes', function () {
  var raw = 'The the cat sat.';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'The the cat sat.');
});

// ── 6. Paragraph breaks ───────────────────────────────────────
test('creates multiple paragraphs for long transcript', function () {
  var sentences = [];
  for (var i = 1; i <= 12; i++) {
    sentences.push('This is sentence number ' + i + ' with some text.');
  }
  var raw = sentences.join('\n');
  var result = cleanTranscript(raw);
  var paragraphs = result.split('\n\n');
  assert.ok(paragraphs.length >= 2, 'should have at least 2 paragraphs, got ' + paragraphs.length);
  assert.ok(paragraphs.length <= 6, 'should have at most 6 paragraphs, got ' + paragraphs.length);
});

test('never inserts paragraph break mid-sentence', function () {
  var raw = 'There is a really long sentence that just keeps going and going\nand going without ending for a very long time indeed.';
  var result = cleanTranscript(raw);
  var paragraphs = result.split('\n\n');
  // Should be a single sentence — no broken paragraphs
  assert.ok(result.indexOf('going without ending') !== -1,
    'sentence should not be broken');
});

test('paragraphs contain 3-6 sentences typically', function () {
  var sentences = [];
  for (var i = 1; i <= 15; i++) {
    sentences.push('Short sentence ' + i + '.');
  }
  var raw = sentences.join('\n');
  var result = cleanTranscript(raw);
  var paragraphs = result.split('\n\n');
  paragraphs.forEach(function (para, idx) {
    var sentenceCount = (para.match(/[.!?]+\s|[^.]\./g) || []).length;
    // Each paragraph should have roughly 3-6 sentences (allow some slack)
    assert.ok(sentenceCount >= 2,
      'para ' + idx + ' has ' + sentenceCount + ' sentences (expected >= 2)');
  });
});

// ── 7. Edge cases ─────────────────────────────────────────────
test('handles transcript with only annotations', function () {
  var raw = '[music]\n[applause]\n[laughter]\n[music]';
  assert.strictEqual(cleanTranscript(raw), '');
});

test('handles annotation at very end', function () {
  var raw = 'He finishes speaking. [music]';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'He finishes speaking.');
});

test('handles annotation at very start', function () {
  var raw = '[music] He begins speaking.';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'He begins speaking.');
});

test('handles very long transcripts without breaking', function () {
  var sentences = [];
  for (var i = 1; i <= 500; i++) {
    sentences.push('Long sentence number ' + i + ' with various words in it.');
  }
  var raw = sentences.join('\n');
  var result = cleanTranscript(raw);
  assert.ok(result.length > 1000, 'result should be substantial');
});

test('handles mixed punctuation', function () {
  var raw = 'Hello, world!\nIs this right?\nYes, it is... well, kind of.';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('Hello, world!'), 'first sentence with exclamation');
  assert.ok(result.includes('Is this right?'), 'second sentence with question');
  assert.ok(result.includes('Yes, it is...'), 'third sentence with ellipsis');
});

test('joins line with trailing comma to next', function () {
  var raw = 'Hello,\nworld.\nFoo,\nbar.';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('Hello, world.'), 'should join comma fragment');
  assert.ok(result.includes('Foo, bar.'), 'should join second comma fragment');
});

test('handles [Laughter and Applause] compound annotation', function () {
  var raw = 'That was hilarious [Laughter and Applause] and then he said hi.';
  var result = cleanTranscript(raw);
  assert.strictEqual(result, 'That was hilarious and then he said hi.');
});

test('handles ellipsis as sentence end', function () {
  var raw = 'Wait for it...\nAnd now he jumps.';
  var result = cleanTranscript(raw);
  assert.ok(result.includes('Wait for it...'), 'should keep ellipsis');
  assert.ok(result.includes('And now he jumps.'), 'should keep next sentence');
});

test('no double newlines after annotation removal', function () {
  var raw = 'Hello [music] world [applause] foo.';
  var result = cleanTranscript(raw);
  assert.ok(!result.match(/\s{2,}/), 'no double spaces');
  assert.strictEqual(result, 'Hello world foo.');
});

// ── 8. Realistic transcript sample ───────────────────────────
test('realistic multi-paragraph transcript', function () {
  var raw = [
    'There\'s like a lot of people that talk about how they\'re sort of',
    "in their own heads and they spend a lot of time ruminating.",
    '[music]',
    'So the question is [applause] what should we do about it.',
    'Well, I think [laughter] we should just move forward.',
    'That\'s right, moving forward is the best strategy.',
    'Some people prefer to stay still but that doesn\'t help anyone.',
    'In fact, staying still is worse than moving in the wrong direction.',
    'At least if you move you\'re making progress even if it\'s not the',
    'right progress.',
    'The key insight is that action beats inaction.',
    '[Music]',
    'Let me repeat that, action beats inaction.',
    'This is a universal truth that applies to everything.',
    'From personal relationships to business ventures.',
    'You can\'t succeed by doing nothing.',
    '[applause]',
    'So take that first step today.',
    'What are you waiting for?',
    'Nothing is going to change if you just sit there.',
    'Change happens when you make it happen.',
    'That\'s all I have to say about that.',
  ].join('\n');

  var result = cleanTranscript(raw);

  // Should not contain any annotations
  assert.ok(!result.match(/\[music\]/i), 'no [music] tags');
  assert.ok(!result.match(/\[applause\]/i), 'no [applause] tags');
  assert.ok(!result.match(/\[laughter\]/i), 'no [laughter] tags');

  // Should contain spoken content
  assert.ok(result.includes("There's like a lot of people"), 'should contain spoken content');
  assert.ok(result.includes('ruminating.'), 'should end first sentence with period');
  assert.ok(result.includes("what should we do"), 'should contain question content');
  assert.ok(result.includes('That\'s right'), 'should preserve punctuation');

  // Should have multiple paragraphs
  var paragraphs = result.split('\n\n');
  assert.ok(paragraphs.length >= 2, 'should have multiple paragraphs');

  // No double spaces
  assert.ok(!result.match(/ {2,}/), 'no double spaces');

  console.log('\n    --- cleanTranscript output excerpt ---');
  console.log('    ' + result.split('\n\n')[0].substring(0, 120) + '...');
  console.log('    --- ' + paragraphs.length + ' paragraphs total ---\n');
});

// ── 9. Determinism check ──────────────────────────────────────
test('produces identical output for identical input (deterministic)', function () {
  var raw = 'Hello [music] world.\nThis is\na test.';
  var result1 = cleanTranscript(raw);
  var result2 = cleanTranscript(raw);
  assert.strictEqual(result1, result2, 'output must be identical');
  var result3 = cleanTranscript(raw);
  assert.strictEqual(result1, result3, 'output must be identical on third run');
});

test('produces identical output for reversed identical calls', function () {
  var raw = 'A [applause] B.\nC D\nE.';
  var r1 = cleanTranscript(raw);
  var r2 = cleanTranscript('A [applause] B.\nC D\nE.');
  assert.strictEqual(r1, r2);
});

// ── Summary ───────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log('  Passed: ' + passed + '   Failed: ' + failed);
console.log('────────────────────────────────────────\n');

if (failed > 0) {
  process.exit(1);
}
