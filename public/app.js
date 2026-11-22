// State Management
let currentTab = 'overview';
let overviewChartInstance = null;
let detailChartInstance = null;
let comparisonChartInstance = null;
let currentDetailTargetId = null;
let ws = null;
let searchTimeout = null;
let cachedTargets = [];
let cycleCountdownSeconds = 20;
let cycleTimer = null;

// --- Commercial Modal & Dialog Engine ---
let confirmCallback = null;

function showNoticeModal({ title = 'Thông báo hệ thống', message = '', type = 'success', btnText = 'Xác nhận', onConfirm = null }) {
  const modal = document.getElementById('commercialNoticeModal');
  const titleEl = document.getElementById('noticeModalTitle');
  const msgEl = document.getElementById('noticeModalMessage');
  const btnEl = document.getElementById('noticeModalBtn');
  const iconContainer = document.getElementById('noticeIconContainer');

  titleEl.textContent = title;
  msgEl.textContent = message;
  btnEl.textContent = btnText;

  // Modern SVG Icons for Success, Error, Warning, Info
  if (type === 'success') {
    iconContainer.className = 'w-14 h-14 rounded-2xl bg-brand-cyan/10 border border-brand-cyan/30 flex items-center justify-center text-brand-cyan mb-1 shadow-lg shadow-brand-cyan/10';
    iconContainer.innerHTML = '<svg class="w-7 h-7 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path></svg>';
  } else if (type === 'error') {
    iconContainer.className = 'w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-1 shadow-lg shadow-rose-500/10';
    iconContainer.innerHTML = '<svg class="w-7 h-7 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12"></path></svg>';
  } else if (type === 'warning') {
    iconContainer.className = 'w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-1 shadow-lg shadow-amber-500/10';
    iconContainer.innerHTML = '<svg class="w-7 h-7 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>';
  } else {
    iconContainer.className = 'w-14 h-14 rounded-2xl bg-brand-blue/10 border border-brand-blue/30 flex items-center justify-center text-brand-cyan mb-1 shadow-lg shadow-brand-blue/10';
    iconContainer.innerHTML = '<svg class="w-7 h-7 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
  }

  btnEl.onclick = () => {
    closeNoticeModal();
    if (onConfirm) onConfirm();
  };

  modal.classList.remove('hidden');
}

function closeNoticeModal() {
  const modal = document.getElementById('commercialNoticeModal');
  if (modal) modal.classList.add('hidden');
}

function showConfirmDialog({ title = 'Xác nhận thao tác', message = '', acceptText = 'Xác nhận', cancelText = 'Hủy bỏ', onConfirm = null }) {
  const modal = document.getElementById('commercialConfirmModal');
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  document.getElementById('confirmAcceptBtn').textContent = acceptText;
  document.getElementById('confirmCancelBtn').textContent = cancelText;

  confirmCallback = onConfirm;
  modal.classList.remove('hidden');
}

function closeConfirmModal(accepted) {
  const modal = document.getElementById('commercialConfirmModal');
  if (modal) modal.classList.add('hidden');
  if (accepted && confirmCallback) {
    confirmCallback();
  }
  confirmCallback = null;
}

// Override native window.alert to always use commercial modal
window.alert = (msg) => {
  showNoticeModal({ title: 'Thông báo hệ thống', message: msg, type: 'info' });
};

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  updateThemeIcons();
  initWebSocket();
  initCycleCountdown();
  fetchOverview();
  fetchTargets();
  fetchAlerts();
});

// --- Theme Switcher (Dark / Light Mode) ---
function toggleTheme() {
  const isDark = document.documentElement.classList.contains('dark');
  if (isDark) {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem('theme', 'light');
  } else {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  }
  updateThemeIcons();

  // Re-render charts with updated theme palette colors
  if (currentTab === 'overview') fetchOverview();
  if (currentTab === 'comparison') renderComparison();
  if (currentDetailTargetId) loadTargetDetail(currentDetailTargetId);
}

function getThemeChartColors() {
  const isLight = document.documentElement.classList.contains('light');
  return {
    textColor: isLight ? '#334155' : '#CBD5E1',
    subColor: '#64748B',
    gridColor: isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.07)',
    rxColor: isLight ? '#0284C7' : '#38C6FF',
    cmtColor: '#0078A8',
    shareColor: isLight ? '#0F172A' : '#FFFFFF'
  };
}

function updateThemeIcons() {
  const isDark = document.documentElement.classList.contains('dark');
  const darkIcon = document.getElementById('themeIconDark');
  const lightIcon = document.getElementById('themeIconLight');
  if (!darkIcon || !lightIcon) return;

  if (isDark) {
    darkIcon.classList.remove('hidden');
    lightIcon.classList.add('hidden');
  } else {
    darkIcon.classList.add('hidden');
    lightIcon.classList.remove('hidden');
  }
}

// --- Tab Switching ---
function switchTab(tabId) {
  currentTab = tabId;
  const tabs = ['overview', 'targets', 'comparison', 'alerts'];
  
  for (const t of tabs) {
    const viewEl = document.getElementById(`view-${t}`);
    const tabBtn = document.getElementById(`tab-${t}`);
    if (viewEl && tabBtn) {
      if (t === tabId) {
        viewEl.classList.remove('hidden');
        tabBtn.className = 'py-3.5 border-b-2 border-brand-cyan text-txt-title font-semibold flex items-center gap-2 transition';
      } else {
        viewEl.classList.add('hidden');
        tabBtn.className = 'py-3.5 border-b-2 border-transparent text-txt-sub hover:text-txt-body font-medium flex items-center gap-2 transition';
      }
    }
  }

  if (tabId === 'overview') fetchOverview();
  if (tabId === 'targets') fetchTargets();
  if (tabId === 'comparison') loadComparisonCheckboxes();
  if (tabId === 'alerts') fetchAlerts();
}

