/**
 * Facebook mbasic & Comet HTML parser and metrics extractor for 3rd-party public targets.
 * Works natively in both Node.js and Cloudflare Workers (pure regex & string operations).
 */

/**
 * Extracts c_user numeric ID from a cookie string
 * @param {string} cookie
 * @returns {string|null}
 */
export function extractCUser(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const match = cookie.match(/(?:^|;\s*)c_user=(\d+)/);
  return match ? match[1] : null;
}

/**
 * Checks if the request was redirected to login or checkpoint
 * @param {string} currentUrl
 * @param {string} html
 * @returns {boolean}
 */
export function isCheckpointOrLogin(currentUrl, html) {
  if (!currentUrl && !html) return false;
  const urlLower = (currentUrl || '').toLowerCase();
  if (urlLower.includes('/checkpoint/') || urlLower.includes('/login.php') || urlLower.includes('checkpoint')) {
    return true;
  }
  const htmlLower = (html || '').toLowerCase();
  if (htmlLower.includes('id="login_form"') || htmlLower.includes('name="login"') || htmlLower.includes('name="email"')) {
    if (htmlLower.includes('type="password"')) {
      return true;
    }
  }
  return false;
}

/**
 * Cleans numerical string like "1,234", "1.234", "12K", "1.5M" into an integer
 * @param {string} str
 * @returns {number}
 */
export function parseCount(str) {
  if (!str) return 0;
  const clean = str.trim().toUpperCase();
  if (clean.endsWith('K')) {
    const n = parseFloat(clean.replace(/,/g, '.').slice(0, -1));
    return Math.round(n * 1000);
  }
  if (clean.endsWith('M')) {
    const n = parseFloat(clean.replace(/,/g, '.').slice(0, -1));
    return Math.round(n * 1000000);
  }
  const digits = clean.replace(/[^\d]/g, '');
  return parseInt(digits || '0', 10);
}

/**
 * Parses Facebook HTML page (supports both Comet React JSON blobs and mbasic HTML)
 * @param {string} html
 * @returns {{
 *   totalReactions: number,
 *   reactions: { like: number, love: number, care: number, haha: number, wow: number, sad: number, angry: number },
 *   totalComments: number,
 *   totalShares: number,
 *   authorName: string|null,
 *   authorAvatar: string|null,
 *   postImage: string|null,
 *   contentSnippet: string|null,
 *   reactionsBrowserUrl: string|null
 * }}
 */
