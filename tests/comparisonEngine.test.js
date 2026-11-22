const test = require('node:test');
const assert = require('node:assert');
const { computeComparisonAnalytics } = require('../src/analytics/comparisonEngine.js');

test('Comparison Engine - Insufficient targets (< 2)', () => {
  const result = computeComparisonAnalytics({ targets: [{ id: 1, author_name: 'Post 1' }] });
  assert.strictEqual(result.status, 'INSUFFICIENT_POSTS');
  assert.strictEqual(result.targets.length, 0);
  assert.ok(result.message.includes('từ 2 đến 4 bài viết'));
});

test('Comparison Engine - 2 posts deep comparison in ABSOLUTE_TIME mode', () => {
  const target1 = {
    id: 1,
    author_name: 'Kênh Tin Tức',
    target_type: 'POST',
    normalized_url: 'https://facebook.com/post1',
    created_at: '2026-11-22T08:00:00.000Z',
    latest_reactions: 1200,
    latest_comments: 300,
    latest_shares: 50
  };

  const target2 = {
    id: 2,
    author_name: 'Cộng Đồng Dev',
    target_type: 'POST',
    normalized_url: 'https://facebook.com/post2',
    created_at: '2026-11-22T09:00:00.000Z',
    latest_reactions: 800,
    latest_comments: 400,
    latest_shares: 20
  };

  const snapshotsByTarget = {
    1: [
      {
        observed_at: '2026-11-22T10:00:00.000Z',
        total_reactions: 1000,
        total_comments: 250,
        total_shares: 40,
        delta_reactions: 50,
        like_count: 700,
        love_count: 200,
        care_count: 50,
        haha_count: 30,
        wow_count: 10,
        sad_count: 5,
        angry_count: 5
      },
      {
        observed_at: '2026-11-22T11:00:00.000Z',
        total_reactions: 1200,
        total_comments: 300,
        total_shares: 50,
        delta_reactions: 200,
        like_count: 850,
        love_count: 230,
        care_count: 60,
        haha_count: 35,
        wow_count: 15,
        sad_count: 5,
        angry_count: 5
      }
    ],
    2: [
      {
        observed_at: '2026-11-22T10:00:00.000Z',
        total_reactions: 700,
        total_comments: 350,
        total_shares: 15,
        delta_reactions: 30,
        like_count: 400,
        love_count: 150,
        care_count: 50,
        haha_count: 70,
        wow_count: 20,
        sad_count: 5,
        angry_count: 5
      },
      {
        observed_at: '2026-11-22T11:00:00.000Z',
        total_reactions: 800,
        total_comments: 400,
        total_shares: 20,
        delta_reactions: 100,
        like_count: 450,
        love_count: 180,
        care_count: 60,
        haha_count: 80,
        wow_count: 20,
        sad_count: 5,
        angry_count: 5
      }
    ]
  };

  const accountsByTarget = {
    1: [
      { fb_user_id: '1001', display_name: 'User A', profile_url: 'https://fb.com/1001', interaction_type: 'REACTION', reaction_type: 'LOVE' },
      { fb_user_id: '1002', display_name: 'User B', profile_url: 'https://fb.com/1002', interaction_type: 'COMMENT', comment_text: 'Bài viết hay' },
      { fb_user_id: '1003', display_name: 'User C', profile_url: 'https://fb.com/1003', interaction_type: 'REACTION', reaction_type: 'LIKE' }
    ],
    2: [
      { fb_user_id: '1002', display_name: 'User B', profile_url: 'https://fb.com/1002', interaction_type: 'COMMENT', comment_text: 'Ý kiến rất chuẩn' },
      { fb_user_id: '1004', display_name: 'User D', profile_url: 'https://fb.com/1004', interaction_type: 'REACTION', reaction_type: 'HAHA' }
    ]
  };

  const alertsByTarget = {
    1: [],
    2: []
  };

  const result = computeComparisonAnalytics({
    targets: [target1, target2],
    snapshotsByTarget,
    accountsByTarget,
    alertsByTarget,
    range: '24H',
    mode: 'ABSOLUTE_TIME'
  });

  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.targets.length, 2);

  // Component 1: Engagement
  assert.strictEqual(result.engagement.length, 2);
  const eng1 = result.engagement.find(e => e.targetId === 1);
  assert.strictEqual(eng1.reactions, 1200);
  assert.strictEqual(eng1.comments, 300);
  assert.strictEqual(eng1.shares, 50);
  assert.strictEqual(eng1.totalEngagement, 1550);
  assert.strictEqual(eng1.delta.reactions, 200);

  // Component 2: 7 Reactions
  assert.strictEqual(result.reactionsBreakdown.length, 2);
  const rx1 = result.reactionsBreakdown.find(r => r.targetId === 1);
  assert.strictEqual(rx1.counts.like, 850);
  assert.strictEqual(rx1.counts.love, 230);
  assert.ok(rx1.percentages.like > 0);

  // Component 3: Growth
  assert.strictEqual(result.growthSeries.length, 2);
  const growth1 = result.growthSeries.find(g => g.targetId === 1);
  assert.strictEqual(growth1.points.length, 2);
  assert.ok(growth1.growthRatePerHour >= 0);

  // Component 6: Account Overlap (Jaccard)
  // Target 1 has 3 accounts (1001, 1002, 1003)
  // Target 2 has 2 accounts (1002, 1004)
  // Intersection = { 1002 } = 1
  // Union = { 1001, 1002, 1003, 1004 } = 4
  // Jaccard = 1/4 = 0.25 (25.0%)
  assert.strictEqual(result.accountOverlap.pairs.length, 1);
  const pair = result.accountOverlap.pairs[0];
  assert.strictEqual(pair.intersectionCount, 1);
  assert.strictEqual(pair.unionCount, 4);
  assert.strictEqual(pair.jaccardIndex, 0.25);
  assert.strictEqual(pair.jaccardPercent, 25.0);

  // Common accounts
  assert.strictEqual(result.accountOverlap.commonAccounts.length, 1);
  assert.strictEqual(result.accountOverlap.commonAccounts[0].fbUserId, '1002');
  assert.strictEqual(result.accountOverlap.commonAccounts[0].posts.length, 2);

  // Component 7: Performance
  const perf2 = result.performance.find(p => p.targetId === 2);
  assert.strictEqual(perf2.commentRatio, 50.0); // 400 cmt / 800 rx = 50%

  // Insights
  assert.ok(result.insights.length >= 3);
  assert.ok(result.insights.some(i => i.includes('Kênh Tin Tức')));
});

test('Comparison Engine - POST_AGE mode relative hour alignment', () => {
  const targetA = {
    id: 10,
    author_name: 'Post A',
    created_at: '2026-11-22T00:00:00.000Z',
    latest_reactions: 100,
    latest_comments: 10,
    latest_shares: 5
  };
  const targetB = {
    id: 20,
    author_name: 'Post B',
    created_at: '2026-11-21T12:00:00.000Z',
    latest_reactions: 200,
    latest_comments: 20,
    latest_shares: 10
  };

  const snapshotsByTarget = {
    10: [{ observed_at: '2026-11-22T02:00:00.000Z', total_reactions: 100, total_comments: 10, total_shares: 5 }],
    20: [{ observed_at: '2026-11-21T15:00:00.000Z', total_reactions: 200, total_comments: 20, total_shares: 10 }]
  };

  const result = computeComparisonAnalytics({
    targets: [targetA, targetB],
    snapshotsByTarget,
    mode: 'POST_AGE'
  });

  const ptA = result.growthSeries.find(g => g.targetId === 10).points[0];
  const ptB = result.growthSeries.find(g => g.targetId === 20).points[0];

  assert.strictEqual(ptA.label, 'T+2h');
  assert.strictEqual(ptB.label, 'T+3h');
});