// --- WebSocket / Edge Live Stream ---
let wsRetryCount = 0;
let pollingInterval = null;

function startAutoPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    if (currentTab === 'overview') fetchOverview();
    if (currentTab === 'targets') fetchTargets();
    if (currentTab === 'alerts') fetchAlerts();
  }, 20000);
}

function initWebSocket() {
  const wsDot = document.getElementById('wsDot');
  const wsText = document.getElementById('wsText');

  // If deployed on Serverless Edge, switch immediately to Edge Sync mode
  const isServerless = window.location.hostname.includes('workers.dev') || window.location.hostname.includes('pages.dev');
  if (isServerless) {
    if (wsDot && wsText) {
      wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      wsText.textContent = 'Hệ thống 24/7 (Đồng bộ tự động)';
    }
    startAutoPolling();
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsRetryCount = 0;
      if (wsDot && wsText) {
        wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
        wsText.textContent = 'WebSocket Đã kết nối';
      }
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleLiveEvent(payload);
      } catch (e) {
        console.error('Lỗi phân tích WebSocket payload:', e);
      }
    };

    ws.onclose = () => {
      wsRetryCount++;
      if (wsRetryCount > 1) {
        // Fall back gracefully to Edge Sync without showing red warning
        if (wsDot && wsText) {
          wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
          wsText.textContent = 'Hệ thống 24/7 (Đồng bộ tự động)';
        }
        startAutoPolling();
        return;
      }
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    if (wsDot && wsText) {
      wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      wsText.textContent = 'Hệ thống 24/7 (Đồng bộ tự động)';
    }
    startAutoPolling();
  }
}

function handleLiveEvent(evt) {
  const stream = document.getElementById('activityStream');
  const time = new Date().toLocaleTimeString('vi-VN');

  if (evt.type === 'SNAPSHOT_PROCESSED') {
    const p = evt.data.processed;
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between text-gray-300 py-1 border-b border-gray-800/60';
    item.innerHTML = `
      <span>[${time}] Cập nhật target #${p.targetId}: ${p.totalReactions.toLocaleString()} cảm xúc, ${p.totalComments.toLocaleString()} cmt, ${p.totalShares.toLocaleString()} shares</span>
      <span class="text-emerald-400 font-semibold">+${p.deltas.reactions} rx</span>
    `;
    stream.prepend(item);
    if (stream.children.length > 30) stream.removeChild(stream.lastChild);

    // Refresh active views
    if (currentTab === 'overview') fetchOverview();
    if (currentTab === 'targets') fetchTargets();
    if (currentDetailTargetId === p.targetId) loadTargetDetail(currentDetailTargetId);
  } else if (evt.type === 'NEW_ALERT') {
    const a = evt.data;
    const item = document.createElement('div');
    item.className = 'flex items-center justify-between text-rose-300 py-1 bg-rose-950/20 px-2 rounded border border-rose-900/40';
    item.innerHTML = `
      <span>[${time}] 🚨 [${a.alertType}] ${a.message}</span>
      <span class="text-rose-400 font-bold">${a.severity}</span>
    `;
    stream.prepend(item);
    fetchOverview();
  }
}

// --- 1. Overview API ---
async function fetchOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    const m = data.metrics;

    document.getElementById('statActiveTasks').textContent = m.activeTasks.toLocaleString();
    document.getElementById('statTotalTargets').textContent = `/ ${m.totalTargets.toLocaleString()} link`;
    document.getElementById('statTotalReactions').textContent = m.totalReactions.toLocaleString();
    document.getElementById('statTotalComments').textContent = m.totalComments.toLocaleString();
    document.getElementById('statTotalShares').textContent = m.totalShares.toLocaleString();
    document.getElementById('statTotalAlerts').textContent = (data.recentAlerts || []).length.toLocaleString();
    document.getElementById('statErrorTasks').textContent = m.errorTasks.toLocaleString();

    const unreadAlerts = (data.recentAlerts || []).filter(a => !a.acknowledged);
    const unreadBadge = document.getElementById('unreadAlertCount');
    if (unreadAlerts.length > 0) {
      unreadBadge.textContent = unreadAlerts.length;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }

    renderTopFastest(data.topFastest || []);
    renderOverviewChart(data.topFastest || []);
  } catch (err) {
    console.error('Lỗi tải overview:', err);
  }
}

function renderTopFastest(items) {
  const container = document.getElementById('topFastestList');
  if (items.length === 0) {
    container.innerHTML = '<div class="text-xs text-gray-500 italic py-4 text-center">Chưa có bài viết phát sinh tăng trưởng đột biến</div>';
    return;
  }

  container.innerHTML = items.map(item => `
    <div onclick="openDetailModal(${item.id})" class="p-2.5 rounded-lg bg-dark-bg border border-dark-border hover:border-brand-500/50 cursor-pointer transition">
      <div class="flex items-center justify-between">
        <span class="font-medium text-white truncate max-w-[160px]">${item.author_name || 'Facebook Post'}</span>
        <span class="px-1.5 py-0.5 text-[10px] rounded font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
          +${item.growth_rate_5m || 0}% / 5m
        </span>
      </div>
      <p class="text-[11px] text-gray-400 truncate mt-1">${item.content_snippet || item.normalized_url}</p>
      <div class="mt-2 flex items-center justify-between text-[11px] text-gray-400">
        <span>${item.latest_reactions.toLocaleString()} rx</span>
        <span>${item.latest_comments.toLocaleString()} cmt</span>
        <span>${item.latest_shares.toLocaleString()} shares</span>
      </div>
    </div>
  `).join('');
}

