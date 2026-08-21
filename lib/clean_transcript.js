/**
 * cleanTranscript.js — deterministic, local, no-LLM transcript cleaner
 *
 * Standalone module.  Works in Node.js (for tests) and in the browser
 * content-script / popup contexts (assigned to `window.cleanTranscript`).
 *
 * Flow:
 *   raw caption lines  →  remove annotations  →  join fragments
 *   →  group into paragraphs  →  normalize whitespace  →  prose
 */
(function (global) {
  'use strict';

  /**
   * Keyword list for YouTube/caption sound-event annotations.
   * Matched case-insensitively against the *first word* of a bracketed
   * annotation or against *all content words* when the annotation is
   * very short (≤ 3 meaningful words).
   */
  var KNOWN_ANNOTATIONS = new Set([
    'music', 'musics', 'soundtrack', 'background',
    'applaud', 'applauds', 'applauded', 'applauding', 'applause',
    'laugh', 'laughs', 'laughed', 'laughing', 'laughter',
    'cheer', 'cheers', 'cheered', 'cheering', 'crowd',
    'noise', 'noises', 'static', 'silence', 'hush',
    'sighs', 'sigh', 'sighing', 'coughs', 'cough', 'coughing',
    'snaps', 'snap', 'snapping', 'claps', 'clap', 'clapping',
    'sobs', 'sob', 'sobbing', 'sobbed',
    'cries', 'cry', 'crying', 'cried',
    'groans', 'groan', 'groaning', 'groaned',
    'boos', 'boo', 'booing', 'boohoo',
    'ding', 'dings', 'dong', 'bong', 'beep', 'beeps', 'boop',
    'ring', 'rings', 'ringing', 'bell', 'doorbell',
    'chuckle', 'chuckles', 'chuckled', 'chuckling',
    'snicker', 'snickers', 'snickered', 'snickering',
    'snort', 'snorts', 'snorting', 'snorted',
    'whisper', 'whispers', 'whispered', 'whispering',
    'scream', 'screams', 'screamed', 'screaming',
    'shout', 'shouts', 'shouted', 'shouting',
    'yell', 'yells', 'yelled', 'yelling',
    'footsteps', 'footstep', 'steps', 'walking',
    'knock', 'knocks', 'knocking', 'knocked',
    'door', 'doors', 'doorstep', 'doorbell',
    'phone', 'phones', 'ringtone',
    'muffled', 'keys',
    'swallows', 'swallow', 'gulp', 'gulps', 'gulping',
    'sniffles', 'sniffle', 'sneezes', 'sneeze',
    'clears', 'clears throat', 'throat',
    'fades', 'fading', 'fade',
    'hum', 'hums', 'humming', 'buzz', 'buzzes',
    'tone', 'tones', 'static', 'ringtone'
  ]);

  // Words that are conjunctions / glue, not sound annotations themselves
  var CONJUNCTIONS = new Set([
    'and', 'with', 'of', '&', 'the', 'a', 'an', 'to', 'in',
  ]);

  /**
   * Determine whether a bracketed annotation like [music] or
   * [laughter and applause] is a sound/event marker.
   *
   * Rules:
   *  - Empty [] → yes (always remove)
   *  - First word is a known keyword → yes
   *  - All content words (≤ 3) are known keywords → yes
   *  - Otherwise → no (keep as spoken text)
   */
  function isAnnotation(inner) {
    var lower = inner.toLowerCase().trim();
    if (!lower) return true; // empty bracket = annotation

    var words = lower.split(/\s+/).filter(function (w) {
      return w.length > 0;
    });
    if (words.length === 0) return true;

    // Check first word
    var first = words[0].replace(/[^\w]/g, '');
    if (KNOWN_ANNOTATIONS.has(first)) return true;

    // Check if every meaningful word is a known keyword (short phrases only)
    var contentWords = words.filter(function (w) {
      var cleaned = w.replace(/[^\w]/g, '');
      return cleaned && !CONJUNCTIONS.has(cleaned);
    });
    if (contentWords.length > 0 &&
        contentWords.length <= 3 &&
        contentWords.every(function (w) {
          return KNOWN_ANNOTATIONS.has(w.replace(/[^\w]/g, ''));
        })) {
      return true;
    }

    return false;
  }

  /** Remove bracketed sound annotations from a string. */
  function removeAnnotations(text) {
    return text.replace(/\[([^\]]*)\]/g, function (match, inner) {
      if (isAnnotation(inner)) {
        return '';
      }
      // Not an annotation — keep the bracketed text verbatim.
      return match;
    });
  }

  /**
   * Does *text* end with sentence-ending punctuation?
   * Trailing closing quotes / brackets / parens are stripped first so
   * that `"Hello."` and `(note.)` are treated as sentence ends.
   */
  function endsSentence(text) {
    var clean = text.replace(/["'\)\]\}]+\s*$/, '').trim();
    return /[.!?…]$/.test(clean);
  }

  /**
   * Clean a single caption line: strip annotations, normalize spaces.
   */
  function cleanLine(line) {
    var cleaned = removeAnnotations(line);
    // Collapse internal double-spaces left by annotation removal
    cleaned = cleaned.replace(/\s{2,}/g, ' ');
    return cleaned.trim();
  }

  /**
   * Join caption fragments into complete sentences.
   * Consecutive lines that don't end with sentence punctuation are
   * merged (YouTube splits sentences every few words).
   * Pure-annotation lines (already emptied by cleanLine) are skipped.
   */
  function joinFragments(lines) {
    var sentences = [];
    var current = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;

      if (current) {
        current += ' ' + line;
      } else {
        current = line;
      }

      if (endsSentence(line)) {
        sentences.push(current);
        current = '';
      }
    }

    if (current) {
      sentences.push(current);
    }

    return sentences;
  }

  /**
   * Group sentences into paragraphs (3–6 sentences or ~500–900 chars).
   * Never breaks inside a sentence.
   */
  function createParagraphs(sentences) {
    var paragraphs = [];
    var current = [];
    var currentLen = 0;

    var MAX_SENTENCES = 5;   // start new paragraph after ~5 sentences
    var MAX_CHARS = 700;     // ...or ~700 characters, whichever first
    var MIN_SENTENCES = 3;   // ensure at least 3 sentences per paragraph

    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];

      // Only break if we already have some sentences in the current para
      if (current.length > 0 &&
          (current.length >= MAX_SENTENCES || currentLen >= MAX_CHARS) &&
          current.length >= MIN_SENTENCES) {
        paragraphs.push(current.join(' '));
        current = [];
        currentLen = 0;
      }

      // Also break if paragraph is very long and we have at least 2 sentences
      if (current.length >= 2 && currentLen >= MAX_CHARS * 1.5) {
        paragraphs.push(current.join(' '));
        current = [];
        currentLen = 0;
      }

      current.push(s);
      currentLen += s.length + 1;
    }

    if (current.length > 0) {
      paragraphs.push(current.join(' '));
    }

    return paragraphs;
  }

  /**
   * Normalize whitespace in a paragraph:
   *  - collapse repeated spaces/tabs/newlines → single space
   *  - remove spaces before punctuation
   *  - trim
   */
  function normalizeParagraph(para) {
    return para
      .replace(/[ \t]+/g, ' ')                // collapse spaces/tabs
      .replace(/\s+([,.!?;:])/g, '$1')        // space before punctuation → none
      .replace(/\s+([)}\]'"])/g, '$1')          // space before closing brackets → none
      .replace(/\s{2,}/g, ' ')                 // any remaining doubles
      .trim();
  }

  /**
   * The main entry point.  Call this on raw YouTube caption text
   * to get clean, readable, properly-paragraph-broken prose.
   *
   * Paragraph boundaries come from two sources:
   *   1. Explicit breaks in the source (blank lines or lines that
   *      become empty after annotation removal — e.g. a lone [music]).
   *   2. Implicit breaks via the createParagraphs heuristic
   *      (3–6 sentences / ~700 chars).
   *
   * @param {string} raw - Raw transcript text (lines separated by \n)
   * @returns {string} Cleaned transcript
   */
  function cleanTranscript(raw) {
    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      return '';
    }

    // 1. Normalize line endings (CRLF / CR → LF)
    var text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 2. Split into raw lines and group into blocks.
    //    A block is a run of non-empty lines.  An empty line (or a
    //    line that becomes empty after annotation removal, e.g. a
    //    lone "[music]") forces a paragraph break between blocks.
    var rawLines = text.split('\n');
    var blocks = [];
    var currentBlock = [];

    for (var i = 0; i < rawLines.length; i++) {
      var cleaned = cleanLine(rawLines[i]);
      if (cleaned.length > 0) {
        currentBlock.push(cleaned);
      } else {
        // Empty / annotation-only line → boundary between blocks
        if (currentBlock.length > 0) {
          blocks.push(currentBlock);
          currentBlock = [];
        }
      }
    }
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    if (blocks.length === 0) {
      return '';
    }

    // 3. For each block: join caption fragments → sentences,
    //    then create paragraphs within the block.
    var allParagraphs = [];
    for (var b = 0; b < blocks.length; b++) {
      var sentences = joinFragments(blocks[b]);
      var paras = createParagraphs(sentences);
      allParagraphs = allParagraphs.concat(paras);
    }

    // 4. Normalize whitespace in each paragraph, join with \n\n
    var cleaned = allParagraphs
      .map(normalizeParagraph)
      .filter(function (p) {
        return p.length > 0;
      })
      .join('\n\n');

    return cleaned;
  }

  // ── exports ──────────────────────────────────────────────

  // Node.js / CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = cleanTranscript;
  }

  // Browser (content script / popup)
  if (typeof window !== 'undefined') {
    window.cleanTranscript = cleanTranscript;
  }

})(typeof globalThis !== 'undefined' ? globalThis : window);
