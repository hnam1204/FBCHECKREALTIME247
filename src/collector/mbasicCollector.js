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
      contentSnippet: null,
      reactionsBrowserUrl: null
    };
  }

  let totalReactions = 0;
  let totalComments = 0;
  let totalShares = 0;
  let reactions = { like: 0, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
  let authorName = null;
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
      contentSnippet,
      reactionsBrowserUrl: null
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
    contentSnippet,
    reactionsBrowserUrl
  };
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
