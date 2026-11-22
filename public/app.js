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
let wsPingInterval = null;

function startAutoPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    if (currentTab === 'overview') fetchOverview();
    if (currentTab === 'targets') fetchTargets();
    if (currentTab === 'alerts') fetchAlerts();
  }, 5000);
}

function initWebSocket() {
  const wsDot = document.getElementById('wsDot');
  const wsText = document.getElementById('wsText');

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/ws`;

  try {
    if (wsPingInterval) clearInterval(wsPingInterval);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      wsRetryCount = 0;
      if (wsDot && wsText) {
        wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
        wsText.textContent = 'Realtime 24/7 (WebSocket Live)';
      }
      // Send immediate sync request
      try {
        ws.send(JSON.stringify({ type: 'GET_METRICS' }));
      } catch (e) {}

      // Keep connection hot and request live metrics every 4s
      wsPingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PING' }));
          ws.send(JSON.stringify({ type: 'GET_METRICS' }));
        }
      }, 4000);
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
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsRetryCount++;
      if (wsDot && wsText) {
        wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
        wsText.textContent = 'Realtime 24/7 (Đồng bộ Edge)';
      }
      startAutoPolling();
      setTimeout(initWebSocket, 4000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch (err) {
    if (wsDot && wsText) {
      wsDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      wsText.textContent = 'Realtime 24/7 (Đồng bộ Edge)';
    }
    startAutoPolling();
  }
}

function handleLiveEvent(evt) {
  const stream = document.getElementById('activityStream');
  const time = new Date().toLocaleTimeString('vi-VN');

  if (evt.type === 'LIVE_METRICS') {
    if (Array.isArray(evt.targets) && evt.targets.length > 0) {
      cachedTargets = evt.targets;
      if (currentTab === 'targets') renderTargetsTable(cachedTargets);
    }
    if (evt.totals) {
      const elRx = document.getElementById('kpiTotalReactions') || document.getElementById('statTotalReactions');
      const elCm = document.getElementById('kpiTotalComments') || document.getElementById('statTotalComments');
      const elSh = document.getElementById('kpiTotalShares') || document.getElementById('statTotalShares');
      if (elRx) elRx.textContent = (evt.totals.total_reactions || 0).toLocaleString();
      if (elCm) elCm.textContent = (evt.totals.total_comments || 0).toLocaleString();
      if (elSh) elSh.textContent = (evt.totals.total_shares || 0).toLocaleString();
    }
  } else if (evt.type === 'SNAPSHOT_PROCESSED') {
    const p = evt.data.processed;
    if (stream) {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between text-txt-body py-1 border-b border-surface-border text-xs';
      item.innerHTML = `
        <span>[${time}] Cập nhật target #${p.targetId}: ${p.totalReactions.toLocaleString()} cảm xúc, ${p.totalComments.toLocaleString()} cmt, ${p.totalShares.toLocaleString()} shares</span>
        <span class="text-emerald-400 font-semibold">+${p.deltas.reactions} rx</span>
      `;
      stream.prepend(item);
      if (stream.children.length > 30) stream.removeChild(stream.lastChild);
    }

    // Refresh active views
    if (currentTab === 'overview') fetchOverview();
    if (currentTab === 'targets') fetchTargets();
    if (currentDetailTargetId === p.targetId) loadTargetDetail(currentDetailTargetId);
  } else if (evt.type === 'NEW_ALERT') {
    const a = evt.data;
    if (stream) {
      const item = document.createElement('div');
      item.className = 'flex items-center justify-between text-rose-300 py-1 bg-rose-950/20 px-2 rounded border border-rose-900/40 text-xs';
      item.innerHTML = `
        <span class="flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
          <span>[${time}] [${a.alertType}] ${a.message}</span>
        </span>
        <span class="text-rose-400 font-bold">${a.severity}</span>
      `;
      stream.prepend(item);
    }
    dispatchDesktopNotification(a);
    if (typeof fetchAlerts === 'function') fetchAlerts(currentAlertsPage);
    fetchOverview();
  }
}

// --- 1. Overview API & Redesigned Dashboard Engine ---
let currentOverviewRange = '24H';
let currentChartMode = 'cumulative'; // 'cumulative' | 'delta'
let cachedOverviewData = null;
let isFetchingOverview = false;

function setOverviewTimeRange(range) {
  currentOverviewRange = range;
  const container = document.getElementById('overviewTimeRangeFilter');
  if (container) {
    const btns = container.querySelectorAll('button');
    btns.forEach(btn => {
      const r = btn.getAttribute('data-range');
      if (r === range) {
        btn.className = 'px-2.5 py-1 rounded-lg transition font-semibold bg-brand-blue text-white shadow-sm border border-brand-cyan/20';
      } else {
        btn.className = 'px-2.5 py-1 rounded-lg transition font-medium text-txt-sub hover:text-txt-body';
      }
    });
  }

  const badge = document.getElementById('overviewChartRangeBadge');
  if (badge) badge.textContent = `Phạm vi: ${range}`;
  const rxRange = document.getElementById('kpiRxRangeLabel');
  if (rxRange) rxRange.textContent = `${range} qua`;
  const alertRange = document.getElementById('kpiAlertRangeLabel');
  if (alertRange) alertRange.textContent = `Phạm vi ${range}`;

  fetchOverview(range);
}

function setOverviewChartMode(mode) {
  currentChartMode = mode;
  const btnCum = document.getElementById('btnChartModeCumulative');
  const btnDelta = document.getElementById('btnChartModeDelta');
  if (mode === 'cumulative') {
    if (btnCum) btnCum.className = 'px-2.5 py-1 rounded-lg font-semibold bg-brand-blue text-white shadow-sm border border-brand-cyan/20 transition';
    if (btnDelta) btnDelta.className = 'px-2.5 py-1 rounded-lg font-medium text-txt-sub hover:text-txt-body transition';
  } else {
    if (btnDelta) btnDelta.className = 'px-2.5 py-1 rounded-lg font-semibold bg-brand-blue text-white shadow-sm border border-brand-cyan/20 transition';
    if (btnCum) btnCum.className = 'px-2.5 py-1 rounded-lg font-medium text-txt-sub hover:text-txt-body transition';
  }

  if (cachedOverviewData && cachedOverviewData.timeSeries) {
    renderOverviewChart(cachedOverviewData.timeSeries);
  }
}

async function fetchOverview(range = currentOverviewRange) {
  if (isFetchingOverview) return;
  isFetchingOverview = true;

  try {
    const res = await fetch(`/api/overview?range=${encodeURIComponent(range)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedOverviewData = data;
    const m = data.metrics || {};

    // 1. Last Sync Display (Formatted Vietnam Time)
    const lastSyncEl = document.getElementById('overviewLastSyncText');
    if (lastSyncEl) {
      if (data.lastSyncAt) {
        const syncDate = new Date(data.lastSyncAt);
        const timeStr = syncDate.toLocaleTimeString('vi-VN', { hour12: false });
        const dateStr = syncDate.toLocaleDateString('vi-VN');
        lastSyncEl.textContent = `${timeStr} ${dateStr}`;
      } else {
        lastSyncEl.textContent = 'Chưa có mốc dữ liệu';
      }
    }

    // 2. KPI 1: Monitored Posts
    const totalTargets = m.totalTargets || 0;
    const activeTasks = m.activeTasks || 0;
    const kpiActive = document.getElementById('kpiActiveTargets');
    const kpiTotal = document.getElementById('kpiTotalTargets');
    const kpiRate = document.getElementById('kpiActiveRate');
    if (kpiActive) kpiActive.textContent = activeTasks.toLocaleString();
    if (kpiTotal) kpiTotal.textContent = `/ ${totalTargets.toLocaleString()} bài`;
    if (kpiRate) {
      if (totalTargets > 0) {
        const pct = Math.round((activeTasks / totalTargets) * 100);
        kpiRate.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${pct > 0 ? 'bg-emerald-400' : 'bg-slate-400'}"></span><span>${pct}% đang hoạt động</span>`;
      } else {
        kpiRate.innerHTML = '<span class="text-txt-muted">Chưa có bài giám sát</span>';
      }
    }

    // 3. KPI 2: Total Reactions
    const kpiRx = document.getElementById('kpiTotalReactions');
    const kpiRxDelta = document.getElementById('kpiDeltaReactions');
    if (kpiRx) kpiRx.textContent = (m.totalReactions || 0).toLocaleString();
    const rxDelta = m.periodDelta?.reactions || 0;
    if (kpiRxDelta) {
      kpiRxDelta.textContent = `${rxDelta >= 0 ? '+' : ''}${rxDelta.toLocaleString()} rx`;
    }

    // 4. KPI 3: Total Comments
    const kpiCmt = document.getElementById('kpiTotalComments');
    const kpiCmtDelta = document.getElementById('kpiDeltaComments');
    if (kpiCmt) kpiCmt.textContent = (m.totalComments || 0).toLocaleString();
    const cmtDelta = m.periodDelta?.comments || 0;
    if (kpiCmtDelta) {
      kpiCmtDelta.textContent = `${cmtDelta >= 0 ? '+' : ''}${cmtDelta.toLocaleString()} cmt`;
    }

    // 5. KPI 4: Total Shares
    const kpiShare = document.getElementById('kpiTotalShares');
    const kpiShareDelta = document.getElementById('kpiDeltaShares');
    if (kpiShare) kpiShare.textContent = (m.totalShares || 0).toLocaleString();
    const shareDelta = m.periodDelta?.shares || 0;
    if (kpiShareDelta) {
      kpiShareDelta.textContent = `${shareDelta >= 0 ? '+' : ''}${shareDelta.toLocaleString()} share`;
    }

    // 6. KPI 5: Growth Velocity / Total Delta in Period
    const totalPeriodDelta = rxDelta + cmtDelta + shareDelta;
    const kpiGrowthVelocity = document.getElementById('kpiGrowthVelocity');
    const kpiGrowthDelta = document.getElementById('kpiGrowthDelta');
    if (kpiGrowthVelocity) {
      kpiGrowthVelocity.textContent = `${totalPeriodDelta >= 0 ? '+' : ''}${totalPeriodDelta.toLocaleString()}`;
    }
    if (kpiGrowthDelta) {
      kpiGrowthDelta.textContent = `${totalPeriodDelta >= 0 ? '+' : ''}${totalPeriodDelta.toLocaleString()} tương tác phát sinh`;
    }

    // 7. KPI 6: Alerts & Anomalies
    const kpiAlerts = document.getElementById('kpiTotalAlerts');
    const kpiUnresolved = document.getElementById('kpiUnresolvedAlerts');
    const kpiAlertStatus = document.getElementById('kpiAlertStatus');
    const totalAlerts = m.totalAlerts || 0;
    const unresolved = m.unresolvedAlerts || 0;
    if (kpiAlerts) kpiAlerts.textContent = totalAlerts.toLocaleString();
    if (kpiUnresolved) kpiUnresolved.textContent = unresolved.toLocaleString();
    if (kpiAlertStatus) {
      if (unresolved > 0) {
        kpiAlertStatus.className = 'mt-1 text-[11px] font-semibold text-rose-400 flex items-center gap-1';
        kpiAlertStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse"></span><span>Cần xử lý cảnh báo</span>';
      } else {
        kpiAlertStatus.className = 'mt-1 text-[11px] font-semibold text-emerald-400 flex items-center gap-1';
        kpiAlertStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>Hệ thống ổn định</span>';
      }
    }

    // Unread alert badge in header navigation
    const unreadBadge = document.getElementById('unreadAlertCount');
    if (unreadBadge) {
      if (unresolved > 0) {
        unreadBadge.textContent = unresolved;
        unreadBadge.classList.remove('hidden');
      } else {
        unreadBadge.classList.add('hidden');
      }
    }

    // Render Sub-components
    renderOverviewChart(data.timeSeries || []);
    renderTopFastest(data.topFastest || []);
    renderReliabilityBreakdown(data.reliability);
    renderRecentActivityTimeline(data.recentActivity || []);
  } catch (err) {
    console.error('Lỗi tải overview dashboard:', err);
  } finally {
    isFetchingOverview = false;
  }
}