function renderOverviewChart(fastestItems) {
  const ctx = document.getElementById('overviewChart').getContext('2d');
  const labels = fastestItems.map(i => (i.author_name || 'Post').slice(0, 15));
  const reactionData = fastestItems.map(i => i.latest_reactions);
  const commentData = fastestItems.map(i => i.latest_comments);
  const shareData = fastestItems.map(i => i.latest_shares);
  const theme = getThemeChartColors();

  if (overviewChartInstance) {
    overviewChartInstance.destroy();
  }

  overviewChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.length ? labels : ['Chưa có bài viết'],
      datasets: [
        { label: 'Cảm xúc (Reactions)', data: reactionData.length ? reactionData : [0], backgroundColor: theme.rxColor, borderRadius: 6 },
        { label: 'Bình luận (Comments)', data: commentData.length ? commentData : [0], backgroundColor: theme.cmtColor, borderRadius: 6 },
        { label: 'Chia sẻ (Shares)', data: shareData.length ? shareData : [0], backgroundColor: theme.shareColor, borderRadius: 6 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: theme.textColor, font: { size: 12, weight: '500' } } }
      },
      scales: {
        x: { ticks: { color: theme.subColor, font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: theme.subColor, font: { size: 11 } }, grid: { color: theme.gridColor } }
      }
    }
  });
}

// --- 2. Targets List & Countdown Engine ---
function initCycleCountdown() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(() => {
    cycleCountdownSeconds--;
    const globalEl = document.getElementById('globalCountdownText');
    if (globalEl) {
      globalEl.textContent = `${cycleCountdownSeconds}s`;
    }
    updateRowCountdowns();

    if (cycleCountdownSeconds <= 0) {
      cycleCountdownSeconds = 20;
      if (globalEl) globalEl.textContent = '20s';
      if (currentTab === 'targets') fetchTargets();
      if (currentTab === 'overview') fetchOverview();
    }
  }, 1000);
}

function updateRowCountdowns() {
  if (!cachedTargets || cachedTargets.length === 0) return;
  const now = Date.now();
  for (const t of cachedTargets) {
    const el = document.getElementById(`target-countdown-${t.id}`);
    if (!el) continue;
    if (t.status !== 'ACTIVE') {
      el.textContent = 'Tạm dừng';
      el.className = 'text-[10px] text-txt-muted';
      continue;
    }
    const lastTime = t.last_checked_at ? new Date(t.last_checked_at).getTime() : 0;
    const intervalMs = (t.check_interval_sec || 60) * 1000;
    const diff = lastTime + intervalMs - now;
    const remainingSec = Math.max(0, Math.ceil(diff / 1000));
    if (remainingSec === 0) {
      el.innerHTML = '<span class="text-emerald-400 font-semibold animate-pulse">⚡ Đến lượt</span>';
    } else {
      el.textContent = `⏳ còn ${remainingSec}s`;
      el.className = 'text-[10px] text-brand-cyan font-mono';
    }
  }
}

async function triggerCycleTick() {
  cycleCountdownSeconds = 20;
  const globalEl = document.getElementById('globalCountdownText');
  if (globalEl) globalEl.textContent = '20s';
  await refreshTargetsTable(true);
}

async function refreshTargetsTable(forceSync = false) {
  const btn = document.getElementById('btnRefreshTargets');
  const icon = document.getElementById('refreshTargetsIcon');
  const text = document.getElementById('refreshTargetsText');

  if (icon) icon.classList.add('animate-spin');
  if (text) text.textContent = 'Đang đồng bộ...';
  if (btn) btn.disabled = true;

  try {
    if (forceSync) {
      await fetch('/api/targets/sync-all', { method: 'POST' }).catch(() => {});
    }
    await fetchTargets();
    if (currentTab === 'overview') await fetchOverview();
    if (text) text.textContent = '✓ Đã cập nhật';
  } catch (err) {
    console.error('Lỗi làm mới:', err);
    if (text) text.textContent = 'Lỗi làm mới';
  } finally {
    cycleCountdownSeconds = 20;
    const globalEl = document.getElementById('globalCountdownText');
    if (globalEl) globalEl.textContent = '20s';
    setTimeout(() => {
      if (icon) icon.classList.remove('animate-spin');
      if (text) text.textContent = 'Làm mới bảng';
      if (btn) btn.disabled = false;
    }, 1200);
  }
}

function debounceFetchTargets() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(fetchTargets, 300);
}

async function fetchTargets() {
  const searchInput = document.getElementById('targetSearchInput');
  const typeFilter = document.getElementById('targetTypeFilter');
  const statusFilter = document.getElementById('targetStatusFilter');

  const search = searchInput ? searchInput.value : '';
  const type = typeFilter ? typeFilter.value : '';
  const status = statusFilter ? statusFilter.value : '';

  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (type) params.append('type', type);
  if (status) params.append('status', status);

  try {
    const res = await fetch(`/api/targets?${params.toString()}`);
    const data = await res.json();
    cachedTargets = data.targets || [];
    renderTargetsTable(cachedTargets);
    const countEl = document.getElementById('tabTargetsCount');
    if (countEl) countEl.textContent = cachedTargets.length;
  } catch (err) {
    console.error('Lỗi tải targets:', err);
  }
}

