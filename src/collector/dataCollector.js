const accountManager = require('../auth/accountManager');
const config = require('../config');

class DataCollector {
  /**
   * Fetch interaction data for a given target.
   * Uses live Meta Graph API if a valid token is present; otherwise transparently
   * falls back to the labeled developer simulation mode if enabled.
   */
  async collect(target) {
    const accountInfo = accountManager.findEligibleAccountForTarget(target);
    const observedAt = new Date().toISOString();

    if (accountInfo && accountInfo.token) {
      try {
        const liveResult = await this.fetchFromMetaGraphApi(target, accountInfo.token);
        accountManager.recordSyncSuccess(accountInfo.accountId);
        return {
          ...liveResult,
          sourceType: 'GRAPH_API',
          observedAt
        };
      } catch (err) {
        const isAuth = err.isAuthError || false;
        accountManager.recordSyncError(accountInfo.accountId, err.message, isAuth);
        // If live API fails, throw to let the scheduler handle retry
        throw err;
      }
    }

    // If no Meta token is bound/available
    if (config.enableDevSimulator) {
      return this.generateSimulatedMetrics(target, observedAt);
    }

    throw new Error('Chưa có tài khoản Facebook / Meta được cấp quyền phù hợp để đồng bộ.');
  }

  /**
   * Meta Graph API live query
   */
  async fetchFromMetaGraphApi(target, token) {
    const version = config.meta.graphVersion;
    const contentId = target.content_id;
    if (!contentId) {
      throw new Error('Không xác định được ID nội dung Facebook');
    }

    // Graph API fields query for post metrics
    const fields = [
      'id', 'created_time', 'message', 'from',
      'reactions.summary(total_count).as(all_reactions)',
      'reactions.type(LIKE).summary(total_count).as(rx_likes)',
      'reactions.type(LOVE).summary(total_count).as(rx_loves)',
      'reactions.type(CARE).summary(total_count).as(rx_cares)',
      'reactions.type(HAHA).summary(total_count).as(rx_hahas)',
      'reactions.type(WOW).summary(total_count).as(rx_wows)',
      'reactions.type(SAD).summary(total_count).as(rx_sads)',
      'reactions.type(ANGRY).summary(total_count).as(rx_angrys)',
      'comments.summary(total_count).limit(25){id,created_time,message,from{id,name,picture}}',
      'shares'
    ].join(',');

    const url = `https://graph.facebook.com/${version}/${contentId}?fields=${encodeURIComponent(fields)}&access_token=${token}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      const err = new Error(`Meta Graph API Error [${data.error.code}]: ${data.error.message}`);
      if (data.error.code === 190 || data.error.error_subcode === 463) {
        err.isAuthError = true;
      }
      throw err;
    }

    const totalReactions = data.all_reactions?.summary?.total_count || 0;
    const likeCount = data.rx_likes?.summary?.total_count || 0;
    const loveCount = data.rx_loves?.summary?.total_count || 0;
    const careCount = data.rx_cares?.summary?.total_count || 0;
    const hahaCount = data.rx_hahas?.summary?.total_count || 0;
    const wowCount = data.rx_wows?.summary?.total_count || 0;
    const sadCount = data.rx_sads?.summary?.total_count || 0;
    const angryCount = data.rx_angrys?.summary?.total_count || 0;

    const totalComments = data.comments?.summary?.total_count || 0;
    const totalShares = data.shares?.count || 0;

    const commentsList = (data.comments?.data || []).map(c => ({
      fbUserId: c.from?.id || null,
      displayName: c.from?.name || 'Người dùng Facebook',
      avatarUrl: c.from?.picture?.data?.url || '',
      profileUrl: c.from?.id ? `https://facebook.com/${c.from.id}` : null,
      commentText: c.message || '',
      observedAt: new Date().toISOString(),
      actualTimestamp: c.created_time || null,
      dataCompleteness: c.from?.id ? 'FULL' : 'PARTIAL'
    }));

    return {
      authorName: data.from?.name || target.author_name || 'Fanpage/Tác giả',
      authorAvatar: data.from?.picture?.data?.url || target.author_avatar || '',
      contentSnippet: data.message ? data.message.slice(0, 150) : target.content_snippet || '',
      postCreatedTime: data.created_time || target.post_created_time || null,
      reactions: {
        total: totalReactions,
        like: likeCount,
        love: loveCount,
        care: careCount,
        haha: hahaCount,
        wow: wowCount,
        sad: sadCount,
        angry: angryCount
      },
      comments: {
        total: totalComments,
        identifiableItems: commentsList
      },
      shares: {
        total: totalShares,
        identifiableAccountsCount: 0 // Meta Graph API restricts personal share profiles
      },
      raw: data
    };
  }

  /**
   * Transparent developer simulation for offline development or sandbox testing
   */
  generateSimulatedMetrics(target, observedAt) {
    const prevReactions = target.latest_reactions || target.baseline_reactions || Math.floor(Math.random() * 200) + 50;
    const prevComments = target.latest_comments || target.baseline_comments || Math.floor(Math.random() * 30) + 10;
    const prevShares = target.latest_shares || target.baseline_shares || Math.floor(Math.random() * 15) + 2;

    // Realistic organic increment
    const addReactions = Math.floor(Math.random() * 8) + 1;
    const addComments = Math.random() > 0.4 ? Math.floor(Math.random() * 3) : 0;
    const addShares = Math.random() > 0.7 ? 1 : 0;

    const totalReactions = prevReactions + addReactions;
    const totalComments = prevComments + addComments;
    const totalShares = prevShares + addShares;

    // Distribute reactions across the 7 types
    const like = Math.round(totalReactions * 0.62);
    const love = Math.round(totalReactions * 0.22);
    const haha = Math.round(totalReactions * 0.08);
    const care = Math.round(totalReactions * 0.04);
    const wow = Math.round(totalReactions * 0.02);
    const sad = Math.round(totalReactions * 0.01);
    const angry = Math.max(0, totalReactions - (like + love + haha + care + wow + sad));

    const sampleUsers = [
      { name: 'Nguyễn Văn Minh', avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&h=100&fit=crop' },
      { name: 'Trần Thị Thu Hà', avatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&h=100&fit=crop' },
      { name: 'Lê Hoàng Nam', avatar: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=100&h=100&fit=crop' },
      { name: 'Phạm Quỳnh Anh', avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100&h=100&fit=crop' }
    ];

    const commentsList = [];
    if (addComments > 0) {
      for (let i = 0; i < addComments; i++) {
        const u = sampleUsers[Math.floor(Math.random() * sampleUsers.length)];
        commentsList.push({
          fbUserId: 'sim_' + Math.floor(Math.random() * 100000),
          displayName: u.name,
          avatarUrl: u.avatar,
          profileUrl: 'https://facebook.com/profile.php?id=' + Math.floor(Math.random() * 100000),
          commentText: ['Bài viết rất hữu ích!', 'Quan tâm ạ', 'Nội dung phân tích rất sắc bén', 'Cảm ơn ad đã chia sẻ'][Math.floor(Math.random() * 4)],
          observedAt,
          actualTimestamp: new Date(Date.now() - Math.floor(Math.random() * 60000)).toISOString(),
          dataCompleteness: 'PARTIAL'
        });
      }
    }

    return {
      authorName: target.author_name || 'Facebook Creator / Page',
      authorAvatar: target.author_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100&h=100&fit=crop',
      contentSnippet: target.content_snippet || 'Bản tin cập nhật số liệu và xu hướng tương tác nội dung trực tuyến...',
      postCreatedTime: target.post_created_time || new Date(Date.now() - 3600000 * 24).toISOString(),
      reactions: {
        total: totalReactions,
        like,
        love,
        care,
        haha,
        wow,
        sad,
        angry
      },
      comments: {
        total: totalComments,
        identifiableItems: commentsList
      },
      shares: {
        total: totalShares,
        identifiableAccountsCount: 0
      },
      sourceType: 'SIMULATION',
      observedAt,
      raw: { simulated: true, note: 'Nhãn mô phỏng kiểm thử theo quy tắc minh bạch nguồn dữ liệu' }
    };
  }
}

module.exports = new DataCollector();