function renderTopFastest(items) {
  const container = document.getElementById('topFastestList');
  if (!container) return;

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="text-xs text-txt-sub italic py-6 text-center">Chưa có bài viết giám sát nào phát sinh biến động</div>';
    return;
  }

  container.innerHTML = items.map(item => {
    const totalEngagement = (item.latest_reactions || 0) + (item.latest_comments || 0) + (item.latest_shares || 0);
    const growth = item.growth_rate_5m || 0;
    const authorName = item.author_name || 'Facebook Post';
    const lastChecked = item.last_checked_at ? new Date(item.last_checked_at).toLocaleTimeString('vi-VN', { hour12: false }) : 'Vừa xong';

    return `
      <div onclick="openDetailModal(${item.id})" class="p-3 rounded-xl bg-surface-elevated/70 border border-surface-border hover:border-brand-cyan/40 cursor-pointer transition active:scale-[0.99] group">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-bold text-xs text-txt-title group-hover:text-brand-cyan transition truncate">${authorName}</span>
              <span class="text-[9px] px-1.5 py-0.2 rounded font-bold uppercase bg-surface text-txt-muted border border-surface-border">${item.target_type || 'POST'}</span>
            </div>
            <p class="text-[11px] text-txt-sub truncate mt-0.5" title="${item.normalized_url}">${item.content_snippet || item.normalized_url}</p>
          </div>
          <span class="px-2 py-0.5 text-[10px] rounded font-bold ${growth > 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-surface text-txt-muted border border-surface-border'} shrink-0">
            ${growth > 0 ? '+' + growth + '%/5m' : totalEngagement.toLocaleString() + ' tt'}
          </span>
        </div>
        <div class="mt-2.5 pt-2 border-t border-surface-border flex items-center justify-between text-[10px] text-txt-sub">
          <div class="flex items-center gap-3">
            <span class="text-brand-cyan font-semibold">${(item.latest_reactions || 0).toLocaleString()} rx</span>
            <span class="text-txt-body font-semibold">${(item.latest_comments || 0).toLocaleString()} cmt</span>
            <span class="text-emerald-400 font-semibold">${(item.latest_shares || 0).toLocaleString()} share</span>
          </div>
          <span class="text-txt-muted">${lastChecked}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderOverviewChart(timeSeries = []) {
  const canvas = document.getElementById('overviewChart');
  const emptyState = document.getElementById('overviewChartEmptyState');
  if (!canvas) return;

  if (!timeSeries || timeSeries.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    if (overviewChartInstance) {
      overviewChartInstance.destroy();
      overviewChartInstance = null;
    }
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  // Format labels in Vietnam Time (HH:mm dd/MM)
  const labels = timeSeries.map(pt => {
    const d = new Date(pt.observed_at);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  });

  // Choose cumulative vs delta dataset based on currentChartMode
  const isCumulative = currentChartMode === 'cumulative';
  const reactionData = timeSeries.map(pt => isCumulative ? (pt.total_reactions || 0) : (pt.delta_reactions || 0));
  const commentData = timeSeries.map(pt => isCumulative ? (pt.total_comments || 0) : (pt.delta_comments || 0));
  const shareData = timeSeries.map(pt => isCumulative ? (pt.total_shares || 0) : (pt.delta_shares || 0));

  const theme = getThemeChartColors();
  const ctx = canvas.getContext('2d');

  if (overviewChartInstance) {
    overviewChartInstance.destroy();
  }

  overviewChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Cảm xúc (Reactions)',
          data: reactionData,
          borderColor: theme.rxColor,
          backgroundColor: isCumulative ? 'rgba(56, 198, 255, 0.08)' : 'transparent',
          fill: isCumulative,
          tension: 0.25,
          pointRadius: timeSeries.length > 20 ? 1 : 3,
          pointHoverRadius: 6,
          borderWidth: 2
        },
        {
          label: 'Bình luận (Comments)',
          data: commentData,
          borderColor: '#0078A8',
          backgroundColor: isCumulative ? 'rgba(0, 120, 168, 0.08)' : 'transparent',
          fill: isCumulative,
          tension: 0.25,
          pointRadius: timeSeries.length > 20 ? 1 : 3,
          pointHoverRadius: 6,
          borderWidth: 2
        },
        {
          label: 'Chia sẻ (Shares)',
          data: shareData,
          borderColor: '#10B981',
          backgroundColor: isCumulative ? 'rgba(16, 185, 129, 0.08)' : 'transparent',
          fill: isCumulative,
          tension: 0.25,
          pointRadius: timeSeries.length > 20 ? 1 : 3,
          pointHoverRadius: 6,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.92)',
          titleColor: '#F8FAFC',
          bodyColor: '#CBD5E1',
          borderColor: 'rgba(56, 198, 255, 0.3)',
          borderWidth: 1,
          padding: 10,
          boxPadding: 4,
          callbacks: {
            title: function(context) {
              const idx = context[0]?.dataIndex;
              if (idx !== undefined && timeSeries[idx]) {
                const date = new Date(timeSeries[idx].observed_at);
                return date.toLocaleTimeString('vi-VN', { hour12: false }) + ' - ' + date.toLocaleDateString('vi-VN');
              }
              return context[0]?.label || '';
            },
            label: function(context) {
              return ` ${context.dataset.label}: ${context.parsed.y.toLocaleString()} ${isCumulative ? 'tổng' : 'phát sinh'}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: theme.subColor, font: { size: 10 }, maxTicksLimit: 8 },
          grid: { display: false }
        },
        y: {
          ticks: { color: theme.subColor, font: { size: 10 } },
          grid: { color: theme.gridColor },
          beginAtZero: true
        }
      }
    }
  });
}

function renderReliabilityBreakdown(rel) {
  if (!rel) return;
  const grandTotal = rel.grandTotalInteractions || 0;
  let organicPct = 0;
  let unknownPct = 100;
  let suspiciousPct = 0;

  if (grandTotal > 0) {
    organicPct = Math.min(100, Math.round((rel.organicCount / grandTotal) * 100));
    suspiciousPct = Math.min(100, Math.round((rel.suspiciousCount / grandTotal) * 100));
    unknownPct = Math.max(0, 100 - organicPct - suspiciousPct);
  }

  const barOrg = document.getElementById('barOrganic');
  const barUnk = document.getElementById('barUnknown');
  const barSusp = document.getElementById('barSuspicious');

  if (barOrg) barOrg.style.width = `${organicPct}%`;
  if (barUnk) barUnk.style.width = `${unknownPct}%`;
  if (barSusp) barSusp.style.width = `${suspiciousPct}%`;

  const valOrgPct = document.getElementById('valOrganicPct');
  const valOrgCnt = document.getElementById('valOrganicCount');
  const valUnkPct = document.getElementById('valUnknownPct');
  const valUnkCnt = document.getElementById('valUnknownCount');
  const valSuspPct = document.getElementById('valSuspiciousPct');
  const valSuspCnt = document.getElementById('valSuspiciousCount');

  if (valOrgPct) valOrgPct.textContent = `${organicPct}%`;
  if (valOrgCnt) valOrgCnt.textContent = `${(rel.organicCount || 0).toLocaleString()} tài khoản`;
  if (valUnkPct) valUnkPct.textContent = `${unknownPct}%`;
  if (valUnkCnt) valUnkCnt.textContent = `${(rel.unknownCount || 0).toLocaleString()} tương tác`;
  if (valSuspPct) valSuspPct.textContent = `${suspiciousPct}%`;
  if (valSuspCnt) valSuspCnt.textContent = `${(rel.suspiciousCount || 0).toLocaleString()} nghi vấn`;
}