function renderTargetsTable(targets) {
  cachedTargets = targets || [];
  const tbody = document.getElementById('targetsTableBody');
  if (!tbody) return;
  if (targets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="p-8 text-center text-txt-sub">Chưa có liên kết Facebook nào được giám sát. Nhấn "Thêm liên kết giám sát" ở trên.</td></tr>`;
    return;
  }

  tbody.innerHTML = targets.map(t => {
    let statusClass = 'status-active';
    let statusText = 'Hoạt động 24/7';
    if (t.status === 'PAUSED') { statusClass = 'status-paused'; statusText = 'Tạm dừng'; }
    else if (t.status === 'DATA_LIMITED') { statusClass = 'status-limited'; statusText = 'Giới hạn'; }
    else if (t.status === 'INACCESSIBLE') { statusClass = 'status-inaccessible'; statusText = 'Lỗi truy cập'; }

    return `
      <tr class="hover:bg-surface-elevated/50 transition">
        <td class="p-3.5">
          <div class="flex items-center gap-2.5">
            <img src="${t.author_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&h=80&fit=crop'}" class="w-8 h-8 rounded-lg object-cover bg-gray-800">
            <div class="max-w-[240px]">
              <div class="font-medium text-txt-title truncate">${t.author_name || 'Facebook Item'}</div>
              <a href="${t.normalized_url}" target="_blank" class="text-[11px] text-txt-sub hover:text-brand-cyan truncate block">${t.normalized_url}</a>
            </div>
          </div>
        </td>
        <td class="p-3.5">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-elevated text-txt-sub border border-surface-border">
            ${t.target_type}
          </span>
        </td>
        <td class="p-3.5 text-right font-semibold text-brand-cyan">${(t.latest_reactions || 0).toLocaleString()}</td>
        <td class="p-3.5 text-right font-semibold text-txt-title">${(t.latest_comments || 0).toLocaleString()}</td>
        <td class="p-3.5 text-right font-semibold text-brand-cyan">${(t.latest_shares || 0).toLocaleString()}</td>
        <td class="p-3.5 text-center text-brand-cyan font-semibold">+${(t.latest_reactions || 0) - (t.baseline_reactions || 0)}</td>
        <td class="p-3.5 text-center">
          <div class="inline-flex flex-col items-center">
            <span class="font-medium text-txt-title">${t.check_interval_sec}s</span>
            <span id="target-countdown-${t.id}" class="text-[10px] text-brand-cyan font-mono">⏳ ...</span>
          </div>
        </td>
        <td class="p-3.5 text-center">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusClass}">${statusText}</span>
        </td>
        <td class="p-3.5 text-right">
          <div class="flex items-center justify-end gap-2">
            <button onclick="openDetailModal(${t.id})" class="px-2.5 py-1 bg-surface-elevated hover:bg-brand-blue/30 text-brand-cyan rounded text-xs transition border border-surface-border">Chi tiết</button>
            <button id="btn-sync-${t.id}" onclick="syncTargetNow(${t.id})" title="Đồng bộ ngay" class="p-1.5 bg-surface-elevated hover:bg-brand-blue/30 text-brand-cyan rounded text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            </button>
            <button onclick="togglePause(${t.id}, '${t.status}')" title="${t.status === 'PAUSED' ? 'Tiếp tục' : 'Tạm dừng'}" class="p-1.5 bg-surface-elevated hover:bg-surface text-txt-body rounded text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              ${t.status === 'PAUSED' ? '<svg class="w-3.5 h-3.5 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path></svg>' : '<svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6"></path></svg>'}
            </button>
            <button onclick="deleteTarget(${t.id})" title="Xóa" class="p-1.5 bg-surface-elevated hover:bg-rose-500/20 text-rose-400 rounded text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updateRowCountdowns();
}

