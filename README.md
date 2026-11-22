# Facebook Interaction Monitor (FB-IM) 24/7

Nền tảng giám sát và phân tích tương tác Facebook tự động 24/7, tối ưu siêu nhẹ, hiệu năng cao, hoạt động độc lập và không phụ thuộc giao diện trình duyệt người dùng.

---

## 1. Kiến trúc hệ thống

```
                           +----------------------------------------+
                           |     Web Browser (SPA / Dashboard)      |
                           +-------------------+--------------------+
                                               | (HTTP REST / WebSocket)
                                               v
+------------------------------------------------------------------------------------+
|                                 Node.js API Server                                 |
+------------------------------------------------------------------------------------+
       |                                       |                               |
       v                                       v                               v
+--------------+                      +-------------------+           +--------------+
| URL Analyzer |                      |  Account Manager  |           | Alert Engine |
| Normalizer   |                      | (AES-256-GCM Meta |           | Anomaly/Spike|
| Type Detect  |                      |  OAuth & Scopes)  |           | Thresholds   |
+--------------+                      +-------------------+           +--------------+
       |                                       |                               ^
       +-------------------+-------------------+                               |
                           v                                                   |
            +------------------------------+                                   |
            |   24/7 Monitoring Scheduler  |                                   |
            | (Priority Queue / Backoff)   |                                   |
            +--------------+---------------+                                   |
                           |                                                   |
                           v                                                   |
            +------------------------------+                                   |
            |        Data Collector        |                                   |
            | (Meta Graph API / Simulator) |                                   |
            +--------------+---------------+                                   |
                           |                                                   |
                           v                                                   |
            +------------------------------+                                   |
            |       Snapshot Engine        |-----------------------------------+
            | (Diffs / 7 Reactions / Rates)|
            +--------------+---------------+
                           |
                           v
            +------------------------------+
            | SQLite DB (WAL / node:sqlite)|
            +------------------------------+
```

### Các module chính:
1. **URL Analyzer (`src/analyzer/urlAnalyzer.js`)**:
   - Loại bỏ toàn bộ tracking query params (`fbclid`, `__cft__`, `ref`...).
   - Nhận diện định dạng: Bài viết (`post`), Video Watch, Reel, Nhóm (`group_post`), Trang cá nhân (`profile`), Fanpage.
   - Trích xuất ID nội dung, kiểm tra tính trùng lặp và xác định tính khả thi giám sát.
2. **Account Manager (`src/auth/accountManager.js`)**:
   - Quản lý tập trung các tài khoản và Fanpage được cấp quyền.
   - Mã hóa bảo mật toàn bộ token bằng thuật toán chuẩn AES-256-GCM (Auth Tag).
   - Theo dõi trạng thái kết nối, scopes (`pages_read_engagement`, `pages_read_user_content`), tự động bắt lỗi hết hạn token.
3. **Data Collector (`src/collector/dataCollector.js`)**:
   - Truy vấn trực tiếp Meta Graph API: bóc tách 7 loại cảm xúc, danh sách bình luận (kèm profile tác giả khi được cấp quyền), tổng lượt chia sẻ.
   - Chế độ Sandbox Simulation minh bạch (theo nguyên tắc chất lượng #10) giúp nhà phát triển kiểm thử ngay lập tức mà không cần tạo ứng dụng Meta trả phí.
4. **Snapshot Engine (`src/engine/snapshotEngine.js`)**:
   - Lưu trữ mốc dữ liệu tham chiếu (baseline).
   - Tính toán biến động (delta reactions, delta comments, delta shares).
   - Đo tốc độ tăng trưởng trên các cửa sổ thời gian 5 phút, 1 giờ, 24 giờ.
5. **Alert Engine (`src/analytics/alertEngine.js`)**:
   - Tự động phát hiện biến động bất thường: Tăng vọt cảm xúc (`REACTION_SPIKE`), Đột biến bình luận (`COMMENT_SURGE`), Bùng nổ chia sẻ (`SHARE_BURST`), Chuyển trạng thái bùng nổ (`VIRAL_SHIFT`), Mất quyền truy cập (`AUTH_LOST`).
   - Phát cảnh báo thời gian thực qua WebSocket.
6. **24/7 Scheduler (`src/scheduler/monitorScheduler.js`)**:
   - Điều phối hàng đợi định kỳ độc lập với phiên người dùng, tự động phục hồi sau khi khởi động lại máy chủ.
7. **Frontend Dashboard (`public/`)**:
   - Giao diện Single Page Application hiện đại, dark mode, biểu đồ Chart.js trực quan, cập nhật tự động bằng WebSocket.

---

## 2. Hướng dẫn cài đặt & Khởi chạy

### Yêu cầu môi trường:
- Node.js >= 22 (khuyên dùng Node 22+ có sẵn `node:sqlite` tích hợp).
- npm >= 10.

### Bước 1: Cài đặt thư viện
```bash
npm install
```

### Bước 2: Chạy bộ kiểm thử tự động
```bash
npm test
```
Tất cả 12 kiểm thử (URL Analyzer, Crypto, Snapshot Engine, Alert Engine, API Integration) sẽ chạy qua với kết quả PASS 100%.

### Bước 3: Khởi động hệ thống
```bash
npm start
```

Truy cập Dashboard trên trình duyệt:
👉 **`http://localhost:3000`**

---

## 3. Cấu hình biến môi trường (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Cổng HTTP Server |
| `ENCRYPTION_MASTER_KEY` | *(hex 32 bytes)* | Khóa bí mật dùng cho mã hóa AES-256-GCM token Meta |
| `DB_PATH` | `./data/monitor.db` | Đường dẫn file cơ sở dữ liệu SQLite |
| `DEFAULT_CHECK_INTERVAL_SEC` | `60` | Chu kỳ quét định kỳ mặc định (giây) |
| `MAX_CONCURRENT_CHECKS` | `5` | Giới hạn số lượng tác vụ kiểm tra đồng thời |
| `ENABLE_DEV_SIMULATOR` | `true` | Bật chế độ mô phỏng dữ liệu minh bạch khi chưa có token Meta |

---

## 4. Kiểm thử chất lượng (Quality Principles)
- **Minh bạch**: Toàn bộ dữ liệu thu thập qua Graph API hoặc chế độ Simulator đều có nhãn nguồn `source_type` rõ ràng (`GRAPH_API` / `SIMULATION`).
- **An toàn**: Token không bao giờ được lưu dưới dạng plain text. Không bao giờ bypass sandbox hoặc cơ chế kiểm soát bảo mật.
