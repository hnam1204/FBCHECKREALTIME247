/**
 * Local Node.js Sidecar Agent (Tầng 3: Chống chặn triệt để bằng IP Dân cư)
 * Chạy trên máy cá nhân với IP nhà mạng nội địa (Viettel / VNPT / FPT) hoặc qua Residential Proxy.
 * Thu thập dữ liệu tương tác Facebook 24/7 và đẩy trực tiếp lên Cloudflare D1.
 */

const { isCheckpointOrLogin, parseMbasicHtml, parseMbasicReactionsBreakdown, parseMbasicReactors } = require('./collector/mbasicCollector');
const { testProxyConnectivity } = require('./collector/proxyHelper');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');

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

    const { targets = [], accounts = [], proxiesToTest = [], cookie = null, proxyUrl = null } = await taskRes.json();

    // 2. Tự động test proxy nếu có proxy ở trạng thái PENDING
    if (Array.isArray(proxiesToTest) && proxiesToTest.length > 0) {
      console.log(`[c4] SIDECAR: Phát hiện ${proxiesToTest.length} proxy cần test tự động...`);
      const testResults = [];
      for (const p of proxiesToTest) {
        const auth = p.username && p.password ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
        const pUrl = `${p.protocol || 'http'}://${auth}${p.host}:${p.port}`;
        const tRes = await testProxyConnectivity(pUrl, 6000);
        console.log(`[c4] SIDECAR: Proxy #${p.id} (${p.host}:${p.port}) -> ${tRes.live ? `LIVE (${tRes.latency_ms}ms, IP: ${tRes.exit_ip})` : `DIE (${tRes.error})`}`);
        testResults.push({ id: p.id, ...tRes });
      }

      try {
        await fetch(`${WORKER_URL}/api/sidecar/proxy-results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sidecar-Secret': SIDECAR_SECRET },
          body: JSON.stringify({ results: testResults })
        });
        console.log(`[c4] SIDECAR: Đã gửi kết quả test ${testResults.length} proxy về Cloudflare D1.`);
      } catch (e) {
        console.error(`[c4] SIDECAR: Lỗi gửi kết quả proxy về Edge:`, e.message);
      }
    }

    if (targets.length === 0) {
      console.log(`[c4] SIDECAR [${new Date().toLocaleTimeString('vi-VN')}]: Không có link nào cần cào.`);
      return;
    }

    const activeAccounts = accounts.length > 0 ? accounts : (cookie ? [{ id: 1, name: 'Default Cookie', cookie, proxy_url: proxyUrl }] : []);
    if (activeAccounts.length === 0) {
      console.warn(`[c4] SIDECAR: Chưa có Cookie nick phụ active trên hệ thống.`);
      return;
    }

    console.log(`[c4] SIDECAR [${new Date().toLocaleTimeString('vi-VN')}]: Đang xử lý ${targets.length} bài viết với ${activeAccounts.length} account độc lập...`);

    // 3. Duyệt từng target và cào với account & proxy độc lập tương ứng
    for (const target of targets) {
      try {
        const intervalSec = target.check_interval_sec || 300;
        if (target.last_checked_at) {
          const elapsedSec = (Date.now() - new Date(target.last_checked_at).getTime()) / 1000;
          if (elapsedSec < intervalSec) {
            // Chưa đến chu kỳ, bỏ qua để chống checkpoint nick
            continue;
          }
        }

        // Chọn account độc lập cho target này
        let chosenAccount = null;
        if (target.bound_account_id) {
          chosenAccount = activeAccounts.find(a => a.id === target.bound_account_id);
        }
        if (!chosenAccount) {
          chosenAccount = activeAccounts[target.id % activeAccounts.length];
        }
        if (!chosenAccount || !chosenAccount.cookie) {
          console.warn(`[c4] SIDECAR: Không tìm thấy account khả dụng cho #${target.id}`);
          continue;
        }

        // Tạo Agent định tuyến theo Proxy độc lập của Account
        let agent = undefined;
        const targetProxy = chosenAccount.proxy_url || proxyUrl;
        if (targetProxy) {
          try {
            if (targetProxy.startsWith('socks')) {
              agent = new SocksProxyAgent(targetProxy);
            } else {
              agent = new HttpsProxyAgent(targetProxy);
            }
            console.log(`[c4] SIDECAR: #${target.id} -> Account [${chosenAccount.name}] qua Proxy [${targetProxy}] (Phiên độc lập)`);
          } catch (e) {
            console.warn(`[c4] SIDECAR: Lỗi khởi tạo proxy agent cho [${chosenAccount.name}]:`, e.message);
          }
        } else {
          console.log(`[c4] SIDECAR: #${target.id} -> Account [${chosenAccount.name}] qua IP Nhà Local`);
        }

        let fetchUrl = target.normalized_url;
        if (!fetchUrl.startsWith('http')) {
          fetchUrl = `https://mbasic.facebook.com/${target.content_id}`;
        } else {
          fetchUrl = fetchUrl
            .replace('www.facebook.com', 'mbasic.facebook.com')
            .replace('m.facebook.com', 'mbasic.facebook.com')
            .replace('web.facebook.com', 'mbasic.facebook.com');
        }

        const headers = {
          'Cookie': chosenAccount.cookie,
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none'
        };

        const res = await fetch(fetchUrl, { agent, headers, redirect: 'follow', timeout: 15000 });
        const html = await res.text();

        if (isCheckpointOrLogin(res.url, html) || html.includes('AccountRequiredProductRule')) {
          console.warn(`[c4] SIDECAR: Account [${chosenAccount.name}] bị mất phiên / checkpoint hoặc Facebook yêu cầu đăng nhập. Bỏ qua push.`);
          continue;
        }

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
            const ufiRes = await fetch(ufiUrl, { agent, headers, timeout: 10000 });
            const ufiHtml = await ufiRes.text();
            breakdown = parseMbasicReactionsBreakdown(ufiHtml);
            let allReactors = parseMbasicReactors(ufiHtml, 'LIKE');

            // Check 7 reaction tabs: LIKE (1), LOVE (2), CARE (16), HAHA (4), WOW (3), SAD (7), ANGRY (8)
            const reactionTabs = [
              { type: 'LIKE', id: 1, count: breakdown.like },
              { type: 'LOVE', id: 2, count: breakdown.love },
              { type: 'CARE', id: 16, count: breakdown.care },
              { type: 'HAHA', id: 4, count: breakdown.haha },
              { type: 'WOW', id: 3, count: breakdown.wow },
              { type: 'SAD', id: 7, count: breakdown.sad },
              { type: 'ANGRY', id: 8, count: breakdown.angry }
            ];

            // If any specific reaction tab has interactions, fetch that tab to get exact real accounts
            for (const rTab of reactionTabs) {
              if (rTab.count > 0) {
                const hasType = allReactors.some(r => r.reactionType === rTab.type);
                if (!hasType) {
                  try {
                    const tabUrl = `https://mbasic.facebook.com${parsed.reactionsBrowserUrl}&reaction_type=${rTab.id}`;
                    const tabRes = await fetch(tabUrl, { agent, headers, timeout: 8000 });
                    const tabHtml = await tabRes.text();
                    const tabReactors = parseMbasicReactors(tabHtml, rTab.type);
                    for (const tr of tabReactors) {
                      if (!allReactors.some(ar => ar.displayName === tr.displayName && ar.reactionType === tr.reactionType)) {
                        allReactors.push(tr);
                      }
                    }
                  } catch (tabErr) {
                    // Ignore individual tab timeout
                  }
                }
              }
            }

            if (allReactors.length > 0) reactors = allReactors;
          } catch (e) {
            // Ignore ufi error
          }
        }

        const interactedAccounts = [...(parsed.comments || []), ...reactors];

        // Client Quality Gate: Không bao giờ đẩy snapshot sụt giảm 0 ghi đè lên bài viết có tương tác baseline
        const baseRx = Math.max(target.latest_reactions || 0, target.last_valid_reactions || 0);
        const baseCmt = Math.max(target.latest_comments || 0, target.last_valid_comments || 0);
        const baseSh = Math.max(target.latest_shares || 0, target.last_valid_shares || 0);
        if (
          (baseRx > 5 && parsed.totalReactions === 0) ||
          (baseCmt > 5 && parsed.totalComments === 0) ||
          (baseSh > 5 && parsed.totalShares === 0) ||
          ((baseRx > 0 || baseCmt > 0 || baseSh > 0) && parsed.totalReactions === 0 && parsed.totalComments === 0 && parsed.totalShares === 0) ||
          (baseRx > 20 && parsed.totalReactions < baseRx * 0.4)
        ) {
          console.warn(`[c4] SIDECAR: [Quality Gate] Target #${target.id} cào ra số liệu bất thường (0 hoặc sụt giảm mạnh) khi baseline đang là (${baseRx} rx, ${baseCmt} cmt). Bỏ qua push để bảo vệ tính toàn vẹn dữ liệu.`);
          continue;
        }

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
            author_avatar: parsed.authorAvatar || parsed.postImage,
            post_image: parsed.postImage,
            content_snippet: parsed.contentSnippet,
            interacted_accounts: interactedAccounts
          })
        });

        if (pushRes.ok) {
          console.log(`[c4] SIDECAR: ✓ Target #${target.id} (${target.author_name || 'Post'}) -> ${parsed.totalReactions} cảm xúc, ${parsed.totalComments} cmt, ${parsed.totalShares} shares. Đã lưu D1.`);
        } else {
          console.error(`[c4] SIDECAR: [ERR] Lỗi push snapshot #${target.id}: ${await pushRes.text()}`);
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

if (require.main === module) {
  loop();
}

module.exports = {
  runSidecarTick,
  loop
};