// --- Target Quick Actions ---
async function syncTargetNow(id) {
  const btn = document.getElementById(`btn-sync-${id}`);
  const icon = btn ? btn.querySelector('svg') : null;
  if (icon) icon.classList.add('animate-spin');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/targets/${id}/sync-now`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await fetchTargets();
    if (currentTab === 'overview') await fetchOverview();
  } catch (e) {
    showNoticeModal({ title: 'Lỗi đồng bộ', message: e.message, type: 'error' });
  } finally {
    if (icon) icon.classList.remove('animate-spin');
    if (btn) btn.disabled = false;
  }
}

async function togglePause(id, currentStatus) {
  const newStatus = currentStatus === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
  try {
    await fetch(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    fetchTargets();
    fetchOverview();
  } catch (e) {
    alert('Lỗi cập nhật trạng thái: ' + e.message);
  }
}

async function deleteTarget(id) {
  showConfirmDialog({
    title: 'Xóa đối tượng giám sát',
    message: 'Bạn có chắc chắn muốn xóa bài viết này cùng toàn bộ lịch sử snapshot khỏi hệ sinh thái giám sát?',
    acceptText: 'Xác nhận xóa',
    cancelText: 'Hủy bỏ',
    onConfirm: async () => {
      try {
        await fetch(`/api/targets/${id}`, { method: 'DELETE' });
        fetchTargets();
        fetchOverview();
        showNoticeModal({ title: 'Đã xóa đối tượng', message: 'Bài viết đã được gỡ bỏ an toàn.', type: 'success' });
      } catch (e) {
        showNoticeModal({ title: 'Lỗi xóa', message: e.message, type: 'error' });
      }
    }
  });
}

// --- 3. Target Detail Modal API ---
async function openDetailModal(id) {
  currentDetailTargetId = id;
  document.getElementById('detailModal').classList.remove('hidden');
  loadTargetDetail(id);
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.add('hidden');
  currentDetailTargetId = null;
}

async function loadTargetDetail(id) {
  try {
    const res = await fetch(`/api/targets/${id}`);
    const data = await res.json();
    const t = data.target;
    const snap = data.latestSnapshot;

    document.getElementById('detailAvatar').src = t.author_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&h=80&fit=crop';
    document.getElementById('detailAuthor').textContent = t.author_name || 'Facebook Post';
    document.getElementById('detailTypeBadge').textContent = t.target_type;
    document.getElementById('detailStatusBadge').textContent = t.status;
    document.getElementById('detailSnippet').textContent = t.content_snippet || t.normalized_url;
    document.getElementById('detailLink').href = t.normalized_url;

    // 3 Groups numbers
    document.getElementById('detailTotalReactions').textContent = (snap ? snap.total_reactions : t.latest_reactions).toLocaleString();
    document.getElementById('detailDeltaReactions').textContent = `+${snap ? snap.delta_reactions : 0} từ lần kiểm tra trước`;

    document.getElementById('detailTotalComments').textContent = (snap ? snap.total_comments : t.latest_comments).toLocaleString();
    document.getElementById('detailDeltaComments').textContent = `+${snap ? snap.delta_comments : 0} từ lần kiểm tra trước`;

    document.getElementById('detailTotalShares').textContent = (snap ? snap.total_shares : t.latest_shares).toLocaleString();
    document.getElementById('detailDeltaShares').textContent = `+${snap ? snap.delta_shares : 0} từ lần kiểm tra trước`;

    // 7 Reactions breakdown
    render7ReactionsBreakdown(snap);

    // Timeline Chart
    renderDetailHistoryChart(data.snapshots || []);

    // Identifiable Accounts
    renderInteractedAccounts(data.interactedAccounts || []);

    // Alert configs
    const cfg = data.alertConfig || {};
    document.getElementById('cfgReactionSpike').value = cfg.reaction_spike_threshold || 50;
    document.getElementById('cfgCommentSurge').value = cfg.comment_surge_threshold || 20;
    document.getElementById('cfgShareBurst').value = cfg.share_burst_threshold || 10;
  } catch (err) {
    console.error('Lỗi tải chi tiết target:', err);
  }
}

function render7ReactionsBreakdown(snap) {
  const container = document.getElementById('reactionBarsContainer');
  if (!snap) {
    container.innerHTML = '<div class="col-span-7 text-xs text-txt-sub py-2">Đang chờ lần đồng bộ dữ liệu đầu tiên...</div>';
    return;
  }

  const items = [
    { 
      label: 'Like', 
      count: snap.like_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>'
    },
    { 
      label: 'Love', 
      count: snap.love_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path></svg>'
    },
    { 
      label: 'Care', 
      count: snap.care_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>'
    },
    { 
      label: 'Haha', 
      count: snap.haha_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
    },
    { 
      label: 'Wow', 
      count: snap.wow_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>'
    },
    { 
      label: 'Sad', 
      count: snap.sad_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-txt-sub" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
    },
    { 
      label: 'Angry', 
      count: snap.angry_count, 
      svg: '<svg class="w-5 h-5 mx-auto text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>'
    },
  ];

  container.innerHTML = items.map(i => `
    <div class="rx-vector-box rounded-xl p-2.5">
      <div class="mb-1.5">${i.svg}</div>
      <div class="text-xs font-bold text-txt-title">${(i.count || 0).toLocaleString()}</div>
      <div class="text-[11px] text-txt-sub mt-0.5 uppercase tracking-wider font-semibold">${i.label}</div>
    </div>
  `).join('');
}

function renderDetailHistoryChart(snapshots) {
  const ctx = document.getElementById('detailHistoryChart').getContext('2d');
  const labels = snapshots.map(s => new Date(s.observed_at).toLocaleTimeString('vi-VN'));
  const reactions = snapshots.map(s => s.total_reactions);
  const comments = snapshots.map(s => s.total_comments);
  const shares = snapshots.map(s => s.total_shares);
  const theme = getThemeChartColors();

  if (detailChartInstance) {
    detailChartInstance.destroy();
  }

  detailChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Cảm xúc', data: reactions, borderColor: theme.rxColor, backgroundColor: 'rgba(56, 198, 255, 0.1)', fill: true, tension: 0.3 },
        { label: 'Bình luận', data: comments, borderColor: theme.cmtColor, tension: 0.3 },
        { label: 'Chia sẻ', data: shares, borderColor: theme.shareColor, tension: 0.3 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: theme.textColor, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: theme.subColor, font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: theme.subColor, font: { size: 10 } }, grid: { color: theme.gridColor } }
      }
    }
  });
}

function renderInteractedAccounts(accounts) {
  const container = document.getElementById('detailInteractedList');
  document.getElementById('detailIdentifiedCount').textContent = `${accounts.length} tương tác`;

  if (accounts.length === 0) {
    container.innerHTML = '<div class="text-txt-sub italic py-3 text-center">Chưa có bình luận hoặc tài khoản tương tác nào được bóc tách. Bấm nút đồng bộ để quét.</div>';
    return;
  }

  container.innerHTML = accounts.map(a => {
    const isComment = (a.interaction_type || '').toUpperCase() === 'COMMENT';
    const typeBadge = isComment
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-brand-blue/20 text-brand-cyan border border-brand-cyan/20">💬 Bình luận</span>'
      : `<span class="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20">👍 Cảm xúc (${a.reaction_type || 'Like'})</span>`;
    
    const profileLink = a.profile_url
      ? `<a href="${a.profile_url}" target="_blank" class="font-semibold text-txt-title hover:text-brand-cyan transition">${a.display_name}</a>`
      : `<span class="font-semibold text-txt-title">${a.display_name}</span>`;

    const avatar = a.avatar_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop';
    const commentBody = a.comment_text
      ? `<p class="text-xs text-txt-body mt-1 bg-surface-elevated/60 p-2 rounded-lg border border-surface-border break-words">${a.comment_text}</p>`
      : '';

    return `
      <div class="py-2.5 flex items-start gap-3 hover:bg-surface-elevated/30 px-2 rounded-xl transition">
        <img src="${avatar}" class="w-8 h-8 rounded-full object-cover bg-gray-800 border border-surface-border shrink-0" onerror="this.src='https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop'">
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 truncate">
              ${profileLink}
              ${typeBadge}
            </div>
            <span class="text-[10px] text-txt-muted shrink-0">${new Date(a.observed_at).toLocaleTimeString('vi-VN')}</span>
          </div>
          ${commentBody}
        </div>
      </div>
    `;
  }).join('');
}

async function saveDetailAlertConfig() {
  if (!currentDetailTargetId) return;
  const config = {
    reaction_spike_threshold: parseInt(document.getElementById('cfgReactionSpike').value, 10),
    comment_surge_threshold: parseInt(document.getElementById('cfgCommentSurge').value, 10),
    share_burst_threshold: parseInt(document.getElementById('cfgShareBurst').value, 10)
  };

  try {
    await fetch(`/api/targets/${currentDetailTargetId}/alert-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    showNoticeModal({
      title: 'Cấu hình hoàn tất',
      message: 'Ngưỡng cảnh báo bùng nổ tương tác đã được cập nhật thành công.',
      type: 'success'
    });
  } catch (e) {
    showNoticeModal({ title: 'Lỗi lưu cấu hình', message: e.message, type: 'error' });
  }
}

