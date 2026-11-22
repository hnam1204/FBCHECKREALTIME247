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
  const type = typeFilter ? typeFilter.value.toUpperCase() : '';

  let filtered = currentDetailAccounts || [];
  if (type) {
    filtered = filtered.filter(a => (a.interaction_type || '').toUpperCase() === type);
  }
  if (term) {
    filtered = filtered.filter(a => {
      const name = (a.display_name || '').toLowerCase();
      const text = (a.comment_text || '').toLowerCase();
      return name.includes(term) || text.includes(term);
    });
  }

  const container = document.getElementById('detailInteractedList');
  const countBadge = document.getElementById('detailIdentifiedCount');
  if (countBadge) countBadge.textContent = `${filtered.length} tương tác`;

  if (!container) return;
  if (filtered.length === 0) {
    container.innerHTML = '<div class="text-txt-sub italic py-4 text-center">Không có tương tác nào khớp với bộ lọc hoặc bài viết chưa có dữ liệu tương tác bóc tách.</div>';
    return;
  }

  container.innerHTML = filtered.map(a => {
    const isComment = (a.interaction_type || '').toUpperCase() === 'COMMENT';
    const typeBadge = isComment
      ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-brand-blue/20 text-brand-cyan border border-brand-cyan/20 inline-flex items-center gap-1 font-medium"><svg class="w-3 h-3 text-brand-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg><span>Bình luận</span></span>'
      : `<span class="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 inline-flex items-center gap-1 font-medium"><svg class="w-3 h-3 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg><span>Cảm xúc (${a.reaction_type || 'Like'})</span></span>`;
    
    const profileLink = a.profile_url
      ? `<a href="${a.profile_url}" target="_blank" class="font-semibold text-txt-title hover:text-brand-cyan transition">${a.display_name}</a>`
      : `<span class="font-semibold text-txt-title">${a.display_name}</span>`;

    const avatar = a.avatar_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop';
    const commentBody = a.comment_text
      ? `<p class="text-xs text-txt-body mt-1 bg-surface-elevated/60 p-2 rounded-lg border border-surface-border break-words">${a.comment_text}</p>`
      : '';

    return `
      <div class="py-2.5 flex items-start gap-3 hover:bg-surface-elevated/30 px-2 rounded-xl transition">
        <img src="${avatar}" referrerpolicy="no-referrer" class="w-8 h-8 rounded-full object-cover bg-gray-800 border border-surface-border shrink-0" onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=60&h=60&fit=crop'">
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