export function parseMbasicHtml(html) {
  if (!html || typeof html !== 'string') {
    return {
      totalReactions: 0,
      reactions: { like: 0, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 },
      totalComments: 0,
      totalShares: 0,
      authorName: null,
      authorAvatar: null,
      postImage: null,
      contentSnippet: null,
      reactionsBrowserUrl: null
    };
  }

  let totalReactions = 0;
  let totalComments = 0;
  let totalShares = 0;
  let reactions = { like: 0, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
  let authorName = null;
  let authorAvatar = null;
  let postImage = null;
  let contentSnippet = null;
  let reactionsBrowserUrl = null;

  // Extract author from title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].replace(/\s*\|\s*Facebook$/i, '').trim();
    if (t && !t.includes('Facebook') && !t.includes('Error') && !t.includes('Đăng nhập') && !t.includes('Log in')) {
      authorName = t;
    }
  }

  // --- Extract Media & Avatars (og:image & Facebook CDN) ---
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) {
    const clean = ogMatch[1].replace(/&amp;/g, '&').replace(/\\/g, '');
    if (!clean.includes('static.xx.fbcdn.net/rsrc.php')) {
      postImage = clean;
    }
  }
  if (!postImage) {
    const cometMediaMatch = html.match(/"preferred_thumbnail"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/i)
      || html.match(/"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/i);
    if (cometMediaMatch) {
      const clean = cometMediaMatch[1].replace(/&amp;/g, '&').replace(/\\/g, '');
      if (clean.startsWith('http') && !clean.includes('static.xx.fbcdn.net/rsrc.php')) {
        postImage = clean;
      }
    }
  }

  const profMatch = html.match(/https:\/\/scontent[^"'\s\\]*(?:t1\.30497-1|t39\.30808-1)[^"'\s\\]*/i);
  if (profMatch) {
    authorAvatar = profMatch[0].replace(/&amp;/g, '&').replace(/\\/g, '');
  }
  if (!authorAvatar) {
    const cometProfPic = html.match(/"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/i)
      || html.match(/"profile_photo"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"/i)
      || html.match(/"profile_picture_uri"\s*:\s*"([^"]+)"/i);
    if (cometProfPic) {
      authorAvatar = cometProfPic[1].replace(/&amp;/g, '&').replace(/\\/g, '');
    }
  }
  if (!authorAvatar && postImage) {
    authorAvatar = postImage;
  }

  // --- ENGINE 1: Embedded Comet JSON Blobs (High-Precision React Store) ---
  const rxJson = html.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i) || html.match(/"i18n_reaction_count"\s*:\s*"(\d+)"/i);
  const cmtJson = html.match(/"comments"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i) || html.match(/"total_comment_count"\s*:\s*(\d+)/i) || html.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/i);
  const shJson = html.match(/"share_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/i) || html.match(/"i18n_share_count"\s*:\s*"(\d+)"/i);

  if (rxJson || cmtJson || shJson) {
    totalReactions = rxJson ? parseInt(rxJson[1], 10) : 0;
    totalComments = cmtJson ? parseInt(cmtJson[1], 10) : 0;
    totalShares = shJson ? parseInt(shJson[1], 10) : 0;

    const msgMatch = html.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"\}/);
    if (msgMatch) {
      try {
        contentSnippet = JSON.parse(`"${msgMatch[1]}"`).slice(0, 200);
      } catch {
        contentSnippet = msgMatch[1].slice(0, 200);
      }
    }

    // Parse top_reactions breakdown if available
    const topRxSection = html.match(/"top_reactions"\s*:\s*\{\s*"count"\s*:\s*\d+,\s*"edges"\s*:\s*(\[[^\]]+\])\}/);
    if (topRxSection) {
      try {
        const edges = JSON.parse(topRxSection[1]);
        for (const e of edges) {
          const name = (e.node?.localized_name || '').toLowerCase();
          const count = e.reaction_count || (e.i18n_reaction_count ? parseInt(e.i18n_reaction_count, 10) : 0);
          if (name.includes('thích') || name.includes('like')) reactions.like = count;
          else if (name.includes('yêu') || name.includes('love')) reactions.love = count;
          else if (name.includes('thương') || name.includes('care')) reactions.care = count;
          else if (name.includes('haha')) reactions.haha = count;
          else if (name.includes('wow')) reactions.wow = count;
          else if (name.includes('buồn') || name.includes('sad')) reactions.sad = count;
          else if (name.includes('phẫn') || name.includes('angry')) reactions.angry = count;
        }
      } catch (e) {
        // Fallback
        reactions.like = totalReactions;
      }
    } else {
      reactions.like = totalReactions;
    }

    return {
      totalReactions,
      reactions,
      totalComments,
      totalShares,
      authorName,
      authorAvatar,
      postImage,
      contentSnippet,
      reactionsBrowserUrl: null,
      comments: parseComments(html),
      reactors: parseReactors(html)
    };
  }

  // --- ENGINE 2: Classic mbasic HTML Regex (When served plain mbasic without Comet) ---
  const rxLinkMatch = html.match(/href="(\/ufi\/reaction\/profile\/browser\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (rxLinkMatch) {
    reactionsBrowserUrl = rxLinkMatch[1].replace(/&amp;/g, '&');
    const rawText = rxLinkMatch[2].replace(/<[^>]+>/g, '').trim();
    if (rawText.includes('Bạn và') || rawText.includes('You and')) {
      const match = rawText.match(/(\d[\d.,]*)/);
      totalReactions = (match ? parseCount(match[1]) : 0) + 1;
    } else {
      const match = rawText.match(/(\d[\d.,]*)/);
      totalReactions = match ? parseCount(match[1]) : 0;
    }
  } else {
    const fallbackMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:người khác|người|lượt thích|thích|reactions|likes)/i);
    if (fallbackMatch) {
      totalReactions = parseCount(fallbackMatch[1]);
    }
  }

  const cmtMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:bình luận|bình luận trước|comments)/i)
    || html.match(/href="[^"]*\/mbasic\/comment\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (cmtMatch) {
    const rawText = cmtMatch[1].replace(/<[^>]+>/g, '').trim();
    const countMatch = rawText.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    if (countMatch) totalComments = parseCount(countMatch[1]);
  }

  const shareMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:lượt chia sẻ|lượt chia sẽ|chia sẻ|shares)/i)
    || html.match(/href="[^"]*\/shares\/view\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (shareMatch) {
    const rawText = shareMatch[1].replace(/<[^>]+>/g, '').trim();
    const countMatch = rawText.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    if (countMatch) totalShares = parseCount(countMatch[1]);
  }

  if (!authorName) {
    const actorMatch = html.match(/<h3[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)
      || html.match(/<strong[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/strong>/i);
    if (actorMatch) {
      authorName = actorMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  const pMatch = html.match(/<div[^>]*data-ft="[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (pMatch) {
    const text = pMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 5) contentSnippet = text.slice(0, 200);
  }

  reactions.like = totalReactions;

  return {
    totalReactions,
    reactions,
    totalComments,
    totalShares,
    authorName,
    authorAvatar,
    postImage,
    contentSnippet,
    reactionsBrowserUrl,
    comments: parseComments(html),
    reactors: []
  };
}

/**
 * Extracts list of comments and commenters from HTML (supports Comet JSON store & mbasic HTML)
 * @param {string} html
 * @returns {Array<{displayName: string, fbUserId: string|null, profileUrl: string|null, avatarUrl: string|null, commentText: string, interactionType: string}>}
 */
export function parseComments(html) {
  const comments = [];
  if (!html || typeof html !== 'string') return comments;

  // 1. Comet React Store Comments: match "body":{"text":"..."} blocks
  const cometRegex = /"body"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"\}[\s\S]{1,400}?"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"(?:[^}]*?"id"\s*:\s*"([^"]+)")?(?:[\s\S]{0,200}?"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"\})?/gi;
  for (const m of html.matchAll(cometRegex)) {
    try {
      const text = JSON.parse(`"${m[1]}"`);
      const name = JSON.parse(`"${m[2]}"`);
      const id = m[3] || null;
      let pic = m[4] ? m[4].replace(/\\/g, '') : null;
      if (!pic && id) pic = `https://graph.facebook.com/${id}/picture?type=normal`;
      if (name && text) {
        comments.push({
          displayName: name,
          fbUserId: id,
          profileUrl: id ? `https://www.facebook.com/${id}` : null,
          avatarUrl: pic,
          commentText: text,
          interactionType: 'COMMENT'
        });
      }
    } catch {}
    if (comments.length >= 20) break;
  }

  // Check reverse Comet ordering
  if (comments.length === 0) {
    const revRegex = /"author"\s*:\s*\{[^}]*?"name"\s*:\s*"([^"]+)"(?:[^}]*?"id"\s*:\s*"([^"]+)")?[^}]*(?:"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"\})?[^}]*\}[\s\S]{1,400}?"body"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"\}/gi;
    for (const m of html.matchAll(revRegex)) {
      try {
        const name = JSON.parse(`"${m[1]}"`);
        const id = m[2] || null;
        let pic = m[3] ? m[3].replace(/\\/g, '') : null;
        if (!pic && id) pic = `https://graph.facebook.com/${id}/picture?type=normal`;
        const text = JSON.parse(`"${m[4]}"`);
        if (name && text) {
          comments.push({
            displayName: name,
            fbUserId: id,
            profileUrl: id ? `https://www.facebook.com/${id}` : null,
            avatarUrl: pic,
            commentText: text,
            interactionType: 'COMMENT'
          });
        }
      } catch {}
      if (comments.length >= 20) break;
    }
  }

  // 2. Mobile web / Bloks comments with aria-label & avatar
  if (comments.length === 0) {
    const bloksRegex = /(?:<a[^>]+href=["']([^"']+)["'][^>]*>[\s\S]{0,300}?)?aria-label=["']Ảnh đại diện của ([^"']+)["'][\s\S]{0,600}?<img[^>]+src=["'](https:\/\/scontent[^"'\s\\]*(?:t39\.30808-1|t1\.30497-1)[^"'\s\\]*)["'][\s\S]{0,1400}?<span[^>]*role=["']link["'][^>]*>([\s\S]*?)<\/span>[\s\S]{0,800}?<div dir=["']auto["'][^>]*>([\s\S]*?)<\/div>/gi;
    for (const m of html.matchAll(bloksRegex)) {
      const rawHref = m[1];
      const dName = m[2].trim();
      const pic = m[3].replace(/&amp;/g, '&');
      const text = m[5].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (dName && text && !text.includes('Công khai') && !text.includes('bình luận')) {
        let pUrl = null;
        let fbUid = null;
        if (rawHref) {
          const idM = rawHref.match(/[?&]id=(\d+)/) || rawHref.match(/\/([a-zA-Z0-9.]+)(?:\?|$)/);
          if (idM) fbUid = idM[1];
          pUrl = rawHref.startsWith('http') ? rawHref : `https://www.facebook.com${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;
        }
        comments.push({
          displayName: dName,
          fbUserId: fbUid,
          profileUrl: pUrl,
          avatarUrl: pic,
          commentText: text,
          interactionType: 'COMMENT'
        });
      }
      if (comments.length >= 30) break;
    }
  }

  // 3. Classic mbasic HTML Comments
  if (comments.length === 0) {
    const mbasicRegex = /<h3[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/gi;
    for (const m of html.matchAll(mbasicRegex)) {
      const rawHref = m[1];
      const rawName = m[2].replace(/<[^>]+>/g, '').trim();
      const rawText = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (rawName && rawText && !rawText.includes('bình luận') && !rawText.includes('Thích') && !rawText.includes('Báo cáo')) {
        const idMatch = rawHref.match(/[?&]id=(\d+)/) || rawHref.match(/\/([a-zA-Z0-9.]+)/);
        const fbUserId = idMatch ? idMatch[1] : null;
        comments.push({
          displayName: rawName,
          fbUserId,
          profileUrl: `https://www.facebook.com${rawHref.startsWith('/') ? '' : '/'}${rawHref}`,
          avatarUrl: fbUserId && /^\d+$/.test(fbUserId) ? `https://graph.facebook.com/${fbUserId}/picture?type=normal` : null,
          commentText: rawText,
          interactionType: 'COMMENT'
        });
      }
      if (comments.length >= 20) break;
    }
  }

  return comments;
}