// --- 4. Batch Import Modal ---
function openBatchModal() {
  document.getElementById('batchModal').classList.remove('hidden');
}
function closeBatchModal() {
  document.getElementById('batchModal').classList.add('hidden');
  document.getElementById('batchPreviewContainer').classList.add('hidden');
}

async function previewBatchUrls() {
  const input = document.getElementById('batchInput').value;
  if (!input.trim()) return alert('Vui lòng dán ít nhất 1 liên kết Facebook');

  const statusEl = document.getElementById('batchPreviewStatus');
  statusEl.textContent = 'Đang phân tích...';

  try {
    const res = await fetch('/api/targets/batch-parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input })
    });
    const data = await res.json();
    statusEl.textContent = `Đã phân tích ${data.totalCount} URL`;

    const container = document.getElementById('batchPreviewContainer');
    const tbody = document.getElementById('batchPreviewBody');
    container.classList.remove('hidden');

    tbody.innerHTML = data.items.map(item => `
      <tr class="hover:bg-dark-hover">
        <td class="p-2 font-mono truncate max-w-[200px]">${item.normalizedUrl || item.rawUrl}</td>
        <td class="p-2 uppercase font-semibold text-brand-400">${item.type}</td>
        <td class="p-2 text-gray-400 font-mono">${item.contentId || 'N/A'}</td>
        <td class="p-2">
          <span class="px-2 py-0.5 rounded text-[10px] font-semibold ${item.status === 'READY_TO_MONITOR' ? 'status-active' : (item.isDuplicate ? 'status-paused' : 'status-inaccessible')}">
            ${item.status}
          </span>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    statusEl.textContent = 'Lỗi phân tích: ' + e.message;
  }
}

async function submitBatchTargets() {
  const input = document.getElementById('batchInput').value;
  const interval = parseInt(document.getElementById('batchInterval').value, 10);
  const priority = parseInt(document.getElementById('batchPriority').value, 10);

  const urls = input.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) return showNoticeModal({ title: 'Cảnh báo', message: 'Vui lòng dán ít nhất 1 đường dẫn Facebook hợp lệ.', type: 'warning' });

  try {
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, checkIntervalSec: interval, priority })
    });
    const result = await res.json();
    closeBatchModal();
    document.getElementById('batchInput').value = '';
    fetchTargets();
    fetchOverview();

    showNoticeModal({
      title: 'Khởi tạo thành công',
      message: `Đã đưa vào hàng đợi giám sát 24/7 thành công ${result.createdCount} liên kết Facebook.`,
      type: 'success'
    });
  } catch (e) {
    showNoticeModal({ title: 'Lỗi khởi tạo', message: e.message, type: 'error' });
  }
}

// --- 5. Accounts Modal & Meta OAuth ---
function openAccountsModal() {
  document.getElementById('accountsModal').classList.remove('hidden');
  fetchAccountsList();
  loadSettings();
}
function closeAccountsModal() {
  document.getElementById('accountsModal').classList.add('hidden');
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    const s = data.settings || {};
    const proxyInput = document.getElementById('residentialProxyInput');
    if (proxyInput && s.residential_proxy_url) {
      proxyInput.value = s.residential_proxy_url;
    }
    const sidecarBadge = document.getElementById('sidecarStatusBadge');
    if (sidecarBadge) {
      if (s.sidecar_last_ping) {
        const diffSec = Math.floor((Date.now() - new Date(s.sidecar_last_ping).getTime()) / 1000);
        if (diffSec < 120) {
          sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20';
          sidecarBadge.textContent = `🟢 Hoạt động (${diffSec}s trước)`;
        } else {
          sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-surface-elevated text-txt-sub border border-surface-border';
          sidecarBadge.textContent = '⚪ Chờ kết nối';
        }
      } else {
        sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-surface-elevated text-txt-sub border border-surface-border';
        sidecarBadge.textContent = '⚪ Chưa kích hoạt';
      }
    }
  } catch (err) {
    console.warn('Lỗi tải settings:', err);
  }
}

async function saveResidentialProxy() {
  const input = document.getElementById('residentialProxyInput');
  const val = input ? input.value.trim() : '';

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ residential_proxy_url: val })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    showNoticeModal({
      title: 'Cập nhật Proxy Dân Cư',
      message: val ? 'Đã lưu cấu hình Residential Proxy thành công.' : 'Đã xóa cấu hình Proxy.',
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi lưu Proxy', message: err.message, type: 'error' });
  }
}

async function autoInspectAndImport() {
  const token = document.getElementById('autoTokenInput').value.trim();
  if (!token) return alert('Vui lòng nhập Access Token');

  try {
    const res = await fetch('/api/accounts/inspect-and-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);

    document.getElementById('autoTokenInput').value = '';
    fetchAccountsList();

    showNoticeModal({
      title: 'Trích xuất & Nạp thành công',
      message: `Đã nhận diện User "${result.user.name}" và nạp tự động ${result.pagesCount} Fanpage vào hệ thống.`,
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi trích xuất', message: err.message, type: 'error' });
  }
}

async function fetchAccountsList() {
  try {
    const res = await fetch('/api/accounts');
    const data = await res.json();
    const container = document.getElementById('accountsListContainer');

    if (data.accounts.length === 0) {
      container.innerHTML = '<div class="p-3 text-center text-txt-sub text-xs">Chưa có kết nối nào. Điền form bên trên để thêm token Fanpage Meta hoặc Cookie mbasic.</div>';
      return;
    }

    container.innerHTML = data.accounts.map(acc => {
      const typeBadge = acc.account_type === 'cookie'
        ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-brand-cyan/20 text-brand-cyan border border-brand-cyan/30">mbasic Cookie</span>'
        : `<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-elevated text-txt-sub">${acc.account_type.toUpperCase()}</span>`;

      return `
        <div class="p-3 flex items-center justify-between bg-surface text-xs border-b border-surface-border">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-txt-title">${acc.name}</span>
              ${typeBadge}
            </div>
            <div class="text-[11px] text-txt-sub mt-0.5">ID: ${acc.fb_account_id} | Đồng bộ: ${acc.last_sync_at ? new Date(acc.last_sync_at).toLocaleTimeString('vi-VN') : 'Chưa có'}</div>
          </div>
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded text-xs font-semibold ${acc.status === 'ACTIVE' ? 'status-active' : 'status-inaccessible'}">${acc.status}</span>
            ${acc.account_type === 'cookie' ? `<button onclick="testCookieAccount(${acc.id}, this)" class="px-2.5 py-1 bg-brand-cyan/10 text-brand-cyan hover:bg-brand-cyan/20 border border-brand-cyan/30 rounded text-xs font-medium transition">Kiểm tra</button>` : ''}
            <button onclick="revokeAccount(${acc.id})" class="px-2.5 py-1 bg-rose-500/10 text-rose-400 rounded text-xs hover:bg-rose-500/20 transition">Thu hồi</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('Lỗi tải accounts:', e);
  }
}

async function submitAddCookieAccount() {
  const name = document.getElementById('cookieAccName').value.trim();
  const cookie = document.getElementById('cookieInput').value.trim();
  if (!cookie) {
    return showNoticeModal({ title: 'Thiếu thông tin', message: 'Vui lòng dán chuỗi Cookie Facebook vào ô nhập liệu.', type: 'warning' });
  }

  try {
    const res = await fetch('/api/accounts/import-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cookie })
    });
    const result = await res.json();
    if (result.error) throw new Error(result.error);

    document.getElementById('cookieAccName').value = '';
    document.getElementById('cookieInput').value = '';
    fetchAccountsList();

    showNoticeModal({
      title: 'Lưu Cookie mbasic thành công',
      message: `Đã mã hóa AES-256-GCM cho nick "${result.account.name}". Hệ thống sẽ tự động dùng cookie này để cào số liệu các link bên thứ 3.`,
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi nạp Cookie', message: err.message, type: 'error' });
  }
}

async function testCookieAccount(id, btn) {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = 'Đang test...';
  btn.disabled = true;

  try {
    const res = await fetch(`/api/accounts/${id}/test-cookie`, { method: 'POST' });
    const data = await res.json();

    if (data.valid) {
      showNoticeModal({
        title: 'Cookie hoạt động tốt',
        message: `Tài khoản: "${data.name}". Phiên mbasic hợp lệ, sẵn sàng giám sát bài viết 24/7!`,
        type: 'success'
      });
      fetchAccountsList();
    } else {
      showNoticeModal({
        title: 'Cookie không hợp lệ',
        message: data.message || data.error || 'Cookie đã hết hạn hoặc bị Facebook yêu cầu checkpoint.',
        type: 'error'
      });
      fetchAccountsList();
    }
  } catch (err) {
    showNoticeModal({ title: 'Lỗi kiểm tra', message: err.message, type: 'error' });
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

async function submitAddAccount(e) {
  e.preventDefault();
  const name = document.getElementById('accName').value;
  const fbAccountId = document.getElementById('accFbId').value;
  const accessToken = document.getElementById('accToken').value;

  try {
    await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fbAccountId, accessToken, accountType: 'page' })
    });
    document.getElementById('addAccountForm').reset();
    fetchAccountsList();

    showNoticeModal({
      title: 'Mã hóa hoàn tất',
      message: 'Đã lưu và mã hóa an toàn Meta Access Token với chuẩn bảo mật AES-256-GCM.',
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi lưu tài khoản', message: err.message, type: 'error' });
  }
}

async function revokeAccount(id) {
  showConfirmDialog({
    title: 'Thu hồi kết nối Meta',
    message: 'Bạn có chắc chắn muốn ngắt kết nối tài khoản này? Các bài viết phụ thuộc có thể bị gián đoạn số liệu.',
    acceptText: 'Thu hồi kết nối',
    cancelText: 'Hủy bỏ',
    onConfirm: async () => {
      try {
        await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
        fetchAccountsList();
        showNoticeModal({ title: 'Đã thu hồi', message: 'Kết nối tài khoản Meta đã được gỡ bỏ an toàn.', type: 'success' });
      } catch (e) {
        showNoticeModal({ title: 'Lỗi thu hồi', message: e.message, type: 'error' });
      }
    }
  });
}

// --- 6. Alerts Tab API ---
async function fetchAlerts() {
  try {
    const res = await fetch('/api/alerts');
    const data = await res.json();
    const tbody = document.getElementById('alertsTableBody');

    if (data.alerts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-gray-500">Không có cảnh báo bất thường nào được ghi nhận.</td></tr>';
      return;
    }

    tbody.innerHTML = data.alerts.map(a => `
      <tr class="hover:bg-dark-hover">
        <td class="p-3 font-mono text-gray-400">${new Date(a.detected_at).toLocaleString('vi-VN')}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${a.severity === 'CRITICAL' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}">
            ${a.severity}
          </span>
        </td>
        <td class="p-3 font-semibold text-white">${a.alert_type}</td>
        <td class="p-3 truncate max-w-[180px]">${a.author_name || a.normalized_url}</td>
        <td class="p-3 text-gray-300">${a.message}</td>
        <td class="p-3 text-right">
          ${a.acknowledged ? '<span class="text-gray-500">Đã xác nhận</span>' : `<button onclick="ackAlert(${a.id})" class="px-2 py-1 bg-brand-500 hover:bg-brand-600 text-white rounded text-[11px]">Xác nhận</button>`}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    console.error('Lỗi tải alerts:', e);
  }
}