function renderRecentActivityTimeline(events) {
  const tbody = document.getElementById('overviewRecentActivityBody');
  const emptyEl = document.getElementById('overviewActivityEmpty');
  if (!tbody) return;

  if (!events || events.length === 0) {
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  tbody.innerHTML = events.slice(0, 8).map(ev => {
    const timeStr = new Date(ev.timestamp).toLocaleTimeString('vi-VN', { hour12: false }) + ' ' + new Date(ev.timestamp).toLocaleDateString('vi-VN');
    
    let severityClass = 'bg-surface-elevated text-txt-sub border-surface-border';
    if (ev.severity === 'CRITICAL') severityClass = 'bg-rose-500/10 text-rose-400 border-rose-500/30';
    else if (ev.severity === 'WARNING') severityClass = 'bg-amber-500/10 text-amber-400 border-amber-500/30';
    else if (ev.severity === 'INFO') severityClass = 'bg-brand-blue/10 text-brand-cyan border-brand-cyan/30';

    return `
      <tr class="hover:bg-surface-elevated/40 transition">
        <td class="p-2.5 font-mono text-[11px] text-txt-sub whitespace-nowrap">${timeStr}</td>
        <td class="p-2.5">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-elevated text-txt-title border border-surface-border">
            ${ev.eventType}
          </span>
        </td>
        <td class="p-2.5 max-w-[180px] truncate font-medium text-txt-title" title="${ev.authorName}">
          ${ev.authorName}
        </td>
        <td class="p-2.5 text-txt-body max-w-[240px] truncate" title="${ev.message}">
          ${ev.message}
        </td>
        <td class="p-2.5 text-center">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold border ${severityClass}">
            ${ev.severity}
          </span>
        </td>
        <td class="p-2.5 text-right">
          <button onclick="openDetailModal(${ev.targetId})" class="px-2 py-1 bg-surface-elevated hover:bg-brand-blue/20 text-brand-cyan text-[11px] font-semibold rounded border border-surface-border transition">
            Xem
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// --- 2. Targets List & Countdown Engine ---
function initCycleCountdown() {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleCountdownSeconds = 30;
  cycleTimer = setInterval(() => {
    cycleCountdownSeconds--;
    const globalEl = document.getElementById('globalCountdownText');
    if (globalEl) {
      globalEl.textContent = `${cycleCountdownSeconds}s`;
    }
    updateRowCountdowns();

    if (cycleCountdownSeconds <= 0) {
      cycleCountdownSeconds = 30;
      if (globalEl) globalEl.textContent = '30s';
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
      el.innerHTML = '<span class="text-emerald-400 font-semibold inline-flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>Đến lượt</span>';
    } else {
      el.innerHTML = `<span class="inline-flex items-center gap-1 font-mono text-[10px] text-brand-cyan"><svg class="w-2.5 h-2.5 text-brand-cyan/70 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg><span>còn ${remainingSec}s</span></span>`;
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
    if (text) text.textContent = 'Đã cập nhật';
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

let currentTargetsPage = 1;
let targetsTotalPages = 1;
let currentDetailRange = '24H';
let currentDetailAccounts = [];

function debounceFetchTargets() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchTargets(1), 300);
}

async function fetchTargets(page = currentTargetsPage) {
  currentTargetsPage = page;
  const searchInput = document.getElementById('targetSearchInput');
  const typeFilter = document.getElementById('targetTypeFilter');
  const statusFilter = document.getElementById('targetStatusFilter');
  const sourceFilter = document.getElementById('targetSourceFilter');
  const sortFilter = document.getElementById('targetSortFilter');

  const search = searchInput ? searchInput.value.trim() : '';
  const type = typeFilter ? typeFilter.value : '';
  const status = statusFilter ? statusFilter.value : '';
  const source = sourceFilter ? sourceFilter.value : '';
  const sort = sortFilter ? sortFilter.value : 'newest';

  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (type) params.append('type', type);
  if (status) params.append('status', status);
  if (source) params.append('source', source);
  if (sort) params.append('sort', sort);
  params.append('page', page);
  params.append('limit', '15');

  try {
    const res = await fetch(`/api/targets?${params.toString()}`);
    const data = await res.json();
    cachedTargets = data.targets || [];
    targetsTotalPages = data.totalPages || 1;

    // 5 Monitoring KPI Counters
    if (data.kpi) {
      const elTotal = document.getElementById('monKpiTotal');
      const elActive = document.getElementById('monKpiActive');
      const elPaused = document.getElementById('monKpiPaused');
      const elError = document.getElementById('monKpiError');
      const elAlerts = document.getElementById('monKpiAlerts');
      if (elTotal) elTotal.textContent = (data.kpi.totalTargets || 0).toLocaleString();
      if (elActive) elActive.textContent = (data.kpi.activeTargets || 0).toLocaleString();
      if (elPaused) elPaused.textContent = (data.kpi.pausedTargets || 0).toLocaleString();
      if (elError) elError.textContent = (data.kpi.errorTargets || 0).toLocaleString();
      if (elAlerts) elAlerts.textContent = (data.kpi.unresolvedAlerts || 0).toLocaleString();
    }

    renderTargetsTable(cachedTargets);

    // Pagination controls
    const infoEl = document.getElementById('targetPaginationInfo');
    const pageCurrentEl = document.getElementById('targetPageCurrent');
    const btnPrev = document.getElementById('btnPrevPage');
    const btnNext = document.getElementById('btnNextPage');
    const totalCount = data.totalCount !== undefined ? data.totalCount : cachedTargets.length;

    if (infoEl) {
      if (totalCount === 0) {
        infoEl.textContent = 'Hiển thị 0 bài viết';
      } else {
        const start = (page - 1) * 15 + 1;
        const end = Math.min(page * 15, totalCount);
        infoEl.textContent = `Hiển thị ${start}-${end} trên tổng số ${totalCount} bài viết`;
      }
    }
    if (pageCurrentEl) pageCurrentEl.textContent = `${page} / ${targetsTotalPages}`;
    if (btnPrev) btnPrev.disabled = (page <= 1);
    if (btnNext) btnNext.disabled = (page >= targetsTotalPages);

    const countEl = document.getElementById('tabTargetsCount');
    if (countEl) countEl.textContent = totalCount;
  } catch (err) {
    console.error('Lỗi tải targets:', err);
  }
}

function changeTargetPage(delta) {
  const newPage = currentTargetsPage + delta;
  if (newPage >= 1 && newPage <= targetsTotalPages) {
    fetchTargets(newPage);
  }
}

function renderTargetsTable(targets) {
  cachedTargets = targets || [];
  const tbody = document.getElementById('targetsTableBody');
  if (!tbody) return;
  if (targets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="p-8 text-center text-txt-sub">Chưa có liên kết Facebook nào được giám sát. Nhấn "Thêm bài viết giám sát" ở trên.</td></tr>`;
    return;
  }

  tbody.innerHTML = targets.map(t => {
    let statusClass = 'status-active';
    let statusText = 'Hoạt động 24/7';
    if (t.status === 'PAUSED') { 
      statusClass = 'status-paused'; 
      statusText = 'Tạm dừng'; 
    } else if (t.status === 'PENDING') { 
      statusClass = 'status-limited'; 
      statusText = 'Chờ xử lý'; 
    } else if (t.status === 'SYNCING') { 
      statusClass = 'status-active'; 
      statusText = 'Đang đồng bộ'; 
    } else if (t.status === 'RATE_LIMITED' || t.status === 'DATA_LIMITED') { 
      statusClass = 'status-limited'; 
      statusText = 'Bị giới hạn'; 
    } else if (t.status === 'PERMISSION_REQUIRED') { 
      statusClass = 'status-inaccessible'; 
      statusText = 'Cần quyền'; 
    } else if (t.status === 'INACCESSIBLE' || t.status === 'ERROR') { 
      statusClass = 'status-inaccessible'; 
      statusText = 'Lỗi truy cập'; 
    }

    let accountPill = '';
    if (t.bound_account_name) {
      accountPill = `<span class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-brand-blue/20 text-brand-cyan border border-brand-cyan/20 font-medium" title="Phiên tài khoản quản trị"><svg class="w-2.5 h-2.5 text-brand-cyan shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg><span>${t.bound_account_name}</span></span>`;
    } else if (t.latest_source_type === 'LOCAL_SIDECAR') {
      accountPill = `<span class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium" title="Định tuyến Local Sidecar"><svg class="w-2.5 h-2.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg><span>Sidecar (IP Dân cư)</span></span>`;
    } else if (t.latest_source_type === 'MBASIC') {
      accountPill = `<span class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium" title="Phiên mbasic Cookie"><svg class="w-2.5 h-2.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg><span>Clone Cookie</span></span>`;
    } else if (t.latest_source_type === 'GRAPH_API') {
      accountPill = `<span class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-brand-blue/20 text-brand-cyan border border-brand-cyan/20 font-medium" title="Chính thức Meta Graph API"><svg class="w-2.5 h-2.5 text-brand-cyan shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg><span>Meta Graph API</span></span>`;
    } else {
      accountPill = `<span class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-surface-elevated text-txt-sub border border-surface-border font-medium"><svg class="w-2.5 h-2.5 text-txt-sub shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg><span>Tự động quét</span></span>`;
    }

    const avatarSrc = t.author_avatar || t.post_image || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&h=80&fit=crop';
    const postMediaThumb = (t.post_image && t.post_image !== t.author_avatar)
      ? `<img src="${t.post_image}" referrerpolicy="no-referrer" alt="media" title="Ảnh bài viết Facebook" class="w-8 h-8 rounded-lg object-cover bg-gray-800 border border-surface-border shrink-0 hover:scale-105 transition shadow-sm" onerror="this.style.display='none'">`
      : '';

    // Calculate growth delta
    const delta5m = t.latest_growth_5m !== null && t.latest_growth_5m !== undefined 
      ? t.latest_growth_5m 
      : ((t.latest_reactions || 0) - (t.baseline_reactions || 0));
    const delta5mBadge = delta5m > 0
      ? `<span class="text-emerald-400 font-semibold inline-flex items-center gap-0.5"><svg class="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 10l7-7m0 0l7 7m-7-7v18"></path></svg>+${delta5m.toLocaleString()}</span>`
      : (delta5m < 0 
          ? `<span class="text-rose-400 font-semibold inline-flex items-center gap-0.5"><svg class="w-3 h-3 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>${delta5m.toLocaleString()}</span>`
          : `<span class="text-txt-muted font-medium">+0</span>`);

    return `
      <tr class="hover:bg-surface-elevated/50 transition">
        <td class="p-3.5">
          <div class="flex items-center gap-2.5">
            <div class="relative shrink-0">
              <img src="${avatarSrc}" referrerpolicy="no-referrer" class="w-8 h-8 rounded-lg object-cover bg-gray-800 border border-surface-border" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&h=80&fit=crop'">
            </div>
            ${postMediaThumb}
            <div class="max-w-[220px]">
              <div class="font-medium text-txt-title truncate">${t.author_name || 'Facebook Item'}</div>
              <a href="${t.normalized_url}" target="_blank" class="text-[11px] text-txt-sub hover:text-brand-cyan truncate block">${t.normalized_url}</a>
            </div>
          </div>
        </td>
        <td class="p-3.5">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-elevated text-txt-sub border border-surface-border">
            ${t.target_type || 'POST'}
          </span>
        </td>
        <td class="p-3.5 text-right font-semibold text-brand-cyan">${(t.latest_reactions || 0).toLocaleString()}</td>
        <td class="p-3.5 text-right font-semibold text-txt-title">${(t.latest_comments || 0).toLocaleString()}</td>
        <td class="p-3.5 text-right font-semibold text-emerald-400">${(t.latest_shares || 0).toLocaleString()}</td>
        <td class="p-3.5 text-center">${delta5mBadge}</td>
        <td class="p-3.5 text-center">
          <div class="inline-flex flex-col items-center">
            <button onclick="promptChangeInterval(${t.id}, ${t.check_interval_sec})" title="Nhấp để đổi chu kỳ quét" class="font-medium text-txt-title hover:text-brand-cyan flex items-center gap-1 group transition cursor-pointer">
              <span>${t.check_interval_sec}s</span>
              <svg class="w-3 h-3 text-txt-muted group-hover:text-brand-cyan transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
            </button>
            <span id="target-countdown-${t.id}" class="text-[10px] text-brand-cyan font-mono">...</span>
          </div>
        </td>
        <td class="p-3.5 text-center">
          <div class="inline-flex flex-col items-center">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusClass}">${statusText}</span>
            ${accountPill}
          </div>
        </td>
        <td class="p-3.5 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <button onclick="openDetailModal(${t.id})" class="px-2.5 py-1 bg-surface-elevated hover:bg-brand-blue/30 text-brand-cyan rounded-lg text-xs font-semibold transition border border-surface-border">Chi tiết</button>
            <button id="btn-sync-${t.id}" onclick="syncTargetNow(${t.id})" title="Đồng bộ tức thời" class="p-1.5 bg-surface-elevated hover:bg-brand-blue/30 text-brand-cyan rounded-lg text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            </button>
            <button onclick="togglePause(${t.id}, '${t.status}')" title="${t.status === 'PAUSED' ? 'Tiếp tục giám sát' : 'Tạm dừng giám sát'}" class="p-1.5 bg-surface-elevated hover:bg-surface text-txt-body rounded-lg text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              ${t.status === 'PAUSED' ? '<svg class="w-3.5 h-3.5 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path></svg>' : '<svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6"></path></svg>'}
            </button>
            <button onclick="promptChangeInterval(${t.id}, ${t.check_interval_sec})" title="Đổi chu kỳ quét" class="p-1.5 bg-surface-elevated hover:bg-surface text-txt-body rounded-lg text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              <svg class="w-3.5 h-3.5 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            </button>
            <button onclick="deleteTarget(${t.id})" title="Xóa liên kết" class="p-1.5 bg-surface-elevated hover:bg-rose-500/20 text-rose-400 rounded-lg text-xs transition border border-surface-border active:scale-95 cursor-pointer">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  updateRowCountdowns();
}

// --- Quick Interval Modification ---
function promptChangeInterval(id, currInterval) {
  const input = prompt(`Cấu hình chu kỳ quét cho bài viết #${id} (giây):\nCác mốc khuyên dùng: 15s (nhạy cảm), 30s, 60s, 300s (khuyến nghị chống checkpoint)`, currInterval || 300);
  if (!input) return;
  const sec = parseInt(input.trim(), 10);
  if (isNaN(sec) || sec < 5 || sec > 86400) {
    return alert('Chu kỳ quét không hợp lệ (nhập từ 5 đến 86400 giây)');
  }
  updateTargetInterval(id, sec);
}

async function updateTargetInterval(id, checkIntervalSec) {
  try {
    const res = await fetch(`/api/targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ check_interval_sec: checkIntervalSec })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await fetchTargets(currentTargetsPage);
    showNoticeModal({
      title: 'Đã đổi chu kỳ giám sát',
      message: `Chu kỳ bài viết #${id} đã đổi sang ${checkIntervalSec} giây.`,
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi cập nhật', message: err.message, type: 'error' });
  }
}

// --- Target Quick Actions ---
async function syncAllTargetsNow() {
  const btn = document.getElementById('btnSyncAllTargets');
  const icon = document.getElementById('syncAllIcon');
  if (icon) icon.classList.add('animate-spin');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/targets/sync-all', { method: 'POST' });
    const data = await res.json();
    await fetchTargets(currentTargetsPage);
    if (currentTab === 'overview') await fetchOverview();
    showNoticeModal({
      title: 'Đồng bộ toàn bộ hoàn tất',
      message: `Đã kích hoạt quét đồng bộ tức thời cho ${data.count || 'tất cả'} đối tượng giám sát đang hoạt động.`,
      type: 'success'
    });
  } catch (e) {
    showNoticeModal({ title: 'Lỗi đồng bộ', message: e.message, type: 'error' });
  } finally {
    if (icon) icon.classList.remove('animate-spin');
    if (btn) btn.disabled = false;
  }
}

async function syncTargetNow(id) {
  const btn = document.getElementById(`btn-sync-${id}`);
  const icon = btn ? btn.querySelector('svg') : null;
  if (icon) icon.classList.add('animate-spin');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/targets/${id}/sync-now`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await fetchTargets(currentTargetsPage);
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
    fetchTargets(currentTargetsPage);
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
        fetchTargets(currentTargetsPage);
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
  loadTargetDetail(id, currentDetailRange);
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.add('hidden');
  currentDetailTargetId = null;
}

async function syncDetailTargetNow() {
  if (!currentDetailTargetId) return;
  const btn = document.getElementById('btnDetailSyncNow');
  const icon = document.getElementById('detailSyncIcon');
  if (icon) icon.classList.add('animate-spin');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/targets/${currentDetailTargetId}/sync-now`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await loadTargetDetail(currentDetailTargetId, currentDetailRange);
    fetchTargets(currentTargetsPage);
  } catch (e) {
    showNoticeModal({ title: 'Lỗi đồng bộ', message: e.message, type: 'error' });
  } finally {
    if (icon) icon.classList.remove('animate-spin');
    if (btn) btn.disabled = false;
  }
}

function setDetailTimeRange(range) {
  currentDetailRange = range;
  document.querySelectorAll('.detail-time-btn').forEach(btn => {
    if (btn.getAttribute('data-range') === range) {
      btn.className = 'detail-time-btn px-2 py-1 rounded-lg text-[11px] font-semibold bg-brand-blue text-white shadow-sm border border-brand-cyan/20';
    } else {
      btn.className = 'detail-time-btn px-2 py-1 rounded-lg text-[11px] font-medium text-txt-sub hover:text-txt-body transition';
    }
  });
  const badge = document.getElementById('detailRangeBadge');
  if (badge) badge.textContent = range;
  if (currentDetailTargetId) {
    loadTargetDetail(currentDetailTargetId, range);
  }
}

async function loadTargetDetail(id, range = currentDetailRange) {
  try {
    const res = await fetch(`/api/targets/${id}?range=${range}`);
    const data = await res.json();
    const t = data.target;
    const snap = data.latestSnapshot;
    const auth = data.authenticity || {};
    const delta = data.deltaPeriod || { reactions: 0, comments: 0, shares: 0 };

    document.getElementById('detailAvatar').src = t.author_avatar || t.post_image || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&h=80&fit=crop';
    
    // Post Media preview card
    const mediaCard = document.getElementById('detailMediaCard');
    const postImg = document.getElementById('detailPostImage');
    if (mediaCard && postImg) {
      if (t.post_image) {
        postImg.src = t.post_image;
        mediaCard.classList.remove('hidden');
      } else {
        mediaCard.classList.add('hidden');
      }
    }

    document.getElementById('detailAuthor').textContent = t.author_name || 'Facebook Post';
    document.getElementById('detailTypeBadge').textContent = t.target_type || 'POST';
    document.getElementById('detailStatusBadge').textContent = t.status || 'ACTIVE';
    document.getElementById('detailSnippet').textContent = t.content_snippet || t.normalized_url;
    document.getElementById('detailLink').href = t.normalized_url;

    const sourceBadgeEl = document.getElementById('detailSourceTypeBadge');
    if (sourceBadgeEl) {
      sourceBadgeEl.textContent = t.latest_source_type === 'LOCAL_SIDECAR' ? 'Nguồn: Local Sidecar (IP Dân cư)' : (t.latest_source_type === 'GRAPH_API' ? 'Nguồn: Meta Graph API' : (t.latest_source_type === 'MBASIC' ? 'Nguồn: Clone Cookie mbasic' : 'Nguồn: Hệ thống'));
    }

    // Engagement Totals and Percentages
    const totalRx = snap ? (snap.total_reactions || 0) : (t.latest_reactions || 0);
    const totalCmt = snap ? (snap.total_comments || 0) : (t.latest_comments || 0);
    const totalSh = snap ? (snap.total_shares || 0) : (t.latest_shares || 0);
    const sumEngagement = Math.max(1, totalRx + totalCmt + totalSh);

    const rxPct = ((totalRx / sumEngagement) * 100).toFixed(1);
    const cmtPct = ((totalCmt / sumEngagement) * 100).toFixed(1);
    const shPct = ((totalSh / sumEngagement) * 100).toFixed(1);

    document.getElementById('detailTotalReactions').textContent = totalRx.toLocaleString();
    document.getElementById('detailDeltaReactions').textContent = `+${delta.reactions.toLocaleString()} (${range})`;
    const shareRxPctEl = document.getElementById('detailShareReactionsPct');
    if (shareRxPctEl) shareRxPctEl.textContent = `${rxPct}%`;

    document.getElementById('detailTotalComments').textContent = totalCmt.toLocaleString();
    document.getElementById('detailDeltaComments').textContent = `+${delta.comments.toLocaleString()} (${range})`;
    const shareCmtPctEl = document.getElementById('detailShareCommentsPct');
    if (shareCmtPctEl) shareCmtPctEl.textContent = `${cmtPct}%`;

    document.getElementById('detailTotalShares').textContent = totalSh.toLocaleString();
    document.getElementById('detailDeltaShares').textContent = `+${delta.shares.toLocaleString()} (${range})`;
    const shareShPctEl = document.getElementById('detailShareSharesPct');
    if (shareShPctEl) shareShPctEl.textContent = `${shPct}%`;

    // 7 Reactions breakdown
    render7ReactionsBreakdown(snap, totalRx);

    // Authenticity breakdown
    const totalEng = auth.totalEngagement || sumEngagement;
    const organicCount = auth.organicCount || 0;
    const unknownCount = auth.unknownCount !== undefined ? auth.unknownCount : Math.max(0, totalEng - organicCount);
    const suspiciousCount = auth.suspiciousCount || 0;

    const orgPct = totalEng > 0 ? ((organicCount / totalEng) * 100).toFixed(1) : 0;
    const suspPct = totalEng > 0 ? ((suspiciousCount / totalEng) * 100).toFixed(1) : 0;
    const unkPct = Math.max(0, (100 - parseFloat(orgPct) - parseFloat(suspPct))).toFixed(1);

    const barOrg = document.getElementById('detailBarOrganic');
    const barUnk = document.getElementById('detailBarUnknown');
    const barSusp = document.getElementById('detailBarSuspicious');
    if (barOrg) barOrg.style.width = `${orgPct}%`;
    if (barUnk) barUnk.style.width = `${unkPct}%`;
    if (barSusp) barSusp.style.width = `${suspPct}%`;

    const valOrgPct = document.getElementById('detailValOrganicPct');
    const valOrgCnt = document.getElementById('detailValOrganicCount');
    const valUnkPct = document.getElementById('detailValUnknownPct');
    const valUnkCnt = document.getElementById('detailValUnknownCount');
    const valSuspPct = document.getElementById('detailValSuspiciousPct');
    const valSuspCnt = document.getElementById('detailValSuspiciousCount');
    if (valOrgPct) valOrgPct.textContent = `${orgPct}%`;
    if (valOrgCnt) valOrgCnt.textContent = `${organicCount.toLocaleString()} tài khoản`;
    if (valUnkPct) valUnkPct.textContent = `${unkPct}%`;
    if (valUnkCnt) valUnkCnt.textContent = `${unknownCount.toLocaleString()} tương tác`;
    if (valSuspPct) valSuspPct.textContent = `${suspPct}%`;
    if (valSuspCnt) valSuspCnt.textContent = `${suspiciousCount.toLocaleString()} nghi vấn`;

    // Timeline Chart
    renderDetailHistoryChart(data.snapshots || []);

    // Identifiable Accounts
    currentDetailAccounts = data.interactedAccounts || [];
    filterDetailAccounts();

    // Alert configs
    const cfg = data.alertConfig || {};
    document.getElementById('cfgReactionSpike').value = cfg.reaction_spike_threshold || 50;
    document.getElementById('cfgCommentSurge').value = cfg.comment_surge_threshold || 20;
    document.getElementById('cfgShareBurst').value = cfg.share_burst_threshold || 10;
  } catch (err) {
    console.error('Lỗi tải chi tiết target:', err);
  }
}

function render7ReactionsBreakdown(snap, totalRx = 0) {
  const container = document.getElementById('reactionBarsContainer');
  if (!snap) {
    container.innerHTML = '<div class="col-span-7 text-xs text-txt-sub py-2">Đang chờ lần đồng bộ dữ liệu đầu tiên...</div>';
    return;
  }

  const sumRx = Math.max(1, totalRx || 1);
  const items = [
    { 
      label: 'Like', 
      count: snap.like_count || 0,
      pct: (((snap.like_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>'
    },
    { 
      label: 'Love', 
      count: snap.love_count || 0, 
      pct: (((snap.love_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path></svg>'
    },
    { 
      label: 'Care', 
      count: snap.care_count || 0, 
      pct: (((snap.care_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>'
    },
    { 
      label: 'Haha', 
      count: snap.haha_count || 0, 
      pct: (((snap.haha_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
    },
    { 
      label: 'Wow', 
      count: snap.wow_count || 0, 
      pct: (((snap.wow_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>'
    },
    { 
      label: 'Sad', 
      count: snap.sad_count || 0, 
      pct: (((snap.sad_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-txt-sub" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>'
    },
    { 
      label: 'Angry', 
      count: snap.angry_count || 0, 
      pct: (((snap.angry_count || 0) / sumRx) * 100).toFixed(1),
      svg: '<svg class="w-4 h-4 mx-auto text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>'
    },
  ];

  container.innerHTML = items.map(i => `
    <div class="rx-vector-box rounded-xl p-2.5 bg-surface-elevated/40 border border-surface-border flex flex-col justify-between">
      <div>
        <div class="mb-1">${i.svg}</div>
        <div class="text-xs font-bold text-txt-title">${(i.count || 0).toLocaleString()}</div>
        <div class="text-[10px] text-brand-cyan font-mono font-medium">${i.pct}%</div>
      </div>
      <div class="text-[10px] text-txt-sub mt-1 uppercase tracking-wider font-semibold border-t border-surface-border/50 pt-1">${i.label}</div>
    </div>
  `).join('');
}

function renderDetailHistoryChart(snapshots) {
  const ctx = document.getElementById('detailHistoryChart').getContext('2d');
  const labels = snapshots.map(s => {
    const d = new Date(s.observed_at);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  });
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
      plugins: { 
        legend: { labels: { color: theme.textColor, font: { size: 11 } } },
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
}

function filterDetailAccounts() {
  const searchInput = document.getElementById('detailAccountSearchInput');
  const typeFilter = document.getElementById('detailAccountTypeFilter');
  const term = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filterVal = typeFilter ? typeFilter.value.toUpperCase() : '';

  let filtered = currentDetailAccounts || [];

  if (filterVal) {
    if (filterVal === 'COMMENT') {
      filtered = filtered.filter(a => (a.interaction_type || '').toUpperCase() === 'COMMENT');
    } else if (filterVal === 'REACTION') {
      filtered = filtered.filter(a => (a.interaction_type || '').toUpperCase() === 'REACTION');
    } else if (['LIKE', 'LOVE', 'CARE', 'HAHA', 'WOW', 'SAD', 'ANGRY'].includes(filterVal)) {
      filtered = filtered.filter(a => (a.reaction_type || '').toUpperCase() === filterVal);
    }
  }

  if (term) {
    filtered = filtered.filter(a => {
      const name = (a.display_name || '').toLowerCase();
      const text = (a.comment_text || '').toLowerCase();
      const url = (a.profile_url || '').toLowerCase();
      return name.includes(term) || text.includes(term) || url.includes(term);
    });
  }

  const container = document.getElementById('detailInteractedList');
  const countBadge = document.getElementById('detailIdentifiedCount');
  if (countBadge) countBadge.textContent = `${filtered.length} tương tác`;

  if (!container) return;
  if (filtered.length === 0) {
    container.innerHTML = '<div class="text-txt-sub italic py-6 text-center">Chưa có bình luận hoặc tài khoản tương tác nào được bóc tách phù hợp với bộ lọc. Bấm "Đồng bộ quét tài khoản" để cập nhật.</div>';
    return;
  }

  container.innerHTML = filtered.map(a => {
    const isComment = (a.interaction_type || '').toUpperCase() === 'COMMENT';
    const reactionType = (a.reaction_type || 'LIKE').toUpperCase();

    // Styled badge according to reaction type or comment
    let badgeHtml = '';
    if (isComment) {
      badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] bg-brand-blue/20 text-brand-cyan border border-brand-cyan/20 inline-flex items-center gap-1 font-semibold shrink-0">
        <svg class="w-3 h-3 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
        <span>Bình luận</span>
      </span>`;
    } else {
      const reactionStyles = {
        LIKE: { bg: 'bg-blue-500/10 text-blue-400 border-blue-500/20', label: 'Thích (LIKE)', icon: '👍' },
        LOVE: { bg: 'bg-rose-500/10 text-rose-400 border-rose-500/20', label: 'Yêu thích (LOVE)', icon: '❤️' },
        CARE: { bg: 'bg-amber-500/10 text-amber-400 border-amber-500/20', label: 'Thương thương (CARE)', icon: '🥰' },
        HAHA: { bg: 'bg-amber-500/10 text-amber-400 border-amber-500/20', label: 'Haha (HAHA)', icon: '😆' },
        WOW: { bg: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20', label: 'Wow (WOW)', icon: '😮' },
        SAD: { bg: 'bg-sky-500/10 text-sky-400 border-sky-500/20', label: 'Buồn (SAD)', icon: '😢' },
        ANGRY: { bg: 'bg-rose-600/10 text-rose-500 border-rose-600/20', label: 'Phẫn nộ (ANGRY)', icon: '😡' }
      };
      const rStyle = reactionStyles[reactionType] || reactionStyles.LIKE;
      badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] ${rStyle.bg} border inline-flex items-center gap-1 font-semibold shrink-0">
        <span>${rStyle.icon}</span>
        <span>${rStyle.label}</span>
      </span>`;
    }

    // Personal profile URL link
    const profileUrl = a.profile_url || (a.fb_user_id ? `https://www.facebook.com/${a.fb_user_id}` : null);
    const profileLink = profileUrl
      ? `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="font-semibold text-txt-title hover:text-brand-cyan transition inline-flex items-center gap-1 group truncate" title="Mở trang cá nhân Facebook">
          <span class="truncate">${a.display_name}</span>
          <svg class="w-3 h-3 text-txt-sub group-hover:text-brand-cyan transition shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
        </a>`
      : `<span class="font-semibold text-txt-title truncate">${a.display_name}</span>`;

    const avatar = a.avatar_url || (a.fb_user_id && /^\d+$/.test(a.fb_user_id) ? `https://graph.facebook.com/${a.fb_user_id}/picture?type=normal` : 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop');

    // Comment content bubble
    const commentBody = a.comment_text
      ? `<div class="mt-1.5 bg-surface-elevated/70 p-2.5 rounded-xl border border-surface-border text-xs text-txt-body break-words">
          <span class="text-[10px] text-txt-sub font-mono block mb-0.5">Nội dung bình luận:</span>
          <span>${a.comment_text}</span>
        </div>`
      : '';

    const directUrlLink = profileUrl
      ? `<a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-brand-cyan hover:underline truncate block mt-0.5 font-mono max-w-sm" title="${profileUrl}">${profileUrl}</a>`
      : '<span class="text-[10px] text-txt-sub italic mt-0.5 block">Chưa công khai profile link</span>';

    return `
      <div class="py-3 flex items-start gap-3 hover:bg-surface-elevated/30 px-2 rounded-xl transition">
        <img src="${avatar}" referrerpolicy="no-referrer" class="w-9 h-9 rounded-full object-cover bg-surface-border border border-surface-border shrink-0" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop'">
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-1">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              ${profileLink}
              ${badgeHtml}
            </div>
            <span class="text-[10px] text-txt-sub font-mono shrink-0">${a.observed_at ? formatRelativeTime(a.observed_at) : ''}</span>
          </div>
          ${directUrlLink}
          ${commentBody}
        </div>
      </div>
    `;
  }).join('');
}

async function syncDetailTargetNow() {
  if (!currentDetailTargetId) return;
  const btn = document.getElementById('btnSyncDetailTarget');
  const icon = btn ? btn.querySelector('svg') : null;
  if (icon) icon.classList.add('animate-spin');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/targets/${currentDetailTargetId}/sync-now`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await loadTargetDetail(currentDetailTargetId);
    showNoticeModal({ title: 'Đã gửi lệnh quét', message: 'Hệ thống đang tiến hành bóc tách tài khoản tương tác và bình luận mới nhất.', type: 'success' });
  } catch (e) {
    showNoticeModal({ title: 'Lỗi', message: e.message, type: 'error' });
  } finally {
    if (icon) icon.classList.remove('animate-spin');
    if (btn) btn.disabled = false;
  }
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

let cachedProxies = [];

// --- 5. Accounts Modal & Meta OAuth ---
function openAccountsModal() {
  document.getElementById('accountsModal').classList.remove('hidden');
  fetchProxiesList();
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
          sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20 inline-flex items-center gap-1.5';
          sidecarBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>Hoạt động (${diffSec}s trước)</span>`;
        } else {
          sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-surface-elevated text-txt-sub border border-surface-border inline-flex items-center gap-1.5';
          sidecarBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Chờ kết nối</span>';
        }
      } else {
        sidecarBadge.className = 'text-[10px] px-2 py-0.5 rounded bg-surface-elevated text-txt-sub border border-surface-border inline-flex items-center gap-1.5';
        sidecarBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Chưa kích hoạt</span>';
      }
    }
  } catch (err) {
    console.warn('Lỗi tải settings:', err);
  }
}

// --- Multi-Proxy Pool & Independent Session Isolation ---
function toggleBatchProxyInput() {
  const box = document.getElementById('batchProxyBox');
  if (box) box.classList.toggle('hidden');
}

async function fetchProxiesList() {
  try {
    const res = await fetch('/api/proxies');
    const data = await res.json();
    cachedProxies = data.proxies || [];

    const listEl = document.getElementById('proxyPoolList');
    const statsEl = document.getElementById('proxyPoolStats');
    if (!listEl) return;

    const liveCount = cachedProxies.filter(p => p.status === 'LIVE').length;
    const dieCount = cachedProxies.filter(p => p.status === 'DIE').length;
    const total = cachedProxies.length;
    if (statsEl) statsEl.textContent = `Danh sách Proxy (${liveCount} LIVE / ${dieCount} DIE / ${total} Tổng):`;

    if (cachedProxies.length === 0) {
      listEl.innerHTML = '<div class="p-3 text-center text-txt-sub text-[11px] font-sans">Chưa có proxy nào trong pool. Nhấn "+ Nhập hàng loạt" ở trên để nạp.</div>';
      return;
    }

    listEl.innerHTML = cachedProxies.map(p => {
      let statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span><span>Đang test...</span></span>';
      if (p.status === 'LIVE') {
        statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>LIVE ${p.latency_ms}ms${p.exit_ip ? ' (' + p.exit_ip + ')' : ''}</span></span>`;
      } else if (p.status === 'DIE') {
        statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30 inline-flex items-center gap-1.5"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span><span>DIE</span></span>';
      }

      const boundBadge = p.bound_account_name
        ? `<span class="px-1.5 py-0.5 rounded text-[10px] bg-brand-cyan/15 text-brand-cyan border border-brand-cyan/30 font-sans inline-flex items-center gap-1" title="Đã gán độc lập cho account này"><svg class="w-3 h-3 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg><span>${p.bound_account_name}</span></span>`
        : '<span class="text-txt-muted text-[10px] font-sans">Chưa gán</span>';

      return `
        <div class="p-2.5 flex items-center justify-between hover:bg-surface-elevated/80 transition">
          <div class="flex items-center gap-2 max-w-[50%] truncate">
            <span class="text-[10px] px-1 py-0.5 rounded bg-surface border border-surface-border text-txt-muted font-bold">${(p.protocol || 'http').toUpperCase()}</span>
            <span class="font-bold text-txt-title truncate" title="${p.raw_proxy}">${p.host}:${p.port}</span>
            ${p.username ? `<span class="text-[10px] text-txt-sub font-mono truncate">(${p.username})</span>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${boundBadge}
            ${statusBadge}
            <button onclick="testSingleProxy(${p.id})" class="p-1 bg-surface hover:bg-surface-elevated text-brand-cyan border border-surface-border rounded transition active:scale-95" title="Test lại proxy này"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button>
            <button onclick="deleteProxy(${p.id})" class="p-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 rounded transition active:scale-95" title="Xóa proxy"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách proxies:', err);
  }
}

async function submitBatchProxies() {
  const textarea = document.getElementById('batchProxyInput');
  const text = textarea ? textarea.value.trim() : '';
  if (!text) {
    return showNoticeModal({
      title: 'Chưa có dữ liệu',
      message: 'Vui lòng dán danh sách proxy vào ô nhập liệu (mỗi proxy một dòng).',
      type: 'warning'
    });
  }

  try {
    const res = await fetch('/api/proxies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxies: text })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    textarea.value = '';
    fetchProxiesList();

    showNoticeModal({
      title: 'Nạp Proxy thành công',
      message: `Đã nạp thành công ${data.imported} proxy mới vào hệ thống. Node.js Sidecar đang tự động ping kiểm tra kết nối...`,
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi nạp Proxy', message: err.message, type: 'error' });
  }
}

async function testAllProxies() {
  const btn = document.getElementById('btnTestAllProxies');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/proxies/request-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    fetchProxiesList();
    showNoticeModal({
      title: 'Đang kiểm tra kết nối Proxy',
      message: 'Đã gửi lệnh kiểm tra tới Local Sidecar. Toàn bộ proxy trong pool đang được test kết nối và đo ping...',
      type: 'info'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi gửi yêu cầu', message: err.message, type: 'error' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testSingleProxy(id) {
  try {
    await fetch('/api/proxies/request-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy_id: id })
    });
    fetchProxiesList();
  } catch (e) {
    console.error('Lỗi test single proxy:', e);
  }
}

async function deleteProxy(id) {
  showConfirmDialog({
    title: 'Xóa Proxy',
    message: 'Bạn có chắc chắn muốn xóa proxy này khỏi pool?',
    confirmText: 'Xóa vĩnh viễn',
    onConfirm: async () => {
      try {
        await fetch(`/api/proxies/${id}`, { method: 'DELETE' });
        fetchProxiesList();
        fetchAccountsList();
      } catch (e) {
        showNoticeModal({ title: 'Lỗi xóa proxy', message: e.message, type: 'error' });
      }
    }
  });
}

async function autoAssignProxies() {
  const btn = document.getElementById('btnAutoAssignProxies');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/proxies/auto-assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    fetchProxiesList();
    fetchAccountsList();

    showNoticeModal({
      title: 'Cấu hình 1:1 độc lập thành công',
      message: `Đã phân bổ độc lập ${data.assigned_count}/${data.total_accounts} tài khoản mỗi account một proxy dân cư riêng biệt. Phiên cookie của từng nick sẽ được bảo vệ tuyệt đối!`,
      type: 'success'
    });
  } catch (err) {
    showNoticeModal({ title: 'Lỗi gán tự động', message: err.message, type: 'error' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function assignProxyToAccount(accId, proxyUrl) {
  try {
    const res = await fetch(`/api/accounts/${accId}/assign-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy_url: proxyUrl })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    fetchAccountsList();
    fetchProxiesList();
  } catch (err) {
    showNoticeModal({ title: 'Lỗi gán Proxy', message: err.message, type: 'error' });
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

      const proxyBadge = acc.proxy_url
        ? `<div class="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-emerald-400">
             <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
             <svg class="w-3 h-3 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path></svg>
             <span class="truncate max-w-[200px]" title="${acc.proxy_url}">${acc.proxy_url.replace(/https?:\/\/([^@]+@)?/, '').replace(/socks5:\/\/([^@]+@)?/, '')} (Proxy riêng)</span>
             <button onclick="assignProxyToAccount(${acc.id}, null)" class="text-rose-400 hover:text-rose-300 ml-1 p-0.5 inline-flex items-center" title="Gỡ bỏ Proxy riêng"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
           </div>`
        : `<div class="mt-1 flex items-center gap-1.5 text-[11px] text-txt-muted">
             <span class="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
             <span>Chưa gán Proxy riêng (Dùng IP máy)</span>
           </div>`;

      // Options for proxy selector
      const proxyOptions = cachedProxies.map(p => {
        const auth = p.username && p.password ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
        const url = `${p.protocol}://${auth}${p.host}:${p.port}`;
        const isSelected = acc.proxy_url && (acc.proxy_url === url || acc.proxy_url.includes(p.host));
        return `<option value="${url}" ${isSelected ? 'selected' : ''}>${p.host}:${p.port} (${p.status})</option>`;
      }).join('');

      return `
        <div class="p-3 flex items-center justify-between bg-surface text-xs border-b border-surface-border">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-txt-title">${acc.name}</span>
              ${typeBadge}
            </div>
            <div class="text-[11px] text-txt-sub mt-0.5">ID: ${acc.fb_account_id} | Đồng bộ: ${acc.last_sync_at ? new Date(acc.last_sync_at).toLocaleTimeString('vi-VN') : 'Chưa có'}</div>
            ${proxyBadge}
          </div>
          <div class="flex items-center gap-2">
            ${cachedProxies.length > 0 ? `
              <select onchange="assignProxyToAccount(${acc.id}, this.value)" class="text-[11px] bg-surface-elevated border border-surface-border text-txt-body rounded px-1.5 py-1 max-w-[130px]" title="Chọn Proxy độc lập cho nick này">
                <option value="">-- Gán Proxy --</option>
                ${proxyOptions}
              </select>
            ` : ''}
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

// --- 6. Alerts & Notifications Engine (Redesigned - Prompt 03) ---
let currentAlertsPage = 1;
const alertsPageLimit = 15;
let alertsTotalPages = 1;
let cachedAlertsList = [];
let alertSearchTimeout = null;
let currentDetailAlert = null;

// Modern SVG Icon generator for Alerts
function getAlertIcon(type, severity) {
  if (severity === 'CRITICAL' || type === 'AUTH_LOST') {
    return `<svg class="w-4 h-4 text-rose-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>`;
  }
  if (type === 'REACTION_SPIKE' || type === 'COMMENT_SURGE' || type === 'SHARE_BURST' || type === 'VIRAL_SHIFT') {
    return `<svg class="w-4 h-4 text-brand-cyan shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>`;
  }
  if (type === 'ENGAGEMENT_DROP') {
    return `<svg class="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6"></path></svg>`;
  }
  if (type === 'SUSPICIOUS_GROWTH' || type === 'UNUSUAL_HOURS') {
    return `<svg class="w-4 h-4 text-purple-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>`;
  }
  return `<svg class="w-4 h-4 text-txt-sub shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path></svg>`;
}

function getAlertSeverityBadge(severity) {
  switch (severity) {
    case 'CRITICAL':
      return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">CRITICAL</span>`;
    case 'HIGH':
      return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">HIGH</span>`;
    case 'WARNING':
      return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-yellow-500/10 text-yellow-400 border border-yellow-500/30">WARNING</span>`;
    default:
      return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/10 text-sky-400 border border-sky-500/30">INFO</span>`;
  }
}

function getAlertGroupBadge(type) {
  if (['REACTION_SPIKE', 'COMMENT_SURGE', 'SHARE_BURST', 'VIRAL_SHIFT', 'ENGAGEMENT_DROP'].includes(type)) {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-brand-cyan/10 text-brand-cyan border border-brand-cyan/20">Tương tác</span>`;
  }
  if (['SUSPICIOUS_GROWTH', 'UNUSUAL_HOURS'].includes(type)) {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">Nghi vấn</span>`;
  }
  if (['TARGET_PAUSED', 'TARGET_RESUMED', 'TARGET_CONFIG_CHANGED'].includes(type)) {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Giám sát</span>`;
  }
  if (['AUTH_LOST', 'ACCOUNT_RATE_LIMITED', 'PROXY_FAILED'].includes(type)) {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">Quyền & Token</span>`;
  }
  return `<span class="px-2 py-0.5 rounded text-[10px] font-medium bg-surface-elevated text-txt-sub border border-surface-border">Hệ thống</span>`;
}

function getAlertStatusBadge(status) {
  if (status === 'RESOLVED') {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">ĐÃ GIẢI QUYẾT</span>`;
  }
  if (status === 'ACKNOWLEDGED') {
    return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">ĐÃ TIẾP NHẬN</span>`;
  }
  return `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">CẦN XỬ LÝ (OPEN)</span>`;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const t = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - t) / 1000);
  if (diffSec < 45) return 'vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  return `${Math.floor(diffSec / 86400)} ngày trước`;
}

// --- Header Notification Bell & Dropdown ---
function toggleNotificationDropdown() {
  const dd = document.getElementById('notificationDropdown');
  if (!dd) return;
  const isHidden = dd.classList.contains('hidden');
  if (isHidden) {
    dd.classList.remove('hidden');
    fetchAlerts(1, true);
  } else {
    dd.classList.add('hidden');
  }
}

function openAlertsCenterFromDropdown() {
  const dd = document.getElementById('notificationDropdown');
  if (dd) dd.classList.add('hidden');
  switchTab('alerts');
}

document.addEventListener('click', (e) => {
  const bell = document.getElementById('btnNotificationBell');
  const dropdown = document.getElementById('notificationDropdown');
  if (bell && dropdown && !dropdown.classList.contains('hidden')) {
    if (!bell.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }
});

function debounceFetchAlerts() {
  clearTimeout(alertSearchTimeout);
  alertSearchTimeout = setTimeout(() => {
    fetchAlerts(1);
  }, 350);
}

function changeAlertPage(delta) {
  const target = currentAlertsPage + delta;
  if (target >= 1 && target <= alertsTotalPages) {
    fetchAlerts(target);
  }
}

// --- Main Alert Center Fetcher ---
async function fetchAlerts(page = currentAlertsPage, isDropdownOnly = false) {
  const refreshIcon = document.getElementById('refreshAlertsIcon');
  if (refreshIcon) refreshIcon.classList.add('animate-spin');

  try {
    const search = document.getElementById('alertSearchInput')?.value.trim() || '';
    const read = document.getElementById('alertReadFilter')?.value || '';
    const status = document.getElementById('alertStatusFilter')?.value || '';
    const severity = document.getElementById('alertSeverityFilter')?.value || '';
    const group = document.getElementById('alertGroupFilter')?.value || '';
    const timeframe = document.getElementById('alertTimeframeFilter')?.value || '';

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(alertsPageLimit));
    if (search) params.set('search', search);
    if (read) params.set('read', read);
    if (status) params.set('status', status);
    if (severity) params.set('severity', severity);
    if (group) params.set('group', group);
    if (timeframe && timeframe !== 'ALL') params.set('timeframe', timeframe);

    const res = await fetch(`/api/alerts?${params.toString()}`);
    const data = await res.json();

    if (!data || !data.alerts) return;

    currentAlertsPage = data.page || page;
    alertsTotalPages = data.totalPages || 1;
    cachedAlertsList = data.alerts;

    // 1. Update Header Badges & Tab Counter
    const unreadCount = data.unreadCount || (data.kpis?.unreadCount) || 0;
    const bellBadge = document.getElementById('unreadAlertCount');
    if (bellBadge) {
      if (unreadCount > 0) {
        bellBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        bellBadge.classList.remove('hidden');
      } else {
        bellBadge.classList.add('hidden');
      }
    }
    const tabBadge = document.getElementById('tabAlertsCount');
    if (tabBadge) {
      tabBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    }
    const dropBadge = document.getElementById('dropdownUnreadBadge');
    if (dropBadge) {
      dropBadge.textContent = `${unreadCount} chưa đọc`;
    }

    // 2. Render 5 latest in Dropdown List
    const dropList = document.getElementById('dropdownNotificationList');
    if (dropList) {
      const top5 = data.alerts.slice(0, 5);
      if (top5.length === 0) {
        dropList.innerHTML = '<div class="p-6 text-center text-txt-sub italic">Không có thông báo mới nào.</div>';
      } else {
        dropList.innerHTML = top5.map(a => `
          <div onclick="openAlertDetail(${a.id}); toggleNotificationDropdown();" class="p-3 hover:bg-surface-elevated/70 cursor-pointer transition flex items-start gap-2.5 ${!a.is_read ? 'bg-surface-elevated/30' : ''}">
            <div class="mt-0.5">${getAlertIcon(a.alert_type, a.severity)}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-1">
                <span class="font-semibold text-txt-title truncate text-[11px]">${a.alert_type}</span>
                <span class="text-[10px] text-txt-sub font-mono shrink-0">${formatRelativeTime(a.detected_at)}</span>
              </div>
              <p class="text-[11px] text-txt-body truncate mt-0.5">${a.message}</p>
            </div>
            ${!a.is_read ? '<span class="w-2 h-2 rounded-full bg-rose-500 mt-1 shrink-0 animate-pulse"></span>' : ''}
          </div>
        `).join('');
      }
    }

    if (isDropdownOnly) return;

    // 3. Update 4 KPI Cards
    const kpiTotal = document.getElementById('alertKpiTotal');
    const kpiUnread = document.getElementById('alertKpiUnread');
    const kpiCritical = document.getElementById('alertKpiCritical');
    const kpiOpen = document.getElementById('alertKpiOpen');

    if (kpiTotal) kpiTotal.textContent = (data.kpis?.totalNotifications || 0).toLocaleString();
    if (kpiUnread) kpiUnread.textContent = (data.kpis?.unreadCount || 0).toLocaleString();
    if (kpiCritical) kpiCritical.textContent = (data.kpis?.criticalAlerts || 0).toLocaleString();
    if (kpiOpen) kpiOpen.textContent = (data.kpis?.openAlerts || 0).toLocaleString();

    // 4. Render Table Body
    const tbody = document.getElementById('alertsTableBody');
    if (tbody) {
      if (data.alerts.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-txt-sub italic">Không tìm thấy thông báo hoặc cảnh báo nào phù hợp với bộ lọc hiện tại.</td></tr>`;
      } else {
        tbody.innerHTML = data.alerts.map(a => {
          const isUnread = !a.is_read;
          const detectedDate = new Date(a.detected_at).toLocaleString('vi-VN');
          const relTime = formatRelativeTime(a.detected_at);
          let parsedPayload = {};
          try {
            parsedPayload = typeof a.payload === 'string' ? JSON.parse(a.payload) : (a.payload || {});
          } catch (_) {}

          let deltaBadge = '';
          if (parsedPayload.delta !== undefined && parsedPayload.delta !== null) {
            const d = parsedPayload.delta;
            deltaBadge = `<span class="ml-2 font-mono text-[10px] font-bold px-1.5 py-0.2 rounded ${d >= 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">${d >= 0 ? '+' : ''}${d}</span>`;
          }

          const authorName = a.author_name || (a.target_author ? a.target_author : 'Hệ thống Telemetry');
          const avatarUrl = a.target_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&auto=format&fit=crop&q=60';
          const targetUrl = a.normalized_url || '#';

          return `
            <tr class="hover:bg-surface-elevated/40 transition ${isUnread ? 'bg-surface-elevated/20' : ''}">
              <td class="p-3.5 align-middle">
                <div class="flex flex-col gap-1 items-start">
                  ${getAlertSeverityBadge(a.severity)}
                  ${getAlertGroupBadge(a.alert_type)}
                </div>
              </td>
              <td class="p-3.5 align-middle max-w-xs">
                <div class="flex items-start gap-2">
                  <div class="mt-0.5">${getAlertIcon(a.alert_type, a.severity)}</div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="font-bold text-txt-title">${a.alert_type}</span>
                      ${deltaBadge}
                      ${isUnread ? '<span class="w-2 h-2 rounded-full bg-rose-500 inline-block animate-pulse"></span>' : ''}
                    </div>
                    <p class="text-txt-body text-[11px] mt-0.5 line-clamp-2">${a.message}</p>
                  </div>
                </div>
              </td>
              <td class="p-3.5 align-middle max-w-[200px]">
                <div class="flex items-center gap-2 min-w-0">
                  <img src="${avatarUrl}" alt="author" referrerpolicy="no-referrer" class="w-7 h-7 rounded-lg object-cover bg-surface-border border border-surface-border shrink-0">
                  <div class="min-w-0 flex-1">
                    <div class="font-semibold text-txt-title truncate text-[11px]">${authorName}</div>
                    <a href="${targetUrl}" target="_blank" rel="noopener noreferrer" class="text-[10px] text-brand-cyan hover:underline truncate block font-mono" title="${targetUrl}">
                      ${targetUrl.replace(/^https?:\/\/(www\.)?facebook\.com\//, '')}
                    </a>
                  </div>
                </div>
              </td>
              <td class="p-3.5 align-middle whitespace-nowrap">
                <div class="font-mono text-[11px] text-txt-body">${detectedDate}</div>
                <div class="text-[10px] text-txt-sub">${relTime}</div>
              </td>
              <td class="p-3.5 align-middle text-center whitespace-nowrap">
                ${getAlertStatusBadge(a.status || (a.acknowledged ? 'ACKNOWLEDGED' : 'OPEN'))}
              </td>
              <td class="p-3.5 align-middle text-right whitespace-nowrap">
                <div class="flex items-center justify-end gap-1.5">
                  <button onclick="toggleAlertRead(${a.id}, ${a.is_read ? 1 : 0})" title="${a.is_read ? 'Đánh dấu chưa đọc' : 'Đánh dấu đã đọc'}" class="p-1.5 bg-surface hover:bg-surface-elevated text-txt-sub hover:text-txt-title rounded-lg border border-surface-border transition cursor-pointer">
                    ${a.is_read ? `
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"></path></svg>
                    ` : `
                      <svg class="w-3.5 h-3.5 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                    `}
                  </button>
                  ${(a.status === 'OPEN' || !a.acknowledged) ? `
                    <button onclick="ackAlert(${a.id})" title="Tiếp nhận cảnh báo" class="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-[10px] font-semibold transition cursor-pointer">
                      Tiếp nhận
                    </button>
                  ` : (a.status === 'ACKNOWLEDGED') ? `
                    <button onclick="resolveAlert(${a.id})" title="Đánh dấu đã giải quyết" class="px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-semibold transition cursor-pointer">
                      Giải quyết
                    </button>
                  ` : `
                    <span class="text-[10px] text-txt-sub italic">Đã xong</span>
                  `}
                  <button onclick="openAlertDetail(${a.id})" title="Chi tiết" class="p-1.5 bg-surface hover:bg-surface-elevated text-brand-cyan rounded-lg border border-surface-border transition cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                  </button>
                  <button onclick="deleteAlert(${a.id})" title="Xóa thông báo" class="p-1.5 bg-surface hover:bg-rose-500/20 text-txt-sub hover:text-rose-400 rounded-lg border border-surface-border transition cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                  </button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // 5. Update Pagination Info & Buttons
    const pagInfo = document.getElementById('alertPaginationInfo');
    const pagCur = document.getElementById('alertPageCurrent');
    const btnPrev = document.getElementById('btnAlertPrevPage');
    const btnNext = document.getElementById('btnAlertNextPage');

    const totalCount = data.totalCount || 0;
    if (pagInfo) {
      if (totalCount === 0) {
        pagInfo.textContent = 'Hiển thị 0 thông báo';
      } else {
        const start = (currentAlertsPage - 1) * alertsPageLimit + 1;
        const end = Math.min(currentAlertsPage * alertsPageLimit, totalCount);
        pagInfo.textContent = `Hiển thị ${start} - ${end} trên tổng số ${totalCount} thông báo`;
      }
    }
    if (pagCur) pagCur.textContent = String(currentAlertsPage);
    if (btnPrev) btnPrev.disabled = (currentAlertsPage <= 1);
    if (btnNext) btnNext.disabled = (currentAlertsPage >= alertsTotalPages);

  } catch (e) {
    console.error('Lỗi fetchAlerts:', e);
  } finally {
    if (refreshIcon) refreshIcon.classList.remove('animate-spin');
  }
}

// --- Alert Lifecycle Handlers ---
async function markAllNotificationsRead() {
  try {
    const res = await fetch('/api/alerts/read-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNoticeModal({ title: 'Đã hoàn tất', message: 'Tất cả thông báo đã được đánh dấu là đã đọc thành công.', type: 'success' });
      fetchAlerts(currentAlertsPage);
      fetchOverview();
    }
  } catch (e) {
    showNoticeModal({ title: 'Lỗi', message: e.message, type: 'error' });
  }
}

async function toggleAlertRead(id, currentIsRead) {
  try {
    const endpoint = currentIsRead ? `/api/alerts/${id}/unread` : `/api/alerts/${id}/read`;
    await fetch(endpoint, { method: 'PATCH' });
    fetchAlerts(currentAlertsPage);
  } catch (e) {
    showNoticeModal({ title: 'Lỗi', message: e.message, type: 'error' });
  }
}

async function ackAlert(id) {
  try {
    await fetch(`/api/alerts/${id}/ack`, { method: 'PATCH' });
    fetchAlerts(currentAlertsPage);
    fetchOverview();
  } catch (e) {
    showNoticeModal({ title: 'Lỗi', message: e.message, type: 'error' });
  }
}

async function resolveAlert(id) {
  try {
    await fetch(`/api/alerts/${id}/resolve`, { method: 'PATCH' });
    fetchAlerts(currentAlertsPage);
    fetchOverview();
  } catch (e) {
    showNoticeModal({ title: 'Lỗi', message: e.message, type: 'error' });
  }
}

function deleteAlert(id) {
  showConfirmDialog({
    title: 'Xóa thông báo',
    message: 'Bạn có chắc chắn muốn xóa bản ghi cảnh báo này khỏi lịch sử hệ thống?',
    acceptText: 'Xóa ngay',
    cancelText: 'Hủy bỏ',
    onConfirm: async () => {
      try {
        await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
        fetchAlerts(currentAlertsPage);
        fetchOverview();
      } catch (e) {
        showNoticeModal({ title: 'Lỗi xóa', message: e.message, type: 'error' });
      }
    }
  });
}

// --- Section VII: Alert Detail Modal & Drawer ---
async function openAlertDetail(id) {
  try {
    let alertData = cachedAlertsList.find(a => a.id === id);
    if (!alertData) {
      const res = await fetch(`/api/alerts/${id}`);
      const data = await res.json();
      alertData = data.alert;
    }
    if (!alertData) return;

    currentDetailAlert = alertData;

    // Auto mark as read when opened if unread
    if (!alertData.is_read) {
      fetch(`/api/alerts/${id}/read`, { method: 'PATCH' }).then(() => {
        alertData.is_read = 1;
        fetchAlerts(currentAlertsPage);
      }).catch(() => {});
    }

    const modal = document.getElementById('alertDetailModal');
    if (!modal) return;

    // Icon & Header
    const iconBox = document.getElementById('alertDetailIconBox');
    if (iconBox) {
      iconBox.className = `w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${alertData.severity === 'CRITICAL' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30' : 'bg-brand-blue/10 text-brand-cyan border border-brand-cyan/30'}`;
      iconBox.innerHTML = getAlertIcon(alertData.alert_type, alertData.severity);
    }

    document.getElementById('alertDetailTitle').textContent = alertData.alert_type;

    const sevBadge = document.getElementById('alertDetailSeverityBadge');
    if (sevBadge) {
      sevBadge.className = `text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${alertData.severity === 'CRITICAL' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}`;
      sevBadge.textContent = alertData.severity;
    }

    const stBadge = document.getElementById('alertDetailStatusBadge');
    if (stBadge) {
      const st = alertData.status || (alertData.acknowledged ? 'ACKNOWLEDGED' : 'OPEN');
      stBadge.className = `text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${st === 'RESOLVED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : st === 'ACKNOWLEDGED' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`;
      stBadge.textContent = st;
    }

    document.getElementById('alertDetailTime').textContent = `${new Date(alertData.detected_at).toLocaleString('vi-VN')} (${formatRelativeTime(alertData.detected_at)})`;

    // Related Facebook Target
    const avatarImg = document.getElementById('alertDetailTargetAvatar');
    if (avatarImg) {
      avatarImg.src = alertData.target_avatar || 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=80&auto=format&fit=crop&q=60';
    }
    const nameEl = document.getElementById('alertDetailTargetName');
    if (nameEl) nameEl.textContent = alertData.author_name || alertData.target_author || 'Hệ thống NHN Telemetry';

    const urlEl = document.getElementById('alertDetailTargetUrl');
    if (urlEl) {
      urlEl.href = alertData.normalized_url || '#';
      urlEl.textContent = alertData.normalized_url || 'Không có liên kết';
    }

    // Parse Payload for Fluctuations
    let payload = {};
    try {
      payload = typeof alertData.payload === 'string' ? JSON.parse(alertData.payload) : (alertData.payload || {});
    } catch (_) {}

    document.getElementById('alertDetailOldVal').textContent = (payload.oldVal ?? payload.previousValue ?? 0).toLocaleString();
    document.getElementById('alertDetailNewVal').textContent = (payload.newVal ?? payload.currentValue ?? 0).toLocaleString();
    
    const deltaEl = document.getElementById('alertDetailDeltaVal');
    const dVal = payload.delta ?? 0;
    deltaEl.textContent = `${dVal >= 0 ? '+' : ''}${dVal.toLocaleString()}`;
    deltaEl.className = `text-sm font-bold mt-0.5 ${dVal >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;

    document.getElementById('alertDetailThresholdVal').textContent = payload.threshold ? `+${payload.threshold}` : 'Mặc định';

    // Detailed Context Explanation
    let explanationText = alertData.message;
    if (payload.growthRate) {
      explanationText += ` Tỷ lệ gia tăng ước tính: ${payload.growthRate}%.`;
    }
    if (alertData.alert_type === 'REACTION_SPIKE' || alertData.alert_type === 'COMMENT_SURGE') {
      explanationText += ' Tín hiệu lan truyền vượt ngưỡng cảnh báo tự nhiên trong chu kỳ kiểm tra. Cần theo dõi thêm để phát hiện hành vi tăng tương tác bất thường hoặc seeding diện rộng.';
    } else if (alertData.alert_type === 'SUSPICIOUS_GROWTH') {
      explanationText += ' Cảnh báo chỉ số tăng trưởng bất thường trong khung giờ thấp điểm hoặc phân bố cảm xúc lệch chuẩn (nhiều Angry/Haha đột biến). Cần kiểm tra nguồn tương tác.';
    } else if (alertData.alert_type === 'AUTH_LOST') {
      explanationText += ' Phiên làm việc (Cookie/Token) của tài khoản quét đã bị đăng xuất hoặc hết hạn. Vui lòng cấp lại tài khoản Meta để tiếp tục giám sát.';
    }
    document.getElementById('alertDetailExplanation').textContent = explanationText;

    // 3 Lifecycles Status
    const readLife = document.getElementById('alertDetailReadLife');
    if (readLife) {
      readLife.innerHTML = alertData.is_read ? `<span class="text-emerald-400">Đã đọc (${alertData.read_at ? new Date(alertData.read_at).toLocaleTimeString('vi-VN') : 'Vừa xong'})</span>` : `<span class="text-rose-400">Chưa đọc</span>`;
    }

    const resLife = document.getElementById('alertDetailResolutionLife');
    if (resLife) {
      const curStatus = alertData.status || (alertData.acknowledged ? 'ACKNOWLEDGED' : 'OPEN');
      if (curStatus === 'RESOLVED') {
        resLife.innerHTML = `<span class="text-emerald-400">Đã giải quyết (${alertData.resolved_at ? new Date(alertData.resolved_at).toLocaleTimeString('vi-VN') : 'Hoàn tất'})</span>`;
      } else if (curStatus === 'ACKNOWLEDGED') {
        resLife.innerHTML = `<span class="text-amber-400">Đã tiếp nhận (${alertData.acknowledged_at ? new Date(alertData.acknowledged_at).toLocaleTimeString('vi-VN') : 'Đang xử lý'})</span>`;
      } else {
        resLife.innerHTML = `<span class="text-rose-400">Chưa xử lý (Đang chờ tiếp nhận)</span>`;
      }
    }

    // Modal action buttons state
    const btnToggle = document.getElementById('btnToggleReadSingle');
    if (btnToggle) {
      btnToggle.textContent = alertData.is_read ? 'Đánh dấu chưa đọc' : 'Đánh dấu đã đọc';
    }

    const btnAck = document.getElementById('btnAckSingle');
    if (btnAck) {
      btnAck.style.display = (alertData.status === 'RESOLVED' || alertData.status === 'ACKNOWLEDGED') ? 'none' : 'inline-block';
    }

    const btnRes = document.getElementById('btnResolveSingle');
    if (btnRes) {
      btnRes.style.display = (alertData.status === 'RESOLVED') ? 'none' : 'inline-block';
    }

    modal.classList.remove('hidden');
  } catch (e) {
    console.error('Lỗi openAlertDetail:', e);
  }
}

function closeAlertDetailModal() {
  const modal = document.getElementById('alertDetailModal');
  if (modal) modal.classList.add('hidden');
  currentDetailAlert = null;
}

function jumpToTargetFromAlert() {
  if (currentDetailAlert && currentDetailAlert.target_id) {
    const tId = currentDetailAlert.target_id;
    closeAlertDetailModal();
    switchTab('targets');
    loadTargetDetail(tId);
  }
}

async function toggleAlertReadSingle() {
  if (!currentDetailAlert) return;
  await toggleAlertRead(currentDetailAlert.id, currentDetailAlert.is_read);
  closeAlertDetailModal();
}

async function ackAlertSingle() {
  if (!currentDetailAlert) return;
  await ackAlert(currentDetailAlert.id);
  closeAlertDetailModal();
}

async function resolveAlertSingle() {
  if (!currentDetailAlert) return;
  await resolveAlert(currentDetailAlert.id);
  closeAlertDetailModal();
}

// --- Section VI: Alert Rules Modal Engine ---
async function openAlertRulesModal() {
  const modal = document.getElementById('alertRulesModal');
  if (!modal) return;

  // 1. Populate Target dropdown
  try {
    const res = await fetch('/api/targets?limit=100');
    const data = await res.json();
    const select = document.getElementById('ruleTargetSelect');
    if (select) {
      select.innerHTML = '<option value="">Toàn bộ bài viết (Global Rule)</option>' +
        (data.targets || []).map(t => `<option value="${t.id}">${t.author_name || t.normalized_url}</option>`).join('');
    }
  } catch (_) {}

  // 2. Fetch and render existing rules
  await fetchAlertRules();

  modal.classList.remove('hidden');
}

function closeAlertRulesModal() {
  const modal = document.getElementById('alertRulesModal');
  if (modal) modal.classList.add('hidden');
}

async function fetchAlertRules() {
  const container = document.getElementById('alertRulesListContainer');
  const countBadge = document.getElementById('rulesCountBadge');
  if (!container) return;

  try {
    const res = await fetch('/api/alert-rules');
    const data = await res.json();
    const rules = data.rules || [];

    if (countBadge) countBadge.textContent = `${rules.length} quy tắc`;

    if (rules.length === 0) {
      container.innerHTML = `<div class="p-6 text-center text-txt-sub italic">Chưa có quy tắc cảnh báo nào được cấu hình. Thêm mới ở biểu mẫu phía trên.</div>`;
      return;
    }

    container.innerHTML = rules.map(r => `
      <div class="p-3 bg-surface hover:bg-surface-elevated/40 transition flex items-center justify-between gap-3 text-xs">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-bold text-txt-title">${r.name}</span>
            <span class="px-2 py-0.2 rounded text-[10px] font-bold ${r.severity === 'CRITICAL' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}">${r.severity}</span>
            <span class="text-[10px] text-txt-sub bg-surface-elevated px-2 py-0.2 rounded border border-surface-border">${r.target_author ? r.target_author : 'Toàn cầu (Global)'}</span>
          </div>
          <div class="text-[11px] text-txt-body mt-1 flex flex-wrap items-center gap-2">
            <span>Theo dõi: <strong class="text-brand-cyan">${r.metric}</strong></span>
            <span>Điều kiện: <strong>${r.condition === 'gt_count' ? 'Tăng +' : 'Vượt tổng'} ${r.threshold}</strong></span>
            <span>Khung giờ: <strong>${r.time_window}</strong></span>
            <span>Cooldown: <strong>${r.cooldown_seconds}s</strong></span>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <label class="relative inline-flex items-center cursor-pointer" title="Bật / Tắt quy tắc">
            <input type="checkbox" onchange="toggleAlertRule(${r.id}, ${r.is_active ? 1 : 0})" ${r.is_active ? 'checked' : ''} class="sr-only peer">
            <div class="w-8 h-4.5 bg-surface-border peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-brand-cyan"></div>
          </label>
          <button onclick="deleteAlertRule(${r.id})" title="Xóa quy tắc" class="p-1.5 bg-surface hover:bg-rose-500/20 text-txt-sub hover:text-rose-400 rounded-lg border border-surface-border transition cursor-pointer">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    console.error('Lỗi fetchAlertRules:', e);
  }
}

async function submitCreateAlertRule() {
  const nameInput = document.getElementById('ruleNameInput');
  const targetSelect = document.getElementById('ruleTargetSelect');
  const metricSelect = document.getElementById('ruleMetricSelect');
  const condSelect = document.getElementById('ruleConditionSelect');
  const threshInput = document.getElementById('ruleThresholdInput');
  const winSelect = document.getElementById('ruleTimeWindowSelect');
  const sevSelect = document.getElementById('ruleSeveritySelect');
  const cdInput = document.getElementById('ruleCooldownInput');
  const chkBrowser = document.getElementById('chkChannelBrowser');

  const name = nameInput?.value.trim();
  const threshold = parseInt(threshInput?.value, 10);

  if (!name) {
    showNoticeModal({ title: 'Thiếu thông tin', message: 'Vui lòng nhập tên quy tắc cảnh báo.', type: 'warning' });
    return;
  }
  if (isNaN(threshold) || threshold <= 0) {
    showNoticeModal({ title: 'Sai ngưỡng', message: 'Ngưỡng kích hoạt phải là số nguyên dương lớn hơn 0.', type: 'warning' });
    return;
  }

  const payload = {
    name,
    target_id: targetSelect?.value ? parseInt(targetSelect.value, 10) : null,
    metric: metricSelect?.value || 'reactions',
    condition: condSelect?.value || 'gt_count',
    threshold,
    time_window: winSelect?.value || '5M',
    severity: sevSelect?.value || 'WARNING',
    cooldown_seconds: parseInt(cdInput?.value, 10) || 300,
    channels: {
      in_app: true,
      browser: chkBrowser ? chkBrowser.checked : true
    }
  };

  try {
    const res = await fetch('/api/alert-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showNoticeModal({ title: 'Thành công', message: 'Đã tạo và kích hoạt quy tắc cảnh báo mới.', type: 'success' });
      nameInput.value = '';
      fetchAlertRules();
    } else {
      showNoticeModal({ title: 'Lỗi', message: data.error || 'Không thể tạo quy tắc', type: 'error' });
    }
  } catch (e) {
    showNoticeModal({ title: 'Lỗi tạo rule', message: e.message, type: 'error' });
  }
}

async function toggleAlertRule(id, currentActive) {
  try {
    await fetch(`/api/alert-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: currentActive ? 0 : 1 })
    });
    fetchAlertRules();
  } catch (e) {
    showNoticeModal({ title: 'Lỗi cập nhật', message: e.message, type: 'error' });
  }
}

function deleteAlertRule(id) {
  showConfirmDialog({
    title: 'Xóa quy tắc cảnh báo',
    message: 'Bạn có chắc chắn muốn xóa quy tắc này? Các biến động sau này sẽ không còn kích hoạt theo quy tắc này nữa.',
    acceptText: 'Xóa ngay',
    cancelText: 'Hủy bỏ',
    onConfirm: async () => {
      try {
        await fetch(`/api/alert-rules/${id}`, { method: 'DELETE' });
        fetchAlertRules();
      } catch (e) {
        showNoticeModal({ title: 'Lỗi xóa rule', message: e.message, type: 'error' });
      }
    }
  });
}

// --- Desktop Browser Native Notifications ---
async function requestBrowserNotificationPermission() {
  if (!('Notification' in window)) {
    showNoticeModal({ title: 'Không hỗ trợ', message: 'Trình duyệt hiện tại không hỗ trợ Web Notification API.', type: 'info' });
    return;
  }

  if (Notification.permission === 'granted') {
    new Notification('NHN Telemetry - Giám sát Facebook', {
      body: 'Thông báo Desktop đang hoạt động bình thường.',
      icon: '/favicon.ico'
    });
    showNoticeModal({ title: 'Đã sẵn sàng', message: 'Quyền thông báo Desktop đã được cấp trước đó.', type: 'success' });
    return;
  }

  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      new Notification('NHN Telemetry - Giám sát Facebook', {
        body: 'Kích hoạt thông báo thành công! Cảnh báo nghiêm trọng sẽ xuất hiện ngay cả khi thu nhỏ trình duyệt.',
        icon: '/favicon.ico'
      });
      showNoticeModal({ title: 'Đã kích hoạt', message: 'Bạn sẽ nhận được thông báo Desktop ngay lập tức khi phát hiện biến động.', type: 'success' });
    } else {
      showNoticeModal({ title: 'Chưa cấp quyền', message: 'Bạn đã từ chối nhận thông báo Desktop từ trình duyệt.', type: 'warning' });
    }
  } catch (e) {
    console.error('Lỗi Notification permission:', e);
  }
}

function dispatchDesktopNotification(alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const title = `[${alert.severity || 'ALERT'}] ${alert.alertType || alert.alert_type || 'Cảnh báo tương tác'}`;
    const n = new Notification(title, {
      body: alert.message || 'Phát hiện biến động tương tác mới',
      icon: '/favicon.ico',
      tag: `alert_${alert.id || Date.now()}`
    });
    n.onclick = () => {
      window.focus();
      if (alert.id) openAlertDetail(alert.id);
    };
  } catch (e) {
    console.warn('Lỗi dispatch desktop notification:', e);
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
