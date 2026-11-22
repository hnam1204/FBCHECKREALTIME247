const { createServer } = require('./api/server');
const monitorScheduler = require('./scheduler/monitorScheduler');
const { runSidecarTick } = require('./sidecarAgent');
const config = require('./config');

const { server } = createServer();

server.listen(config.port, config.host, () => {
  console.log(`=======================================================`);
  console.log(`[c4] FACEBOOK INTERACTION MONITOR - 24/7 ONLINE`);
  console.log(`[c4] Server:    http://${config.host}:${config.port}`);
  console.log(`[c4] Database:  ${config.dbPath}`);
  console.log(`[c4] Simulator: ${config.enableDevSimulator ? 'BẬT (Mô phỏng minh bạch phát triển)' : 'TẮT (Chế độ Graph API độc quyền)'}`);
  console.log(`[c4] Sidecar:   Kích hoạt cào ngầm IP Dân Cư (Chu kỳ an toàn 300s/bài viết)`);
  console.log(`=======================================================`);

  // Start continuous 24/7 background scheduler loop
  monitorScheduler.start();

  // Check and run due targets every 30s (tuân thủ chu kỳ 300s của từng bài)
  setInterval(() => {
    runSidecarTick().catch(e => console.error('[c4] Lỗi vòng lặp Sidecar:', e.message));
  }, 30000);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\n[c4] Nhận tín hiệu ${signal}. Đang tắt dịch vụ an toàn...`);
  monitorScheduler.stop();
  server.close(() => {
    console.log('[c4] Đã đóng máy chủ HTTP & WebSocket. Dừng tiến trình.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
