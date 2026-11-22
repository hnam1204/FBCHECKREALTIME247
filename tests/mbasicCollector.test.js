const test = require('node:test');
const assert = require('node:assert/strict');

test('mbasicCollector: extractCUser extracts valid c_user ID', async () => {
  const { extractCUser } = await import('../src/collector/mbasicCollector.js');
  const cookie = 'sb=abc; datr=xyz; c_user=1000892837465; xs=42%3Ahgash:2%3A1;';
  assert.equal(extractCUser(cookie), '1000892837465');
  assert.equal(extractCUser('sb=abc; datr=xyz;'), null);
  assert.equal(extractCUser(null), null);
});

test('mbasicCollector: isCheckpointOrLogin detects login walls and checkpoint', async () => {
  const { isCheckpointOrLogin } = await import('../src/collector/mbasicCollector.js');
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/checkpoint/?next=...', ''), true);
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/login.php', ''), true);
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/story.php', '<form id="login_form"><input type="password" /></form>'), true);
  assert.equal(isCheckpointOrLogin('https://mbasic.facebook.com/story.php', '<div class="story">Valid post</div>'), false);
});

test('mbasicCollector: parseCount converts formatted numbers correctly', async () => {
  const { parseCount } = await import('../src/collector/mbasicCollector.js');
  assert.equal(parseCount('45'), 45);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('1.5K'), 1500);
  assert.equal(parseCount('2M'), 2000000);
});

test('mbasicCollector: parseMbasicHtml extracts reactions, comments, shares and author', async () => {
  const { parseMbasicHtml } = await import('../src/collector/mbasicCollector.js');
  const sampleHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Hainam Tech | Facebook</title></head>
      <body>
        <div id="root">
          <h3 class="actor">Hainam Tech</h3>
          <div data-ft='{"tn":"*s"}'>Chào mừng bạn đến với Cloudflare Edge Monitoring.</div>
          <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123456789">Bạn và 99 người khác</a>
          <a href="/mbasic/comment/advanced/?ft_ent_identifier=123456789">42 bình luận</a>
          <a href="/shares/view/?ft_ent_identifier=123456789">15 lượt chia sẻ</a>
        </div>
      </body>
    </html>
  `;

  const parsed = parseMbasicHtml(sampleHtml);
  assert.equal(parsed.totalReactions, 100);
  assert.equal(parsed.totalComments, 42);
  assert.equal(parsed.totalShares, 15);
  assert.equal(parsed.authorName, 'Hainam Tech');
  assert.equal(parsed.reactionsBrowserUrl, '/ufi/reaction/profile/browser/?ft_ent_identifier=123456789');
});

test('mbasicCollector: parseMbasicReactionsBreakdown extracts all 7 reaction counts', async () => {
  const { parseMbasicReactionsBreakdown } = await import('../src/collector/mbasicCollector.js');
  const tabsHtml = `
    <div id="root">
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=0"><span>Tất cả 100</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=1"><span>Thích 50</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=2"><span>Yêu thích 25</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=16"><span>Thương thương 10</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=4"><span>Haha 8</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=3"><span>Wow 4</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=7"><span>Buồn 2</span></a>
      <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=123&reaction_type=8"><span>Phẫn nộ 1</span></a>
    </div>
  `;

  const breakdown = parseMbasicReactionsBreakdown(tabsHtml);
  assert.deepEqual(breakdown, {
    like: 50,
    love: 25,
    care: 10,
    haha: 8,
    wow: 4,
    sad: 2,
    angry: 1
  });
});

test('mbasicCollector: parseMbasicHtml extracts accurate data from Comet React JSON store', async () => {
  const { parseMbasicHtml } = await import('../src/collector/mbasicCollector.js');
  const cometHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>𝑵𝒈𝒖𝒚𝒆𝒏 𝑯𝒂𝒊 𝑵𝒂𝒎 | Facebook</title></head>
      <body>
        <script>
          requireLazy(["RelayPrefetchedStreamCache"], function(RelayPrefetchedStreamCache) {
            RelayPrefetchedStreamCache.next("123", {
              "feedback": {
                "reaction_count": {"count": 1},
                "comments": {"total_count": 0},
                "share_count": {"count": 0},
                "top_reactions": {
                  "count": 1,
                  "edges": [
                    {"node": {"id": "1", "localized_name": "Thích"}, "reaction_count": 1}
                  ]
                }
              },
              "message": {"text": "Chia sẻ bài viết thử nghiệm hệ thống"}
            });
          });
        </script>
      </body>
    </html>
  `;

  const parsed = parseMbasicHtml(cometHtml);
  assert.equal(parsed.totalReactions, 1);
  assert.equal(parsed.reactions.like, 1);
  assert.equal(parsed.totalComments, 0);
  assert.equal(parsed.totalShares, 0);
  assert.equal(parsed.authorName, '𝑵𝒈𝒖𝒚𝒆𝒏 𝑯𝒂𝒊 𝑵𝒂𝒎');
  assert.equal(parsed.contentSnippet, 'Chia sẻ bài viết thử nghiệm hệ thống');
});

