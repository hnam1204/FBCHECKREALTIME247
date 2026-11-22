/**
 * Facebook mbasic HTML parser and metrics extractor for 3rd-party public targets.
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
    // If there is a password input, it's definitely a login wall
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
  // Strip non-numeric characters except digits
  const digits = clean.replace(/[^\d]/g, '');
  return parseInt(digits || '0', 10);
}

/**
 * Parses mbasic post HTML page
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

  // 1. Reactions Browser URL and count
  let totalReactions = 0;
  let reactionsBrowserUrl = null;

  // Pattern: <a href="/ufi/reaction/profile/browser/?ft_ent_identifier=...">... 45 ...</a>
  const rxLinkMatch = html.match(/href="(\/ufi\/reaction\/profile\/browser\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (rxLinkMatch) {
    reactionsBrowserUrl = rxLinkMatch[1].replace(/&amp;/g, '&');
    const rawText = rxLinkMatch[2].replace(/<[^>]+>/g, '').trim();
    // E.g. "Bạn và 45 người khác" -> 46, or "45 người khác" -> 45, or "45"
    if (rawText.includes('Bạn và') || rawText.includes('You and')) {
      const match = rawText.match(/(\d[\d.,]*)/);
      totalReactions = (match ? parseCount(match[1]) : 0) + 1;
    } else {
      const match = rawText.match(/(\d[\d.,]*)/);
      totalReactions = match ? parseCount(match[1]) : 0;
    }
  } else {
    // Fallback: look for generic reaction text patterns
    const fallbackMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:người khác|người|lượt thích|thích|reactions|likes)/i);
    if (fallbackMatch) {
      totalReactions = parseCount(fallbackMatch[1]);
    }
  }

  // 2. Comments count
  let totalComments = 0;
  const cmtMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:bình luận|bình luận trước|comments)/i)
    || html.match(/href="[^"]*\/mbasic\/comment\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (cmtMatch) {
    const rawText = cmtMatch[1].replace(/<[^>]+>/g, '').trim();
    const countMatch = rawText.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    if (countMatch) totalComments = parseCount(countMatch[1]);
  }

  // 3. Shares count
  let totalShares = 0;
  const shareMatch = html.match(/(\d[\d.,]*\s*(?:K|M)?)\s*(?:lượt chia sẻ|lượt chia sẽ|chia sẻ|shares)/i)
    || html.match(/href="[^"]*\/shares\/view\/[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (shareMatch) {
    const rawText = shareMatch[1].replace(/<[^>]+>/g, '').trim();
    const countMatch = rawText.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    if (countMatch) totalShares = parseCount(countMatch[1]);
  }

  // 4. Author Name
  let authorName = null;
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].replace(/\s*\|\s*Facebook$/i, '').trim();
    if (t && !t.includes('Facebook') && !t.includes('Đăng nhập') && !t.includes('Log in')) {
      authorName = t;
    }
  }
  if (!authorName) {
    const actorMatch = html.match(/<h3[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)
      || html.match(/<strong[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/strong>/i);
    if (actorMatch) {
      authorName = actorMatch[1].replace(/<[^>]+>/g, '').trim();
    }
  }

  // 5. Content Snippet
  let contentSnippet = null;
  const pMatch = html.match(/<div[^>]*data-ft="[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (pMatch) {
    const text = pMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 5) contentSnippet = text.slice(0, 200);
  }

  return {
    totalReactions,
    reactions: {
      like: totalReactions, // default to all like if breakdown isn't fetched
      love: 0,
      care: 0,
      haha: 0,
      wow: 0,
      sad: 0,
      angry: 0
    },
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

  // Patterns on mbasic reaction tabs:
  // <a href="...&reaction_type=1..."><span>Tất cả 45</span></a>
  // <a href="...&reaction_type=1..."><span>Thích 20</span></a>
  // <a href="...&reaction_type=2..."><span>Yêu thích 15</span></a>
  // <a href="...&reaction_type=16..."><span>Thương thương 5</span></a>
  // <a href="...&reaction_type=4..."><span>Haha 3</span></a>
  // <a href="...&reaction_type=3..."><span>Wow 1</span></a>
  // <a href="...&reaction_type=7..."><span>Buồn 1</span></a>
  // <a href="...&reaction_type=8..."><span>Phẫn nộ 0</span></a>

  const tabMatches = html.matchAll(/<a[^>]+href="[^"]*reaction_type=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of tabMatches) {
    const typeId = parseInt(m[1], 10);
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    const countMatch = text.match(/(\d[\d.,]*\s*(?:K|M)?)/);
    const count = countMatch ? parseCount(countMatch[1]) : 0;

    switch (typeId) {
      case 1: // LIKE
        result.like = count;
        break;
      case 2: // LOVE
        result.love = count;
        break;
      case 16: // CARE
        result.care = count;
        break;
      case 4: // HAHA
        result.haha = count;
        break;
      case 3: // WOW
        result.wow = count;
        break;
      case 7: // SAD
        result.sad = count;
        break;
      case 8: // ANGRY
        result.angry = count;
        break;
      default:
        break;
    }
  }

  return result;
}
