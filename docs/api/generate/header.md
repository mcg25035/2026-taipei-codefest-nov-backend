# 後端 API 規格

這份文件列出後端全部 {{COUNT}} 支 API、即時事件和資料結構，給串接的前端和 Flutter 使用。

- **Base URL：** `https://tpcodefest.mcloudtw.com/api/v1`
- **平台：** 只支援 Android
- **機器可讀版本：** [`openapi.yaml`](./openapi.yaml)
- **產品決策與狀態流程：** [`README.md`](./README.md)

## 快速開始

先向 App 取得 `userinfo`，再用 `id` 換 token。**不要傳姓名、身分證字號或電話。**

```bash
BASE=https://tpcodefest.mcloudtw.com/api/v1

curl -X POST $BASE/sessions \
  -H 'Content-Type: application/json' \
  -d '{"townpass_user_id":"<userinfo.id>","nickname":"小明"}'
# 回應：{"data":{"token":"...","expires_at":"...","user":{...}}}

curl -X POST $BASE/questions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "body": "這張公文是什麼意思？",
    "language": "zh-TW",
    "assistance_mode": "online",
    "location_sharing": "off",
    "client_request_id": "<前端產生的唯一值>"
  }'
```

## 共通規則

- **驗證：** 除標示不需要 token 的 API 外，都要帶 `Authorization: Bearer <token>`。token 效期 30 天。
- **格式：** 除上傳檔案外，請求和回應都是 JSON，時間是 ISO 8601 UTC。
- **成功回應：** `{ "data": ... }`。
- **分頁：** 列表回傳 `next_cursor`，把它放進下一次的 `cursor`；值為 `null` 表示沒有下一頁。參數 `limit` 可填 1 到 50，預設 20。
- **防重送：** 網路不穩時，用相同的 `client_request_id` 重送，不會重複建立內容。
- **分類：** 發問時可不填 `category`，由分類器判斷；信心不足時為 `uncategorized`，由志工用 `PUT /questions/{question_id}/category` 分類。
- **標籤：** `tags` 第一個是後端判定的固定標籤（`system_tag`），後面最多 5 個手動標籤，前端全部當標籤顯示，只有固定標籤不能讓人刪除。`category` 即將移除。用 `GET /questions?tag_q=關鍵字` 模糊搜尋問題，用 `GET /tags?q=關鍵字` 做自動完成。
- **語意快取：** 發問後可能很快收到機器人的回答，`author.role` 是 `bot`，`cached_from` 有值。收到 `answers.changed` 時重抓就會看到，介面要標示這是舊解答。發問者按「已解決」、採納或倒讚，會調整這則解答之後被引用的機會。
- **媒體：** 先呼叫 `POST /media` 取得 `id`，再放進問題或回答的 `media_ids`。超過 24 小時未使用的檔案會被刪除。
- **不會回傳的資料：** 倒讚數只留在後端；可信度評分只有管理員 API 看得到。
- **身份：** 使用者資料都有 `role`：`user`、`admin`、`bot`。`bot` 的權限和一般使用者相同，前端要標示它是機器人。

### 錯誤格式

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "缺少 language", "details": { "field": "language" } } }
```

| HTTP | `code` | 說明 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 欄位或格式錯誤，細節在 `details` |
| 401 | `UNAUTHORIZED` | token 缺少或失效 |
| 403 | `FORBIDDEN` | 沒有權限 |
| 403 | `TOO_FAR` | 超出接案距離（3 公里） |
| 403 | `SELF_ACTION_NOT_ALLOWED` | 採納、投票或接案的對象是自己 |
| 403 | `LOCATION_SHARING_OFF` | 位置分享已關閉，不能接現場任務 |
| 403 | `ASSIST_NOT_ALLOWED` | 目前不能接現場任務 |
| 403 | `ACCOUNT_BANNED` | 帳號已被停權 |
| 404 | `NOT_FOUND` | 不存在或已撤回 |
| 409 | `ALREADY_ACCEPTED` | 問題已有採納的回答 |
| 409 | `ANSWER_ACCEPTED` | 已採納的回答不能刪除 |
| 409 | `ASSIST_ACTIVE` | 現場協助進行中，不能採納回答 |
| 409 | `ASSIST_ALREADY_CLAIMED` | 任務已被接走 |
| 409 | `INVALID_STATE` | 目前狀態不允許此操作 |
| 413 | `FILE_TOO_LARGE` | 檔案過大 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 檔案格式不支援 |
| 429 | `RATE_LIMITED` | 請求過於頻繁 |

## 即時更新

資料一律走 REST。Socket.IO 只通知前端有更新，前端再用 REST 重抓；個人通知走 SSE。

### Socket.IO

```js
import { io } from 'socket.io-client';

const socket = io('https://tpcodefest.mcloudtw.com', { auth: { token } });
socket.emit('question:subscribe', { question_id });
socket.on('answers.changed', ({ question_id }) => refetchAnswers(question_id));
```

前端發送：

| 事件 | 資料 | 時機 |
|---|---|---|
| `feed:subscribe`、`feed:unsubscribe` | 無 | 進入或離開論壇、任務板 |
| `question:subscribe`、`question:unsubscribe` | `{ question_id }` | 進入或離開問題頁 |

後端發送：

| 事件 | 接收者 | 資料 | 要重抓 |
|---|---|---|---|
| `feed.changed` | 訂閱論壇的人 | 無 | `GET /questions` |
| `question.changed` | 訂閱該問題的人 | `{ question_id }` | `GET /questions/{question_id}`；回傳 404 表示已撤回 |
| `answers.changed` | 訂閱該問題的人 | `{ question_id }` | `GET /questions/{question_id}/answers` |
| `assist.changed` | 發問者、接案者 | `{ question_id }` | `GET /questions/{question_id}/assist` |
| `pii_reports.changed` | 發問者 | 無 | `GET /me/pii-reports` |

- 500 毫秒內的同類訊號只抓一次。
- 重新連線後要重新訂閱，並重抓目前畫面的資料，離線期間的訊號不會補發。

### SSE

`GET /notifications/stream` 只傳 `notification.created`，內容是 [Notification](#notification)。WebView 請用 `@microsoft/fetch-event-source`，因為原生 `EventSource` 不能帶 `Authorization` 標頭。

通知的 `type`：`nearby_question`、`new_answer`、`answer_accepted`、`assist_claimed`、`assist_arrived`、`assist_completed`、`assist_cancelled`、`pii_report_pending`、`pii_report_resolved`、`badge_earned`、`content_moderated`。

SSE 負責即時更新畫面。推播由 FCM 負責，兩者都會收到同一則通知，所以收到 SSE 時只更新畫面，不要再呼叫 `notify`。

### FCM 推播

每次載入頁面或登入後，用 `PUT /push-tokens/{token}` 上傳 token（`token` 要用 `encodeURIComponent` 編碼），登出時用 `DELETE`。

推播的 `notification` 帶 `title` 和 `body`，`data` 帶 `notification_id`、`type`，有問題時另帶 `question_id` 和 `url`。**不帶精確位置。**

## 不在 `/api/v1` 下的公開路由

| 路徑 | 用途 |
|---|---|
| `GET /media/{id}` | 下載媒體檔；個資待確認時回傳 404，除非帶有效簽章 |
| `GET /badges/{id}.svg` | 徽章圖片 |
| `GET /share/{user_id}/{badge_id}` | 可分享到社群的徽章頁 |

## API 總覽

{{SUMMARY}}

