const URL = globalThis.URL;

// Tracking parameters to strip
const TRACKING_PARAMS = [
  'fbclid', 'ref', 'ref_src', 'ref_url', '__cft__', '__tn__', 
  'mibextid', 'rdid', 'hrc', 'paipv', 'checkpoint_src', 'extid'
];

/**
 * Standardize and clean a raw Facebook URL
 * @param {string} rawUrl 
 * @returns {string} Normalized URL
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let trimmed = rawUrl.trim();
  
  // Handle protocol
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    
    // Check Facebook domains
    const hostname = parsed.hostname.toLowerCase();
    const validDomains = [
      'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
      'mbasic.facebook.com', 'fb.watch', 'fb.com'
    ];
    
    const isFb = validDomains.some(d => hostname === d || hostname.endsWith('.' + d));
    if (!isFb) {
      throw new Error('Not a valid Facebook domain');
    }

    // Strip tracking parameters
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    // Also strip array-like tracking params (__cft__[0], etc.)
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.startsWith('__cft__') || key.startsWith('__tn__')) {
        parsed.searchParams.delete(key);
      }
    }

    // Standardize hostname
    if (parsed.hostname !== 'fb.watch') {
      parsed.hostname = 'www.facebook.com';
    }

    return parsed.toString();
  } catch (err) {
    return '';
  }
}

/**
 * Inspect Facebook URL to determine content type and extract content ID
 * @param {string} cleanUrl 
 * @returns {{ type: string, contentId: string, status: string, message: string }}
 */
function analyzeUrl(cleanUrl) {
  if (!cleanUrl) {
    return {
      type: 'unknown',
      contentId: '',
      status: 'INACCESSIBLE',
      message: 'URL không hợp lệ hoặc không thuộc hệ sinh thái Facebook'
    };
  }

  try {
    const parsed = new URL(cleanUrl);
    const path = parsed.pathname;
    const searchParams = parsed.searchParams;

    // 1. Reel
    const reelMatch = path.match(/\/reel(?:s)?\/([0-9a-zA-Z._-]+)/i);
    if (reelMatch) {
      return {
        type: 'reel',
        contentId: reelMatch[1],
        status: 'READY_TO_MONITOR',
        message: 'Reel Facebook công khai - sẵn sàng giám sát'
      };
    }

    // 2. Video / Watch
    if (parsed.hostname === 'fb.watch') {
      const code = path.replace(/^\//, '');
      return {
        type: 'video',
        contentId: code,
        status: 'READY_TO_MONITOR',
        message: 'Video fb.watch rút gọn - sẵn sàng giám sát'
      };
    }
    const watchMatch = path.match(/\/watch\/?/i) && searchParams.get('v');
    if (watchMatch) {
      return {
        type: 'video',
        contentId: searchParams.get('v'),
        status: 'READY_TO_MONITOR',
        message: 'Video Facebook Watch - sẵn sàng giám sát'
      };
    }
    const videoDirectMatch = path.match(/\/videos\/([0-9]+)/i);
    if (videoDirectMatch) {
      return {
        type: 'video',
        contentId: videoDirectMatch[1],
        status: 'READY_TO_MONITOR',
        message: 'Video bài đăng trực tiếp - sẵn sàng giám sát'
      };
    }

    // 3. Group Post
    const groupPostMatch = path.match(/\/groups\/([0-9a-zA-Z._-]+)\/posts\/([0-9]+)/i);
    if (groupPostMatch) {
      return {
        type: 'group_post',
        contentId: `${groupPostMatch[1]}_${groupPostMatch[2]}`,
        status: 'NEEDS_AUTH',
        message: 'Bài viết Nhóm - có thể cần cấp quyền tài khoản thành viên nhóm'
      };
    }

    // 4. Standard Post / Story / Permalink
    const permalinkId = searchParams.get('story_fbid') || searchParams.get('fbid') || searchParams.get('id');
    if ((path.includes('/permalink.php') || path.includes('/story.php')) && permalinkId) {
      return {
        type: 'post',
        contentId: permalinkId,
        status: 'READY_TO_MONITOR',
        message: 'Bài viết liên kết cố định (permalink/story)'
      };
    }

    const postMatch = path.match(/\/posts\/([0-9a-zA-Z._-]+)/i);
    if (postMatch) {
      return {
        type: 'post',
        contentId: postMatch[1],
        status: 'READY_TO_MONITOR',
        message: 'Bài viết Fanpage/Người dùng công khai'
      };
    }

    // 5. Profile or Page
    const profileIdMatch = searchParams.get('id');
    if (path.includes('/profile.php') && profileIdMatch) {
      return {
        type: 'profile',
        contentId: profileIdMatch,
        status: 'DATA_LIMITED',
        message: 'Trang cá nhân - giới hạn chỉ số theo chính sách quyền riêng tư Meta'
      };
    }

    const segments = path.split('/').filter(Boolean);
    if (segments.length === 1 && !['events', 'marketplace', 'gaming', 'groups'].includes(segments[0])) {
      return {
        type: 'page',
        contentId: segments[0],
        status: 'READY_TO_MONITOR',
        message: 'Fanpage hoặc Trang định danh công khai'
      };
    }

    // Fallback general post
    return {
      type: 'post',
      contentId: segments[segments.length - 1] || 'generic',
      status: 'READY_TO_MONITOR',
      message: 'Liên kết bài viết Facebook hợp lệ'
    };
  } catch (err) {
    return {
      type: 'unknown',
      contentId: '',
      status: 'INACCESSIBLE',
      message: 'Lỗi phân tích URL: ' + err.message
    };
  }
}

/**
 * Batch parse multiple URLs from raw input string or lines
 * @param {string|string[]} input 
 * @returns {Array<Object>} List of analyzed items with deduplication
 */
function parseBatchUrls(input) {
  let lines = [];
  if (Array.isArray(input)) {
    lines = input;
  } else if (typeof input === 'string') {
    lines = input.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  }

  const seenUrls = new Set();
  const results = [];

  for (const raw of lines) {
    const clean = normalizeUrl(raw);
    if (!clean) {
      results.push({
        rawUrl: raw,
        normalizedUrl: '',
        isValid: false,
        isDuplicate: false,
        type: 'unknown',
        contentId: '',
        status: 'INACCESSIBLE',
        message: 'Đường dẫn không hợp lệ hoặc sai định dạng'
      });
      continue;
    }

    const isDup = seenUrls.has(clean);
    seenUrls.add(clean);

    const analysis = analyzeUrl(clean);
    results.push({
      rawUrl: raw,
      normalizedUrl: clean,
      isValid: true,
      isDuplicate: isDup,
      type: analysis.type,
      contentId: analysis.contentId,
      status: isDup ? 'DUPLICATE' : analysis.status,
      message: isDup ? 'Liên kết trùng lặp trong danh sách' : analysis.message
    });
  }

  return results;
}

module.exports = {
  normalizeUrl,
  analyzeUrl,
  parseBatchUrls
};
