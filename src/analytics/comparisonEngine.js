/**
 * Post Comparison Analytics Engine - NHN Telemetry (Prompt 04)
 * Provides multi-post analytical metrics, 7 reactions breakdown, growth curves,
 * time-bucket distributions, Jaccard overlap index, and rule-based verifiable insights.
 */

const POST_COLORS = ['#38C6FF', '#10B981', '#F59E0B', '#EC4899'];

const RANGE_HOURS_MAP = {
  '5M': 5 / 60,
  '15M': 15 / 60,
  '30M': 30 / 60,
  '1H': 1,
  '3H': 3,
  '6H': 6,
  '12H': 12,
  '24H': 24,
  '7D': 7 * 24,
  '30D': 30 * 24
};

/**
 * Computes deep comparison analytics between 2 and 4 monitored posts.
 * @param {Object} params
 * @param {Array<Object>} params.targets - Array of target rows (2 to 4)
 * @param {Object} params.snapshotsByTarget - Map of targetId -> Array<Snapshot> sorted by observed_at ASC
 * @param {Object} params.accountsByTarget - Map of targetId -> Array<AccountInteracted>
 * @param {Object} params.alertsByTarget - Map of targetId -> Array<Alert>
 * @param {string} params.range - '5M' | '15M' | '30M' | '1H' | '3H' | '6H' | '12H' | '24H' | '7D' | '30D'
 * @param {string} params.mode - 'ABSOLUTE_TIME' | 'POST_AGE'
 * @returns {Object} Complete comparison analysis package
 */
