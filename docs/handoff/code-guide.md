# 程式導覽

技術：Node.js 22（ES modules）、Express 5、SQLite（better-sqlite3）、Socket.IO、sharp。

## 目錄

```text
backend/
├─ src/
│  ├─ server.js          啟動入口
│  ├─ app.js             組裝所有模組和路由
│  ├─ config.js          環境變數與業務參數（積分、門檻、頻率限制）
│  ├─ db.js              資料表定義
│  ├─ auth.js            Bearer token 驗證
│  ├─ serialize.js       資料轉成 API 回應，個資隱藏也在這裡
│  ├─ notifications.js   建立通知、附近配對
│  ├─ realtime.js        Socket.IO 訊號與 SSE
│  ├─ push.js            FCM 發送、重試、清除無效 token
│  ├─ classifier.js      線上分類
│  ├─ rewards.js         徽章
│  ├─ signatures.js      媒體短效連結
│  ├─ geo.js             網格與距離
│  └─ routes/            各功能的 API
├─ ml/                   分類器的訓練與評估
└─ test/                 整合測試
docs/
├─ api/                  API 規格
└─ handoff/              這份文件
```

## 請求怎麼流動

1. `app.js` 依序掛上公開路由、`auth.requireAuth`，再掛需要登入的路由。**新路由要注意放在哪一段。**
2. 路由驗證輸入後，在 `db.transaction` 內寫入。
3. 寫入後呼叫 `notifier.create()` 和 `getRealtime().xxxChanged()`。
4. 回傳前經過 `serialize.js`。

錯誤一律丟 `ApiError`，由 `errors.js` 統一轉成 `{ error: { code, message, details } }`。Express 5 會自動接住 async 錯誤。

## 依相依關係注入

`app.js` 建立 `deps`，傳給每個路由函式。測試透過 `createServer(overrides)` 替換設定，例如 `pushTransport`、`classifierOverride`。

## 不可破壞的規則

| 規則 | 落實的位置 | 測試 |
|---|---|---|
| 倒讚數和可信度評分不回傳 | `serialize.js` | 有 |
| 精確位置不出現在公開內容、Socket.IO 或 FCM | `serialize.js`、`realtime.js`、`push.js` | 有 |
| Socket.IO 只帶 ID，不帶內容 | `realtime.js` | 有 |
| 模糊位置只公開網格點，距離也由網格點計算 | `geo.js`、`routes/assists.js` | 有 |
| 問題解決或撤回時清除精確座標 | `routes/answers.js`、`routes/assists.js`、`routes/questions.js` | 有 |
| 個資待確認時，他人看不到內容，通知也不帶標題 | `serialize.js`、`notifications.js`、`routes/pii.js` | 有 |
| 圖片遮蔽要排隊處理，否則遮蔽會互相覆蓋 | `routes/pii.js` 的 `enqueue` | 有 |
| 圖片上傳時重新編碼，移除 EXIF（語音和影片不會） | `routes/media.js` | 有 |

## 改 API 的流程

1. 改 `docs/api/openapi.yaml`。
2. 改程式，並在 `test/` 補測試。測試用 `t.call(方法, 規格路徑, ...)` 呼叫時，會自動依規格驗證回應。
3. 在 `backend/` 執行 `npm test` 和 `npm run docs:api`。
4. 一起 commit 規格和程式，並通知前端。

**不要直接改 `api-spec.md`**，它是由 `openapi.yaml` 和 `docs/api/generate/header.md` 產生的，改了會被覆蓋。

## 通知管道

一則通知由 `notifier.create()` 建立後：

- **SSE：** 使用者連線中就送出，並標記已送達。
- **FCM：** 無論有沒有連 SSE 都會推播，失敗最多重試 3 次，無效的 token 會刪除。
- **Heartbeat：** 回傳還沒標記已送達的通知。FCM 不會標記已送達，所以同一則通知可能再出現一次。

前端要用 `notification_id` 去重。

Socket.IO 是另一件事：它只通知資料有變動，前端再呼叫 REST 重抓。

## 分類器

模型是字元 n-gram + TF-IDF + 邏輯迴歸，檔案是 `ml/model.json`，由 `classifier.js` 載入。

`POST /questions` 沒帶 `category` 時會呼叫分類器：信心達 70% 才自動分類，否則是 `uncategorized`，由志工分類。志工只能修改未分類的問題。

重新訓練要先下載公開資料（不進版控）：

```bash
cd backend
curl -L -o ml/data/taipei-faq.json 'https://data.taipei/api/dataset/203f1657-bb4a-45a7-b25f-279b63136645/resource/1e344a1f-b926-4f37-8d92-3862156262e9/download'
curl -L -o ml/data/scam165.csv 'https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/4F4DF9A5-DF4C-4EE8-A50D-869347D38D9E/resource/A7BC80E6-83F4-4279-8EFD-19EE630E0DAD/download'
node ml/tune.mjs       # 用交叉驗證比較設定
node ml/train.mjs      # 產生 ml/model.json
node ml/evaluate.mjs   # 用測試集評估
```

- 要改資料或參數時，用 `tune.mjs` 判斷，**不要拿 `seed/test` 來調**，否則測試結果就失真了。
- 門檻在 `ml/train.mjs` 的 `THRESHOLD`。
- 訓練後要重啟伺服器才會載入新模型。
- 公開資料的出處要標示，見 [`ml/README.md`](../../backend/ml/README.md)。
- `ml/cv.mjs` 是早期的比較腳本，已被 `tune.mjs` 取代。

## 測試

`npm test` 會實際啟動伺服器，每個測試檔用暫存資料夾，不會碰到 `data/`。

寫附近通知的測試要先呼叫 `clearNearbyState()`。舊問題會觸發通知並佔用每人 10 分鐘的頻率限制，否則測試會互相干擾。