async function ackAlert(id) {
  try {
    await fetch(`/api/alerts/${id}/ack`, { method: 'PATCH' });
    fetchAlerts();
    fetchOverview();
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

// --- 7. Comparison Tab ---
async function loadComparisonCheckboxes() {
  try {
    const res = await fetch('/api/targets?limit=20');
    const data = await res.json();
    const container = document.getElementById('comparisonCheckboxes');

    if (!data.targets || data.targets.length === 0) {
      container.innerHTML = '<div class="text-xs text-txt-sub italic">Chưa có bài viết nào trong danh sách giám sát để so sánh.</div>';
      return;
    }

    container.innerHTML = data.targets.map((t, idx) => `
      <label class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface border border-surface-border cursor-pointer hover:border-brand-cyan/40 transition">
        <input type="checkbox" name="compTarget" value="${t.id}" ${idx < 4 ? 'checked' : ''} onchange="renderComparison()" class="rounded text-brand-cyan focus:ring-0">
        <span class="text-txt-title font-medium">${t.author_name || 'Post #' + t.id}</span>
        <span class="text-[11px] text-txt-sub">(${t.latest_reactions || 0} rx)</span>
      </label>
    `).join('');

    renderComparison();
  } catch (e) {
    console.error('Lỗi tải danh sách so sánh:', e);
  }
}

async function renderComparison() {
  const selected = Array.from(document.querySelectorAll('input[name="compTarget"]:checked')).map(el => el.value);
  if (selected.length === 0) {
    if (comparisonChartInstance) {
      comparisonChartInstance.destroy();
      comparisonChartInstance = null;
    }
    return;
  }

  try {
    const res = await fetch(`/api/comparison?ids=${selected.join(',')}`);
    const data = await res.json();
    const canvas = document.getElementById('comparisonChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const theme = getThemeChartColors();

    if (!data.comparison || data.comparison.length === 0) {
      if (comparisonChartInstance) {
        comparisonChartInstance.destroy();
        comparisonChartInstance = null;
      }
      return;
    }

    // Collect all timestamps across all selected targets
    const allTimestamps = Array.from(new Set(
      data.comparison.flatMap(c => (c.points || []).map(p => p.observed_at))
    )).sort();

    if (allTimestamps.length === 0) {
      allTimestamps.push(new Date().toISOString());
    }

    const labels = allTimestamps.map(t => new Date(t).toLocaleTimeString('vi-VN'));
    const palette = ['#38C6FF', '#0078A8', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6'];

    const datasets = data.comparison.map((item, idx) => {
      const pointMap = new Map((item.points || []).map(p => [p.observed_at, p.total_reactions]));
      let lastVal = item.target.latest_reactions || 0;
      const dataValues = allTimestamps.map(t => {
        if (pointMap.has(t)) {
          lastVal = pointMap.get(t);
        }
        return lastVal;
      });

      const color = palette[idx % palette.length];
      return {
        label: item.target.author_name || `Target #${item.target.id}`,
        data: dataValues,
        borderColor: color,
        backgroundColor: color,
        tension: 0.3,
        fill: false,
        pointRadius: 4,
        pointHoverRadius: 6
      };
    });

    if (comparisonChartInstance) {
      comparisonChartInstance.destroy();
    }

    comparisonChartInstance = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: theme.textColor, font: { size: 12, weight: '500' } }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: { ticks: { color: theme.subColor, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: theme.subColor, font: { size: 10 } }, grid: { color: theme.gridColor } }
        }
      }
    });
  } catch (e) {
    console.error('Lỗi tải biểu đồ so sánh:', e);
  }
}