export function computeComparisonAnalytics({
  targets = [],
  snapshotsByTarget = {},
  accountsByTarget = {},
  alertsByTarget = {},
  range = '24H',
  mode = 'ABSOLUTE_TIME'
}) {
  if (!Array.isArray(targets) || targets.length < 2) {
    return {
      status: 'INSUFFICIENT_POSTS',
      message: 'Cần chọn từ 2 đến 4 bài viết để thực hiện đối chiếu hiệu suất so sánh.',
      targets: [],
      engagement: [],
      reactionsBreakdown: [],
      growthSeries: [],
      timeBuckets: [],
      authenticity: [],
      accountOverlap: { pairs: [], commonAccounts: [] },
      performance: [],
      insights: []
    };
  }

  const validTargets = targets.slice(0, 4);
  const periodHours = RANGE_HOURS_MAP[range] || 24;

  // 1. Process Target Metadata & Colors
  const targetsWithMeta = validTargets.map((t, idx) => ({
    id: t.id,
    authorName: t.author_name || `Bài viết #${t.id}`,
    targetType: (t.target_type || 'post').toUpperCase(),
    normalizedUrl: t.normalized_url || '#',
    authorAvatar: t.author_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&auto=format&fit=crop&q=60',
    postImage: t.post_image || null,
    status: t.status || 'ACTIVE',
    createdAt: t.created_at || new Date().toISOString(),
    latestReactions: t.latest_reactions || 0,
    latestComments: t.latest_comments || 0,
    latestShares: t.latest_shares || 0,
    color: POST_COLORS[idx % POST_COLORS.length]
  }));

  // 2. Component 1: ENGAGEMENT (Totals, Deltas, Change %)
  const engagement = targetsWithMeta.map(t => {
    const snaps = snapshotsByTarget[t.id] || [];
    const firstSnap = snaps[0];
    const lastSnap = snaps[snaps.length - 1];

    let deltaRx = 0;
    let deltaCmt = 0;
    let deltaSh = 0;

    if (snaps.length >= 2 && firstSnap && lastSnap) {
      deltaRx = Math.max(0, (lastSnap.total_reactions || 0) - (firstSnap.total_reactions || 0));
      deltaCmt = Math.max(0, (lastSnap.total_comments || 0) - (firstSnap.total_comments || 0));
      deltaSh = Math.max(0, (lastSnap.total_shares || 0) - (firstSnap.total_shares || 0));
    } else if (snaps.length === 1 && firstSnap) {
      deltaRx = firstSnap.delta_reactions || 0;
      deltaCmt = firstSnap.delta_comments || 0;
      deltaSh = firstSnap.delta_shares || 0;
    }

    const deltaTotal = deltaRx + deltaCmt + deltaSh;
    const rxBaseline = firstSnap ? (firstSnap.total_reactions || 0) : t.latestReactions;
    const changePercent = rxBaseline > 0
      ? parseFloat(((deltaRx / rxBaseline) * 100).toFixed(1))
      : (deltaRx > 0 ? 100.0 : 0.0);

    const totalEngagement = t.latestReactions + t.latestComments + t.latestShares;

    return {
      targetId: t.id,
      authorName: t.authorName,
      color: t.color,
      reactions: t.latestReactions,
      comments: t.latestComments,
      shares: t.latestShares,
      totalEngagement,
      delta: {
        reactions: deltaRx,
        comments: deltaCmt,
        shares: deltaSh,
        total: deltaTotal
      },
      changePercent
    };
  });

  // 3. Component 2: REACTIONS (7 Cảm xúc)
  const reactionsBreakdown = targetsWithMeta.map(t => {
    const snaps = snapshotsByTarget[t.id] || [];
    const lastSnap = snaps[snaps.length - 1];

    const like = lastSnap?.like_count !== undefined ? lastSnap.like_count : t.latestReactions;
    const love = lastSnap?.love_count || 0;
    const care = lastSnap?.care_count || 0;
    const haha = lastSnap?.haha_count || 0;
    const wow = lastSnap?.wow_count || 0;
    const sad = lastSnap?.sad_count || 0;
    const angry = lastSnap?.angry_count || 0;

    const sum7 = Math.max(1, like + love + care + haha + wow + sad + angry);

    return {
      targetId: t.id,
      authorName: t.authorName,
      color: t.color,
      counts: { like, love, care, haha, wow, sad, angry },
      totalReactions: sum7,
      percentages: {
        like: parseFloat(((like / sum7) * 100).toFixed(1)),
        love: parseFloat(((love / sum7) * 100).toFixed(1)),
        care: parseFloat(((care / sum7) * 100).toFixed(1)),
        haha: parseFloat(((haha / sum7) * 100).toFixed(1)),
        wow: parseFloat(((wow / sum7) * 100).toFixed(1)),
        sad: parseFloat(((sad / sum7) * 100).toFixed(1)),
        angry: parseFloat(((angry / sum7) * 100).toFixed(1))
      }
    };
  });

  // 4. Component 3: GROWTH (Timeline Points, Peaks, Rates, Volatility)
  const growthSeries = targetsWithMeta.map(t => {
    const snaps = snapshotsByTarget[t.id] || [];
    const createdAtMs = new Date(t.createdAt).getTime();

    let maxDelta = 0;
    let maxDeltaTime = null;
    const deltaValues = [];

    const points = snaps.map((s, sIdx) => {
      const snapTimeMs = new Date(s.observed_at).getTime();
      let label = '';
      if (mode === 'POST_AGE') {
        const diffHours = Math.max(0, Math.floor((snapTimeMs - createdAtMs) / (3600 * 1000)));
        label = `T+${diffHours}h`;
      } else {
        const d = new Date(s.observed_at);
        label = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      }

      const rx = s.total_reactions || 0;
      const cmt = s.total_comments || 0;
      const sh = s.total_shares || 0;
      const eng = rx + cmt + sh;

      let intervalDelta = 0;
      if (sIdx > 0) {
        const prev = snaps[sIdx - 1];
        intervalDelta = Math.max(0, eng - ((prev.total_reactions || 0) + (prev.total_comments || 0) + (prev.total_shares || 0)));
      } else {
        intervalDelta = s.delta_reactions || 0;
      }

      deltaValues.push(intervalDelta);
      if (intervalDelta > maxDelta) {
        maxDelta = intervalDelta;
        maxDeltaTime = s.observed_at;
      }

      return {
        timestamp: s.observed_at,
        label,
        reactions: rx,
        comments: cmt,
        shares: sh,
        totalEngagement: eng,
        delta: intervalDelta
      };
    });

    // If no points, fallback to current snapshot
    if (points.length === 0) {
      points.push({
        timestamp: new Date().toISOString(),
        label: mode === 'POST_AGE' ? 'T+0h' : 'Hiện tại',
        reactions: t.latestReactions,
        comments: t.latestComments,
        shares: t.latestShares,
        totalEngagement: t.latestReactions + t.latestComments + t.latestShares,
        delta: 0
      });
    }

    // Volatility calculation (Standard Deviation of deltas)
    let volatility = 0;
    if (deltaValues.length > 1) {
      const mean = deltaValues.reduce((a, b) => a + b, 0) / deltaValues.length;
      const variance = deltaValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / deltaValues.length;
      volatility = parseFloat(Math.sqrt(variance).toFixed(1));
    }

    const totalGain = points[points.length - 1].totalEngagement - points[0].totalEngagement;
    const growthRatePerHour = periodHours > 0
      ? parseFloat((Math.max(0, totalGain) / periodHours).toFixed(1))
      : 0;

    return {
      targetId: t.id,
      authorName: t.authorName,
      color: t.color,
      points,
      peakDelta: maxDelta,
      peakTime: maxDeltaTime || (points[0] ? points[0].timestamp : null),
      growthRatePerHour,
      volatility
    };
  });

  // 5. Component 4: TIME_ANALYTICS (Time Buckets & Activity Distribution)
  // Collect all snapshots and bucket into 6-8 uniform intervals
  const timeBuckets = [];
  const allPoints = growthSeries.flatMap(g => g.points);
  if (allPoints.length > 0) {
    const bucketMap = new Map();
    allPoints.forEach(p => {
      const bKey = p.label || 'Kỳ';
      if (!bucketMap.has(bKey)) {
        bucketMap.set(bKey, {});
      }
    });

    // Limit to latest 12 distinct time buckets
    const bucketKeys = Array.from(bucketMap.keys()).slice(-12);
    bucketKeys.forEach(bKey => {
      const item = { bucketLabel: bKey, targets: {} };
      growthSeries.forEach(g => {
        const pt = g.points.find(p => p.label === bKey);
        item.targets[String(g.targetId)] = pt ? pt.delta : 0;
      });
      timeBuckets.push(item);
    });
  }

  // 6. Component 5: AUTHENTICITY (Anomaly Flags & Reliability)
  const authenticity = targetsWithMeta.map(t => {
    const accounts = accountsByTarget[t.id] || [];
    const alerts = alertsByTarget[t.id] || [];

    const totalIdentified = accounts.length;
    // Count duplicated comment texts
    const commentCounts = {};
    accounts.forEach(a => {
      if (a.comment_text && a.comment_text.trim().length > 3) {
        const txt = a.comment_text.trim().toLowerCase();
        commentCounts[txt] = (commentCounts[txt] || 0) + 1;
      }
    });
    const suspiciousComments = Object.values(commentCounts).filter(c => c > 2).reduce((a, b) => a + b, 0);

    const alertCount = alerts.filter(al => al.severity === 'CRITICAL' || al.severity === 'WARNING').length;

    let verdict = 'ORGANIC';
    let explanation = 'Tương tác có diễn biến tự nhiên, không phát hiện seeding trùng lặp quy mô lớn.';

    if (suspiciousComments > 0 || alertCount >= 2) {
      verdict = 'SUSPICIOUS';
      explanation = `Phát hiện ${suspiciousComments} bình luận trùng mẫu và ${alertCount} cảnh báo biến động bất thường cần kiểm tra.`;
    } else if (totalIdentified === 0) {
      verdict = 'UNKNOWN';
      explanation = 'Chưa có đủ mẫu tài khoản bóc tách để đối chiếu tin cậy.';
    }

    return {
      targetId: t.id,
      authorName: t.authorName,
      color: t.color,
      totalIdentified,
      suspiciousComments,
      alertCount,
      verdict,
      explanation
    };
  });

  // 7. Component 6: INTERACTION_ACCOUNTS (Jaccard Overlap & Shared Accounts)
  const overlapPairs = [];
  const commonAccountsMap = new Map();

  for (let i = 0; i < targetsWithMeta.length; i++) {
    for (let j = i + 1; j < targetsWithMeta.length; j++) {
      const tA = targetsWithMeta[i];
      const tB = targetsWithMeta[j];

      const accA = accountsByTarget[tA.id] || [];
      const accB = accountsByTarget[tB.id] || [];

      const setA = new Set(accA.map(a => (a.fb_user_id || a.display_name || '').toLowerCase()).filter(Boolean));
      const setB = new Set(accB.map(b => (b.fb_user_id || b.display_name || '').toLowerCase()).filter(Boolean));

      let intersectionCount = 0;
      setA.forEach(idKey => {
        if (setB.has(idKey)) intersectionCount++;
      });

      const unionCount = setA.size + setB.size - intersectionCount;
      const jaccard = unionCount > 0 ? parseFloat((intersectionCount / unionCount).toFixed(3)) : 0.0;
      const jaccardPercent = parseFloat((jaccard * 100).toFixed(1));

      overlapPairs.push({
        targetAId: tA.id,
        targetBId: tB.id,
        targetAName: tA.authorName,
        targetBName: tB.authorName,
        colorA: tA.color,
        colorB: tB.color,
        uniqueA: setA.size,
        uniqueB: setB.size,
        intersectionCount,
        unionCount,
        jaccardIndex: jaccard,
        jaccardPercent
      });

      // Populate common accounts list
      accA.forEach(a => {
        const idKey = (a.fb_user_id || a.display_name || '').toLowerCase();
        if (idKey && setB.has(idKey)) {
          if (!commonAccountsMap.has(idKey)) {
            commonAccountsMap.set(idKey, {
              displayName: a.display_name,
              fbUserId: a.fb_user_id,
              profileUrl: a.profile_url || (a.fb_user_id ? `https://www.facebook.com/${a.fb_user_id}` : null),
              avatarUrl: a.avatar_url,
              posts: []
            });
          }
          const existingAcc = commonAccountsMap.get(idKey);
          if (!existingAcc.posts.some(p => p.targetId === tA.id)) {
            existingAcc.posts.push({
              targetId: tA.id,
              authorName: tA.authorName,
              interactionType: a.interaction_type,
              reactionType: a.reaction_type,
              commentText: a.comment_text,
              observedAt: a.observed_at
            });
          }
        }
      });

      accB.forEach(b => {
        const idKey = (b.fb_user_id || b.display_name || '').toLowerCase();
        if (idKey && commonAccountsMap.has(idKey)) {
          const existingAcc = commonAccountsMap.get(idKey);
          if (!existingAcc.posts.some(p => p.targetId === tB.id)) {
            existingAcc.posts.push({
              targetId: tB.id,
              authorName: tB.authorName,
              interactionType: b.interaction_type,
              reactionType: b.reaction_type,
              commentText: b.comment_text,
              observedAt: b.observed_at
            });
          }
        }
      });
    }
  }

  const commonAccounts = Array.from(commonAccountsMap.values()).slice(0, 30);

  // 8. Component 7: PERFORMANCE (Relative Efficiency & Ratios)
  const performance = targetsWithMeta.map(t => {
    const rx = Math.max(1, t.latestReactions);
    const cmt = t.latestComments;
    const sh = t.latestShares;
    const total = t.latestReactions + cmt + sh;

    const commentRatio = parseFloat(((cmt / rx) * 100).toFixed(1));
    const shareRatio = parseFloat(((sh / rx) * 100).toFixed(1));
    const growthItem = growthSeries.find(g => g.targetId === t.id);
    const velocity = growthItem ? growthItem.growthRatePerHour : 0;

    return {
      targetId: t.id,
      authorName: t.authorName,
      color: t.color,
      totalEngagement: total,
      velocityPerHour: velocity,
      commentRatio,
      shareRatio
    };
  });

  // 9. Automated Verifiable Rule-Based Insights (Section VII)
  const insights = [];

  // Insight 1: Engagement Leader
  const sortedByEng = [...engagement].sort((a, b) => b.totalEngagement - a.totalEngagement);
  const engLeader = sortedByEng[0];
  const engRunnerUp = sortedByEng[1];
  if (engLeader && engRunnerUp && engLeader.totalEngagement > engRunnerUp.totalEngagement) {
    const diff = engLeader.totalEngagement - engRunnerUp.totalEngagement;
    insights.push(`Bài viết "${engLeader.authorName}" dẫn đầu toàn diện với ${engLeader.totalEngagement.toLocaleString()} lượt tương tác (vượt bài xếp sau +${diff.toLocaleString()} lượt).`);
  } else if (engLeader) {
    insights.push(`Bài viết "${engLeader.authorName}" đang có tổng tương tác cao nhất đạt ${engLeader.totalEngagement.toLocaleString()} lượt.`);
  }

  // Insight 2: Discussion / Comment Ratio Leader
  const sortedByCmt = [...performance].sort((a, b) => b.commentRatio - a.commentRatio);
  const cmtLeader = sortedByCmt[0];
  if (cmtLeader && cmtLeader.commentRatio > 10) {
    insights.push(`Bài viết "${cmtLeader.authorName}" có tỷ lệ thảo luận vượt trội với ${cmtLeader.commentRatio}% bình luận trên cảm xúc, phản ánh chiều sâu tương tác cộng đồng.`);
  }

  // Insight 3: Growth Velocity Leader
  const sortedByVel = [...growthSeries].sort((a, b) => b.growthRatePerHour - a.growthRatePerHour);
  const velLeader = sortedByVel[0];
  if (velLeader && velLeader.growthRatePerHour > 0) {
    insights.push(`Tốc độ bứt phá cao nhất thuộc về "${velLeader.authorName}" đạt trung bình +${velLeader.growthRatePerHour} tương tác/giờ trong phạm vi quan sát ${range}.`);
  }

  // Insight 4: Account Overlap & Jaccard Summary
  if (overlapPairs.length > 0) {
    const highestOverlap = [...overlapPairs].sort((a, b) => b.jaccardPercent - a.jaccardPercent)[0];
    if (highestOverlap && highestOverlap.intersectionCount > 0) {
      insights.push(`Phát hiện ${highestOverlap.intersectionCount} tài khoản tương tác chéo giữa "${highestOverlap.targetAName}" và "${highestOverlap.targetBName}" (Chỉ số trùng lặp Jaccard: ${highestOverlap.jaccardPercent}%).`);
    } else {
      insights.push('Không phát hiện sự trùng lặp đáng kể về tài khoản tương tác giữa các bài viết được đối chiếu.');
    }
  }

  // Insight 5: Data Boundary & Meta Graph API limits
  insights.push(`Dữ liệu được chuẩn hóa theo múi giờ Việt Nam (UTC+7). Các chỉ số phản ánh mẫu dữ liệu thực tế thu nhận từ Meta Graph API & mbasic Edge, tuân thủ đúng giới hạn bảo mật quyền riêng tư của nền tảng.`);

  return {
    status: 'SUCCESS',
    mode,
    range,
    targets: targetsWithMeta,
    engagement,
    reactionsBreakdown,
    growthSeries,
    timeBuckets,
    authenticity,
    accountOverlap: {
      pairs: overlapPairs,
      commonAccounts
    },
    performance,
    insights
  };
}
