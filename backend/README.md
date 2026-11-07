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

## 放在反向代理後面

- 要轉送 WebSocket（`/socket.io/`），Socket.IO 才能用 WebSocket 連線。
- `/api/v1/notifications/stream` 是 SSE，要關閉回應緩衝，且不要設定短的讀取逾時。
- 要傳 `Host` 和 `X-Forwarded-Proto`，或直接設定 `PUBLIC_BASE_URL`，否則媒體網址可能不正確。
- 上傳上限要設到 20 MB 以上。

## FCM 推播

設定 `FCM_SERVICE_ACCOUNT_FILE`（金鑰檔路徑）或 `FCM_SERVICE_ACCOUNT_JSON`（整份 JSON，適合放在部署平台的環境變數）後啟用。金鑰在 Firebase 主控台 → 專案設定 → 服務帳戶 → 產生新的私密金鑰，要和城市通 App 用同一個 Firebase 專案。

- 直接呼叫 FCM HTTP v1 API，自行用服務帳戶簽 JWT 換 access token，沒有使用 `firebase-admin`。
- 每則通知建立後，會推播到該使用者所有已註冊的裝置；推播在 API 回應後才非同步送出，失敗不影響 API。
- FCM 回報 token 失效（`UNREGISTERED` 等）時刪除該 token；429、5xx 和網路錯誤會指數退避，最多試 3 次。
- 未設定金鑰時，`PUT /push-tokens/{token}` 照常儲存，只是不發推播。

## 目前進度

`docs/api/openapi.yaml` 的 39 支 API 和 Socket.IO 訊號都已實作，也都有整合測試。推播走 FCM，見上方說明。

另外提供三個不在 `/api/v1` 下的公開路由：`GET /media/{id}`、`GET /badges/{id}.svg`、`GET /share/{user_id}/{badge_id}`，以及分類器測試頁 `GET /classify-test`。

## 目前的限制

- `userinfo` 沒有簽章，任何知道使用者 ID 的人都能登入成該使用者，正式上線前必須換成可驗證的 token。
- 媒體檔只要知道網址就能下載；個資待確認期間除外。
- 現場協助沒有身分驗證或緊急求助機制，不適合直接上線。
- 語音只檢查宣告的格式與長度，影片另外檢查檔頭；兩者都不會重新編碼，檔內的中繼資料會保留，長度也由前端回報。
- `district` 尚未實作，一律回傳 `null`。
- 頻率限制存在記憶體，重啟後歸零，也只適用單一程序。
- 推播已送出後，即使問題標題被標記為個資，鎖定畫面上已顯示的通知也無法收回。
- 推播重試排程存在記憶體，程序重啟時尚未送出的推播會遺失；使用者仍可從 `GET /notifications` 看到。
