# 看不懂互助論壇：後端

Express、SQLite、Socket.IO。只提供 HTTP 服務；HTTPS 與反向代理由部署方自行處理。

API 規格在 [`../docs/api/`](../docs/api/)，測試會用 `openapi.yaml` 驗證每個回應。

## 啟動

需要 Node.js 22 以上。

```bash
npm install
npm start        # 預設 http://0.0.0.0:5121/api/v1
npm run dev      # 檔案變更時自動重啟
npm test
```

資料庫結構變更時沒有遷移機制，改版後請清空 `DATA_DIR` 重建。

設定值見 `.env.example`，要透過環境變數傳入，例如 `PORT=8080 npm start`；也可以用 `node --env-file=.env src/server.js`。資料存在 `DATA_DIR`（預設 `./data`），包含 `app.db` 和 `media/`，要備份時整個目錄一起備份。

## 推播

用 `FIREBASE_SERVICE_ACCOUNT_FILE` 指定 Firebase 服務帳號金鑰的路徑；未設定時不發推播，其他功能照常。金鑰不可進版控，`.gitignore` 已排除 `*firebase-adminsdk*.json`。

## 放在反向代理後面

- 要轉送 WebSocket（`/socket.io/`），Socket.IO 才能用 WebSocket 連線。
- `/api/v1/notifications/stream` 是 SSE，要關閉回應緩衝，且不要設定短的讀取逾時。
- 要傳 `Host` 和 `X-Forwarded-Proto`，或直接設定 `PUBLIC_BASE_URL`，否則媒體網址可能不正確。
- 上傳上限要設到 20 MB 以上。

## 目前進度

`docs/api/openapi.yaml` 的 37 支 API 和 Socket.IO 訊號都已實作，也都有整合測試。只支援 Android，推播走 FCM，沒有 APNs。

另外提供三個不在 `/api/v1` 下的公開路由：`GET /media/{id}`、`GET /badges/{id}.svg`、`GET /share/{user_id}/{badge_id}`，以及分類器測試頁 `GET /classify-test`。

## 目前的限制

- `userinfo` 沒有簽章，任何知道使用者 ID 的人都能登入成該使用者，正式上線前必須換成可驗證的 token。
- 媒體檔只要知道網址就能下載；個資待確認期間除外。
- 現場協助沒有身分驗證或緊急求助機制，不適合直接上線。
- 語音檔只檢查宣告的格式與長度，不會重新編碼，檔內的中繼資料會保留。
- `district` 尚未實作，一律回傳 `null`。
- 頻率限制存在記憶體，重啟後歸零，也只適用單一程序。
