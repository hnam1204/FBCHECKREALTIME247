const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, analyzeUrl, parseBatchUrls } = require('../src/analyzer/urlAnalyzer');

test('URL Analyzer: Normalization strips tracking parameters', () => {
  const dirty = 'https://www.facebook.com/permalink.php?story_fbid=123456&id=10001&fbclid=IwAR2345&__cft__[0]=AZX&ref=share';
  const clean = normalizeUrl(dirty);
  assert.equal(clean, 'https://www.facebook.com/permalink.php?story_fbid=123456&id=10001');
});

test('URL Analyzer: Normalizes mobile m.facebook.com to www.facebook.com', () => {
  const mobile = 'https://m.facebook.com/story.php?story_fbid=999&id=888';
  const clean = normalizeUrl(mobile);
  assert.equal(clean, 'https://www.facebook.com/story.php?story_fbid=999&id=888');
});

test('URL Analyzer: Rejects non-facebook domain', () => {
  const invalid = 'https://phishing-site.com/fake-fb-post';
  assert.equal(normalizeUrl(invalid), '');
});

test('URL Analyzer: Identifies Reel and extracts ID', () => {
  const reelUrl = 'https://www.facebook.com/reel/1234567890?s=yWDuG2&fs=e';
  const clean = normalizeUrl(reelUrl);
  const info = analyzeUrl(clean);
  assert.equal(info.type, 'reel');
  assert.equal(info.contentId, '1234567890');
  assert.equal(info.status, 'READY_TO_MONITOR');
});

test('URL Analyzer: Identifies Video Watch and extracts ID', () => {
  const watchUrl = 'https://www.facebook.com/watch/?v=9876543210';
  const clean = normalizeUrl(watchUrl);
  const info = analyzeUrl(clean);
  assert.equal(info.type, 'video');
  assert.equal(info.contentId, '9876543210');
});

test('URL Analyzer: Batch parse with deduplication and invalid detection', () => {
  const batch = `
    https://www.facebook.com/reel/111111?fbclid=1
    https://www.facebook.com/reel/111111?fbclid=2
    not_a_valid_url
    https://www.facebook.com/permalink.php?story_fbid=222222&id=333333
  `;
  const results = parseBatchUrls(batch);
  assert.equal(results.length, 4);
  assert.equal(results[0].isDuplicate, false);
  assert.equal(results[1].isDuplicate, true); // deduplicated
  assert.equal(results[2].isValid, false);
  assert.equal(results[3].isValid, true);
});
