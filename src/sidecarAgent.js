/**
 * Local Node.js Sidecar Agent (Tầng 3: Chống chặn triệt để bằng IP Dân cư)
 * Chạy trên máy cá nhân với IP nhà mạng nội địa (Viettel / VNPT / FPT) hoặc qua Residential Proxy.
 * Thu thập dữ liệu tương tác Facebook 24/7 và đẩy trực tiếp lên Cloudflare D1.
 */

const { parseMbasicHtml, parseMbasicReactionsBreakdown, parseMbasicReactors } = require('./collector/mbasicCollector');

// Cấu hình Sidecar
const WORKER_URL = process.env.WORKER_URL || 'https://cookiefb.coongviec.workers.dev';
const SIDECAR_SECRET = process.env.SIDECAR_SECRET || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const INTERVAL_SEC = parseInt(process.env.SIDECAR_INTERVAL_SEC || '30', 10);

console.log('===============================================================');
console.log('[c4] LOCAL RESIDENTIAL SIDECAR AGENT - 24/7 ANTI-CHECKPOINT');
console.log(`[c4] Worker API:     ${WORKER_URL}`);
console.log(`[c4] Chu kỳ quét:    ${INTERVAL_SEC} giây / vòng lặp`);
console.log(`[c4] Mạng định tuyến: IP Dân cư thật của máy tính (Local Network)`);
console.log('===============================================================');

let isRunning = true;

async function runSidecarTick() {
  try {
    // 1. Lấy danh sách nhiệm vụ và cookie từ Edge
    const taskRes = await fetch(`${WORKER_URL}/api/sidecar/tasks?secret=${SIDECAR_SECRET}`, {
      headers: { 'X-Sidecar-Secret': SIDECAR_SECRET }
    });

    if (!taskRes.ok) {
      const errText = await taskRes.text();
      console.error(`[c4] SIDECAR: Lỗi lấy danh sách task từ Edge (${taskRes.status}): ${errText}`);
      return;
    }

    const { targets = [], cookie = null, proxyUrl = null } = await taskRes.json();

    if (targets.length === 0) {
      console.log(`[c4] SIDECAR [${new Date().toLocaleTimeString('vi-VN')}]: Không có link nào cần cào.`);
      return;
    }

    if (!cookie) {
      console.warn(`[c4] SIDECAR: Chưa có Cookie nick phụ active trên hệ thống.`);
      return;
    }

    console.log(`[c4] SIDECAR [${new Date().toLocaleTimeString('vi-VN')}]: Đang xử lý ${targets.length} bài viết...`);

    // 2. Duyệt từng target và cào trực tiếp qua IP máy local
    for (const target of targets) {
      try {
        let fetchUrl = target.normalized_url;
        if (!fetchUrl.startsWith('http')) {
          fetchUrl = `https://www.facebook.com/${target.content_id}`;
        }

        const headers = {
          'Cookie': cookie,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        };

        const res = await fetch(fetchUrl, { headers, redirect: 'follow' });
        const html = await res.text();

        const parsed = parseMbasicHtml(html);

        if (
          parsed.authorName === 'Lỗi' ||
          html.includes('Trình duyệt này không hỗ trợ Facebook') ||
          html.includes('Sorry, something went wrong') ||
          (parsed.totalReactions === 0 && parsed.totalComments === 0 && !parsed.authorName)
        ) {
          console.warn(`[c4] SIDECAR: Facebook trả về trang lỗi/chặn cho #${target.id}. Bỏ qua để bảo vệ dữ liệu hiện tại.`);
          continue;
        }

        let breakdown = parsed.reactions || { like: parsed.totalReactions, love: 0, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 };
        let reactors = parsed.reactors || [];

        if (parsed.reactionsBrowserUrl) {
          try {
            const ufiUrl = `https://mbasic.facebook.com${parsed.reactionsBrowserUrl}`;
            const ufiRes = await fetch(ufiUrl, { headers });
            const ufiHtml = await ufiRes.text();
            breakdown = parseMbasicReactionsBreakdown(ufiHtml);
            const ufiReactors = parseMbasicReactors(ufiHtml);
            if (ufiReactors.length > 0) reactors = ufiReactors;
          } catch (e) {
            // Ignore ufi error
          }
        }

        const interactedAccounts = [...(parsed.comments || []), ...reactors];

        // 3. Đẩy kết quả về Cloudflare D1
        const pushRes = await fetch(`${WORKER_URL}/api/sidecar/push-snapshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sidecar-Secret': SIDECAR_SECRET
          },
          body: JSON.stringify({
            secret: SIDECAR_SECRET,
            target_id: target.id,
            total_reactions: parsed.totalReactions,
            reactions: breakdown,
            total_comments: parsed.totalComments,
            total_shares: parsed.totalShares,
            author_name: parsed.authorName,
            content_snippet: parsed.contentSnippet,
            interacted_accounts: interactedAccounts
          })
        });

        if (pushRes.ok) {
          console.log(`[c4] SIDECAR: ✓ Target #${target.id} (${target.author_name || 'Post'}) -> ${parsed.totalReactions} cảm xúc, ${parsed.totalComments} cmt, ${parsed.totalShares} shares. Đã lưu D1.`);
        } else {
          console.error(`[c4] SIDECAR: ✖ Lỗi push snapshot #${target.id}: ${await pushRes.text()}`);
        }
      } catch (err) {
        console.error(`[c4] SIDECAR: Lỗi cào target #${target.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[c4] SIDECAR: Lỗi vòng lặp quét:', err.message);
  }
}

// Chạy vòng lặp tự động 24/7
async function loop() {
  while (isRunning) {
    await runSidecarTick();
    await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

process.on('SIGINT', () => {
  console.log('\n[c4] Đang dừng Sidecar Agent an toàn...');
  isRunning = false;
  process.exit(0);
});

loop();
