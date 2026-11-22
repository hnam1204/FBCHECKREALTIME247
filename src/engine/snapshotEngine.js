const { getDb } = require('../db/database');

class SnapshotEngine {
  constructor() {
    this.db = getDb();
  }

  /**
   * Save a newly collected snapshot, compute deltas & velocity rates, and update target metrics
   */
  processNewSnapshot(targetId, collectedData) {
    const now = collectedData.observedAt || new Date().toISOString();
    const nowMs = new Date(now).getTime();

    // 1. Fetch latest existing snapshot for baseline / diffing
    const lastSnapshot = this.db.prepare(`
      SELECT * FROM snapshots 
      WHERE target_id = ? 
      ORDER BY observed_at DESC 
      LIMIT 1
    `).get(targetId);

    const prevReactions = lastSnapshot ? lastSnapshot.total_reactions : collectedData.reactions.total;
    const prevComments = lastSnapshot ? lastSnapshot.total_comments : collectedData.comments.total;
    const prevShares = lastSnapshot ? lastSnapshot.total_shares : collectedData.shares.total;

    const deltaReactions = collectedData.reactions.total - prevReactions;
    const deltaComments = collectedData.comments.total - prevComments;
    const deltaShares = collectedData.shares.total - prevShares;

    // 2. Compute historical growth rates (5m, 1h, 24h)
    const rate5m = this.calculateGrowthRate(targetId, nowMs - (5 * 60 * 1000), collectedData.reactions.total);
    const rate1h = this.calculateGrowthRate(targetId, nowMs - (60 * 60 * 1000), collectedData.reactions.total);
    const rate24h = this.calculateGrowthRate(targetId, nowMs - (24 * 60 * 60 * 1000), collectedData.reactions.total);

    // 3. Save snapshot record
    const insertSnapshot = this.db.prepare(`
      INSERT INTO snapshots (
        target_id, observed_at, source_type,
        total_reactions, like_count, love_count, care_count, haha_count, wow_count, sad_count, angry_count,
        total_comments, total_shares,
        delta_reactions, delta_comments, delta_shares,
        growth_rate_5m, growth_rate_1h, growth_rate_24h, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const rawJson = collectedData.raw ? JSON.stringify(collectedData.raw) : '{}';

    const info = insertSnapshot.run(
      targetId, now, collectedData.sourceType || 'GRAPH_API',
      collectedData.reactions.total,
      collectedData.reactions.like || 0,
      collectedData.reactions.love || 0,
      collectedData.reactions.care || 0,
      collectedData.reactions.haha || 0,
      collectedData.reactions.wow || 0,
      collectedData.reactions.sad || 0,
      collectedData.reactions.angry || 0,
      collectedData.comments.total,
      collectedData.shares.total,
      deltaReactions, deltaComments, deltaShares,
      rate5m, rate1h, rate24h, rawJson
    );

    const snapshotId = Number(info.lastInsertRowid);

    // 4. Update target record with latest numbers and baseline
    const target = this.db.prepare('SELECT * FROM monitored_targets WHERE id = ?').get(targetId);

    const isFirstRun = !lastSnapshot;
    const baselineReactions = isFirstRun ? collectedData.reactions.total : target.baseline_reactions;
    const baselineComments = isFirstRun ? collectedData.comments.total : target.baseline_comments;
    const baselineShares = isFirstRun ? collectedData.shares.total : target.baseline_shares;

    this.db.prepare(`
      UPDATE monitored_targets
      SET author_name = COALESCE(?, author_name),
          author_avatar = COALESCE(?, author_avatar),
          content_snippet = COALESCE(?, content_snippet),
          post_created_time = COALESCE(?, post_created_time),
          latest_reactions = ?,
          latest_comments = ?,
          latest_shares = ?,
          baseline_reactions = ?,
          baseline_comments = ?,
          baseline_shares = ?,
          last_checked_at = ?,
          last_error = NULL,
          retry_count = 0,
          status = 'ACTIVE'
      WHERE id = ?
    `).run(
      collectedData.authorName || null,
      collectedData.authorAvatar || null,
      collectedData.contentSnippet || null,
      collectedData.postCreatedTime || null,
      collectedData.reactions.total,
      collectedData.comments.total,
      collectedData.shares.total,
      baselineReactions,
      baselineComments,
      baselineShares,
      now,
      targetId
    );

    // 5. Store identifiable interactive accounts (Section 6)
    if (collectedData.comments && Array.isArray(collectedData.comments.identifiableItems)) {
      const insertInteracted = this.db.prepare(`
        INSERT INTO accounts_interacted (
          target_id, fb_user_id, display_name, profile_url, avatar_url,
          interaction_type, reaction_type, comment_text, observed_at, data_completeness
        ) VALUES (?, ?, ?, ?, ?, 'comment', NULL, ?, ?, ?)
      `);

      for (const item of collectedData.comments.identifiableItems) {
        insertInteracted.run(
          targetId,
          item.fbUserId || null,
          item.displayName || 'Người dùng Facebook',
          item.profileUrl || null,
          item.avatarUrl || null,
          item.commentText || '',
          item.observedAt || now,
          item.dataCompleteness || 'PARTIAL'
        );
      }
    }

    return {
      snapshotId,
      targetId,
      observedAt: now,
      totalReactions: collectedData.reactions.total,
      totalComments: collectedData.comments.total,
      totalShares: collectedData.shares.total,
      deltas: {
        reactions: deltaReactions,
        comments: deltaComments,
        shares: deltaShares
      },
      growthRates: {
        rate5m,
        rate1h,
        rate24h
      },
      isFirstRun
    };
  }

  /**
   * Calculate percentage growth rate between current total and value at cutoff timestamp
   */
  calculateGrowthRate(targetId, cutoffMs, currentTotal) {
    const cutoffIso = new Date(cutoffMs).toISOString();
    const pastRecord = this.db.prepare(`
      SELECT total_reactions 
      FROM snapshots 
      WHERE target_id = ? AND observed_at <= ?
      ORDER BY observed_at DESC 
      LIMIT 1
    `).get(targetId, cutoffIso);

    if (!pastRecord || pastRecord.total_reactions === 0) return 0;
    const diff = currentTotal - pastRecord.total_reactions;
    return parseFloat(((diff / pastRecord.total_reactions) * 100).toFixed(2));
  }
}

module.exports = new SnapshotEngine();