/**
 * Helper to map Facebook reaction names / image alt to standard reaction type
 * Supported 7 reactions: LIKE, LOVE, CARE, HAHA, WOW, SAD, ANGRY
 */
export function mapAltToReactionType(altText, fallback = 'LIKE') {
  if (!altText || typeof altText !== 'string') return fallback;
  const a = altText.toLowerCase();
  if (a.includes('yêu') || a.includes('love') || a.includes('tim')) return 'LOVE';
  if (a.includes('thương') || a.includes('care') || a.includes('ôm')) return 'CARE';
  if (a.includes('haha') || a.includes('cười')) return 'HAHA';
  if (a.includes('wow') || a.includes('ngạc nhiên')) return 'WOW';
  if (a.includes('buồn') || a.includes('sad')) return 'SAD';
  if (a.includes('phẫn nộ') || a.includes('angry') || a.includes('giận')) return 'ANGRY';
  if (a.includes('thích') || a.includes('like')) return 'LIKE';
  return fallback;
}

/**
 * Extracts list of reactors from Comet JSON
 * @param {string} html
 * @returns {Array<{displayName: string, fbUserId: string|null, profileUrl: string|null, avatarUrl: string|null, interactionType: string, reactionType: string, commentText: null}>}
 */
export function parseReactors(html) {
  const reactors = [];
  if (!html || typeof html !== 'string') return reactors;

  // 1. Comet actors / feedback reactors with explicit reaction type
  const cometReactionRegex = /"actors"\s*:\s*\[\s*\{\s*"id"\s*:\s*"([^"]+)",\s*"name"\s*:\s*"([^"]+)"(?:[^}]*?"profile_picture"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"\})?[\s\S]{0,300}?(?:"reaction_type"|"feedback_reaction_info"\s*:\s*\{\s*"key")\s*:\s*"([A-Z]+)"/gi;
  for (const m of html.matchAll(cometReactionRegex)) {
    try {
      const id = m[1];
      const name = JSON.parse(`"${m[2]}"`);
      let pic = m[3] ? m[3].replace(/\\/g, '') : null;
      if (!pic && id) pic = `https://graph.facebook.com/${id}/picture?type=normal`;
      const rawR = (m[4] || '').toUpperCase();
      const rType = ['LIKE', 'LOVE', 'CARE', 'HAHA', 'WOW', 'SAD', 'ANGRY'].includes(rawR) ? rawR : 'LIKE';
      if (name && !reactors.some(r => r.displayName === name)) {
        reactors.push({
          displayName: name,
          fbUserId: id,
          profileUrl: `https://www.facebook.com/${id}`,
          avatarUrl: pic,
          interactionType: 'REACTION',
          reactionType: rType,
          commentText: null
        });
      }
    } catch {}
    if (reactors.length >= 30) break;
  }

  // 2. Fallback to general Comet actors
  if (reactors.length === 0) {
    const cometLikersRegex = /"actors"\s*:\s*\[\s*\{\s*"id"\s*:\s*"([^"]+)",\s*"name"\s*:\s*"([^"]+)"/gi;
    for (const m of html.matchAll(cometLikersRegex)) {
      try {
        const id = m[1];
        const name = JSON.parse(`"${m[2]}"`);
        if (name && !reactors.some(r => r.displayName === name)) {
          reactors.push({
            displayName: name,
            fbUserId: id,
            profileUrl: `https://www.facebook.com/${id}`,
            avatarUrl: id ? `https://graph.facebook.com/${id}/picture?type=normal` : null,
            interactionType: 'REACTION',
            reactionType: 'LIKE',
            commentText: null
          });
        }
      } catch {}
      if (reactors.length >= 20) break;
    }
  }

  return reactors;
}

/**
 * Parses mbasic UFI reaction browser HTML page to extract profiles of reactors
 * @param {string} html
 * @param {string} defaultReactionType Fallback reaction type (LIKE, LOVE, CARE, HAHA, WOW, SAD, ANGRY)
 * @returns {Array<{displayName: string, fbUserId: string|null, profileUrl: string|null, avatarUrl: string|null, interactionType: string, reactionType: string, commentText: null}>}
 */
export function parseMbasicReactors(html, defaultReactionType = 'LIKE') {
  const reactors = [];
  if (!html || typeof html !== 'string') return reactors;

  // 1. Table row layout (<tr...>)
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const m of html.matchAll(rowRegex)) {
    const trContent = m[1];
    const aMatch = trContent.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>[\s\S]*?<\/a>/i) ||
                   trContent.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;

    const rawHref = aMatch[1];
    const rawName = aMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!rawName || rawName.includes('Quay lại') || rawName.includes('Tất cả') || rawName.includes('Xem thêm')) continue;

    // Detect exact reaction type from image alt / aria-label
    let reactionType = defaultReactionType;
    const imgMatches = trContent.matchAll(/<img[^>]+(?:alt|aria-label)=["']([^"']+)["']/gi);
    for (const imgM of imgMatches) {
      const detected = mapAltToReactionType(imgM[1], null);
      if (detected) {
        reactionType = detected;
        break;
      }
    }

    // Extract avatar
    let avatarUrl = null;
    const avatarMatch = trContent.match(/<img[^>]+src=["'](https:\/\/[^"'\s]+(?:fbcdn\.net|facebook\.com)[^"'\s]*)["']/i);
    if (avatarMatch) {
      avatarUrl = avatarMatch[1].replace(/&amp;/g, '&');
    }

    // Clean profile URL
    let cleanHref = rawHref.replace(/&amp;/g, '&');
    let fbUserId = null;
    const idMatch = cleanHref.match(/[?&]id=(\d+)/) || cleanHref.match(/\/profile\.php\?id=(\d+)/);
    if (idMatch) {
      fbUserId = idMatch[1];
      cleanHref = `/profile.php?id=${fbUserId}`;
    } else {
      const userMatch = cleanHref.match(/\/([a-zA-Z0-9.]+)(?:\?|$)/);
      if (userMatch && !['profile.php', 'story.php', 'photo.php', 'browse'].includes(userMatch[1])) {
        fbUserId = userMatch[1];
        cleanHref = `/${userMatch[1]}`;
      }
    }

    const profileUrl = `https://www.facebook.com${cleanHref.startsWith('/') ? '' : '/'}${cleanHref}`;
    if (!avatarUrl && fbUserId && /^\d+$/.test(fbUserId)) {
      avatarUrl = `https://graph.facebook.com/${fbUserId}/picture?type=normal`;
    }

    reactors.push({
      displayName: rawName,
      fbUserId,
      profileUrl,
      avatarUrl,
      interactionType: 'REACTION',
      reactionType,
      commentText: null
    });

    if (reactors.length >= 50) break;
  }

  // 2. List item layout (<li...>)
  if (reactors.length === 0) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    for (const m of html.matchAll(liRegex)) {
      const liContent = m[1];
      const aMatch = liContent.match(/<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>[\s\S]*?<\/a>/i) ||
                     liContent.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!aMatch) continue;

      const rawHref = aMatch[1];
      const rawName = aMatch[2].replace(/<[^>]+>/g, '').trim();
      if (!rawName || rawName.includes('Quay lại') || rawName.includes('Tất cả')) continue;

      let reactionType = defaultReactionType;
      const imgM = liContent.match(/<img[^>]+(?:alt|aria-label)=["']([^"']+)["']/i);
      if (imgM) {
        reactionType = mapAltToReactionType(imgM[1], defaultReactionType);
      }

      let fbUserId = null;
      const idMatch = rawHref.match(/[?&]id=(\d+)/);
      if (idMatch) fbUserId = idMatch[1];

      reactors.push({
        displayName: rawName,
        fbUserId,
        profileUrl: `https://www.facebook.com${rawHref.startsWith('/') ? '' : '/'}${rawHref.replace(/&amp;/g, '&')}`,
        avatarUrl: fbUserId && /^\d+$/.test(fbUserId) ? `https://graph.facebook.com/${fbUserId}/picture?type=normal` : null,
        interactionType: 'REACTION',
        reactionType,
        commentText: null
      });

      if (reactors.length >= 50) break;
    }
  }

  return reactors;
}

/**
 * Parses mbasic detailed reaction breakdown tabs (/ufi/reaction/profile/browser/...)
 * @param {string} html
 * @returns {{ like: number, love: number, care: number, haha: number, wow: number, sad: number, angry: number }}
 */
export function parseMbasicReactionsBreakdown(html) {
  const result = {
    like: 0,
    love: 0,
    care: 0,
    haha: 0,
    wow: 0,
    sad: 0,
    angry: 0
  };

  if (!html || typeof html !== 'string') return result;

  const tabMatches = html.matchAll(/<a[^>]+href="[^"]*reaction_type=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of tabMatches) {
    const typeId = parseInt(m[1], 10);
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const countMatch = text.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    const count = countMatch ? parseCount(countMatch[1]) : 0;

    switch (typeId) {
      case 1:
        result.like = count;
        break;
      case 2:
        result.love = count;
        break;
      case 16:
        result.care = count;
        break;
      case 4:
        result.haha = count;
        break;
      case 3:
        result.wow = count;
        break;
      case 7:
        result.sad = count;
        break;
      case 8:
        result.angry = count;
        break;
      default:
        break;
    }
  }

  return result;
}
