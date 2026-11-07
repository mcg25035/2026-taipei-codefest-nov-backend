# 後端 API 規格

這份文件列出後端全部 47 支 API、即時事件和資料結構，給串接的前端和 Flutter 使用。

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
- **標籤：** 除了分類，問題可帶最多 5 個自訂標籤。用 `GET /questions?tag_q=關鍵字` 模糊搜尋問題，用 `GET /tags?q=關鍵字` 做自動完成。
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

| 方法 | 路徑 | 用途 | 需要 token |
|---|---|---|---|
| POST | `/sessions` | 用城市通使用者 ID 建立工作階段 | 否 |
| GET | `/me` | 取得自己的資料與設定 | 是 |
| PATCH | `/me` | 更新暱稱、語言與附近通知設定 | 是 |
| POST | `/me/heartbeat` | 回報位置並取回未送達的通知 | 是 |
| POST | `/media` | 上傳圖片、語音或影片 | 是 |
| GET | `/questions` | 問題列表（論壇與任務板共用） | 是 |
| POST | `/questions` | 發問 | 是 |
| GET | `/questions/{question_id}` | 問題詳情 | 是 |
| DELETE | `/questions/{question_id}` | 撤回問題 | 是 |
| POST | `/questions/{question_id}/resolve` | 發問者標記問題已解決 | 是 |
| PUT | `/questions/{question_id}/tags` | 設定問題的自訂標籤 | 是 |
| GET | `/tags` | 搜尋標籤 | 是 |
| PUT | `/questions/{question_id}/category` | 替問題分類 | 是 |
| GET | `/questions/{question_id}/answers` | 回答列表 | 是 |
| POST | `/questions/{question_id}/answers` | 回答問題 | 是 |
| DELETE | `/answers/{answer_id}` | 刪除自己的回答 | 是 |
| POST | `/answers/{answer_id}/accept` | 採納回答 | 是 |
| PUT | `/answers/{answer_id}/vote` | 投正讚或倒讚 | 是 |
| DELETE | `/answers/{answer_id}/vote` | 收回投票 | 是 |
| GET | `/questions/{question_id}/assist` | 取得自己參與的最新現場協助 | 是 |
| POST | `/questions/{question_id}/assist` | 接下現場任務 | 是 |
| POST | `/assists/{assist_id}/arrive` | 接案者回報已抵達 | 是 |
| POST | `/assists/{assist_id}/complete` | 發問者確認完成 | 是 |
| POST | `/assists/{assist_id}/cancel` | 取消現場協助 | 是 |
| POST | `/pii-reports` | 標記疑似個資 | 是 |
| GET | `/me/pii-reports` | 列出等待我決定的個資標記 | 是 |
| POST | `/pii-reports/{report_id}/accept` | 同意遮蔽 | 是 |
| POST | `/pii-reports/{report_id}/deny` | 拒絕遮蔽並恢復顯示 | 是 |
| GET | `/users/{user_id}` | 公開個人頁 | 否 |
| GET | `/badges` | 徽章清單與自己的解鎖狀態 | 是 |
| GET | `/me/point-transactions` | 積分紀錄 | 是 |
| GET | `/notifications` | 通知列表 | 是 |
| POST | `/notifications/read` | 標記已讀 | 是 |
| GET | `/notifications/stream` | SSE 個人通知串流 | 是 |
| POST | `/classify` | 試算問題分類 | 否 |
| PUT | `/push-tokens/{token}` | 註冊或更新此裝置的 FCM token | 是 |
| DELETE | `/push-tokens/{token}` | 取消此裝置的推播 | 是 |
| GET | `/admin/users` | 列出使用者 | 是 |
| PUT | `/admin/users/{user_id}/role` | 設定使用者身份 | 是 |
| POST | `/admin/users/{user_id}/ban` | 停權 | 是 |
| POST | `/admin/users/{user_id}/unban` | 解除停權 | 是 |
| PATCH | `/admin/questions/{question_id}` | 修改問題內容 | 是 |
| PATCH | `/admin/answers/{answer_id}` | 修改回答內容 | 是 |
| GET | `/admin/pii-reports` | 列出所有個資標記 | 是 |
| GET | `/admin/audit-log` | 稽核紀錄 | 是 |
| GET | `/meta` | 前端需要的列舉與限制 | 否 |
| GET | `/healthz` | 健康檢查 | 否 |


## 登入

### POST /sessions

用城市通使用者 ID 建立工作階段。不需要 token。

前端先向 App 取得 `userinfo`，再只傳下列欄位。不要傳 `realName`、`idNo`、`phoneNo` 等個資。
這不是真正的身分驗證：`userinfo` 沒有 token 或簽章，後端無法確認真偽。
管理員和機器人由伺服器名單或管理員指定，不能由前端宣告。已停權的帳號回傳 403 `ACCOUNT_BANNED`。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `townpass_user_id` | string | 是 | 最長 128 字 |
| `nickname` | string |  | 僅首次建立帳號時採用。最長 30 字 |
| `language` | [LanguageTag](#languagetag) |  |  |

**回應**

- `201`：已建立；`data` 是 object

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `token` | string | 是 |  |
| `expires_at` | string（時間） | 是 |  |
| `user` | [Me](#me) | 是 |  |

- 錯誤：`400`、`403`

## 個人資料

### GET /me

取得自己的資料與設定。

**回應**

- `200`：OK；`data` 是 [Me](#me)
- 錯誤：`401`

### PATCH /me

更新暱稱、語言與附近通知設定。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `nickname` | string |  | 最短 1，最長 30 字 |
| `languages` | [LanguageTag](#languagetag)[] |  | 看得懂的語言，用於篩選問題 |
| `nearby_notifications_enabled` | boolean |  |  |
| `nearby_radius_m` | integer |  | 最小 100，最大 5000 |
| `location_sharing` | [LocationSharing](#locationsharing) |  | 預設的位置分享等級；改成 off 時，後端立即刪除已保存的位置 |

**回應**

- `200`：OK；`data` 是 [Me](#me)
- 錯誤：`400`、`401`

### POST /me/heartbeat

回報位置並取回未送達的通知。

背景輪詢的主要入口，Flutter 定時呼叫，再把回傳內容顯示成本機通知。
後端只保留每位使用者最新一筆位置，且不對外公開。
`location_sharing` 為 `off` 時，App 不應傳 `location`，後端也會忽略；為 `approximate` 時，後端只保存網格點。
已透過回應傳遞的通知，下次不會再次回傳。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `location` | [Coordinates](#coordinates) |  |  |
| `app_state` | `foreground` \| `background` | 是 |  |

**回應**

- `200`：OK；`data` 是 object

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `notifications` | [Notification](#notification)[] | 是 |  |
| `next_heartbeat_seconds` | integer | 是 |  |

- 錯誤：`400`、`401`

## 推播

### PUT /push-tokens/{token}

註冊或更新此裝置的 FCM token。

以 token 為唯一鍵 upsert，綁定到目前登入的使用者；同一使用者可有多支裝置，最多保留最近 10 個。
token 會因重裝 App、清除資料或 FCM 輪替而改變，且 App 不會主動通知網頁，
所以每次載入頁面或登入後都要呼叫 `push_token` 並重新上傳。`push_token` 回傳 `null` 時不用呼叫。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `token` | 路徑 | string | 是 | 城市通 `push_token` 取得的 FCM token，要用 `encodeURIComponent` 編碼。最長 4096 字 |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `platform` | `android` \| `ios` | 是 |  |

**回應**

- `204`：已註冊，沒有內容
- 錯誤：`400`、`401`

### DELETE /push-tokens/{token}

取消此裝置的推播。

只會刪除屬於自己的 token；token 不存在時一樣回 204。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `token` | 路徑 | string | 是 | 城市通 `push_token` 取得的 FCM token，要用 `encodeURIComponent` 編碼。最長 4096 字 |

**回應**

- `204`：已取消，沒有內容
- 錯誤：`400`、`401`

## 媒體

### POST /media

上傳圖片、語音或影片。

圖片必須已在手機端完成個資遮蔽。後端會重新編碼圖片並移除 EXIF（含 GPS）。
語音和影片不會重新編碼，檔內的中繼資料（可能含 GPS）會保留，前端要提醒使用者不要拍到個資。
超過 24 小時未被問題或回答引用的檔案會被刪除。

**請求內容**（`multipart/form-data`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `file` | 檔案 | 是 | 圖片：JPEG、PNG、WebP，最大 10 MB；語音：M4A、AAC、MP3、WebM，最大 20 MB、最長 3 分鐘；影片：MP4、WebM，最大 20 MB、最長 60 秒 |
| `kind` | `image` \| `audio` \| `video` | 是 |  |
| `duration_seconds` | number |  | kind 為 audio 或 video 時必填，由前端提供，後端不驗證實際長度 |

**回應**

- `201`：已上傳；`data` 是 [Media](#media)
- 錯誤：`400`、`401`、`413`、`415`

## 問題

### GET /questions

問題列表（論壇與任務板共用）。

`scope=nearby` 或 `sort=nearest` 時必須帶 `lat`、`lng`。
任務板不是另一個資源，而是此列表依 `reward_points` 與 `can_claim` 呈現的畫面。
`tag`、`tag_q` 可和其他條件同時使用，例如 `tag_q=詐騙&status=open`。
`sort=unanswered` 只回傳還沒有回答的問題，由新到舊排序。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `scope` | query | `global` \| `nearby` |  | 預設 `global` |
| `lat` | query | number |  | 最小 -90，最大 90 |
| `lng` | query | number |  | 最小 -180，最大 180 |
| `radius_m` | query | integer |  | 最小 100，最大 5000，預設 `1000` |
| `status` | query | [QuestionStatus](#questionstatus) |  |  |
| `category` | query | [Category](#category) |  |  |
| `tag` | query | string |  | 完全符合這個標籤（不分大小寫、全半形、臺台） |
| `tag_q` | query | string |  | 模糊搜尋標籤；沒指定 sort 且 scope 為 global 時依相似度排序。最長 50 字 |
| `language` | query | [LanguageTag](#languagetag) |  |  |
| `assistance_mode` | query | [AssistanceMode](#assistancemode) |  |  |
| `service_id` | query | string |  | 只看某個城市通功能的問題 |
| `author` | query | `me` |  | 填 me 可看自己發的問題 |
| `sort` | query | `latest` \| `nearest` \| `unanswered` |  | 預設 `latest` |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [QuestionSummary](#questionsummary)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [QuestionStatus](#questionstatus) | 是 |  |
| `title` | string \| null | 是 | 內容待個資確認時為 null |
| `category` | [Category](#category) | 是 |  |
| `tags` | string[] | 是 |  |
| `language` | [LanguageTag](#languagetag) | 是 |  |
| `assistance_mode` | [AssistanceMode](#assistancemode) | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |
| `author` | [PublicUser](#publicuser) | 是 |  |
| `context` | [QuestionContext](#questioncontext) \| null |  |  |
| `area` | [PublicArea](#publicarea) \| null |  |  |
| `thumbnail_url` | string（URL） \| null |  |  |
| `has_audio` | boolean |  |  |
| `has_video` | boolean |  |  |
| `answer_count` | integer | 是 |  |
| `reward_points` | integer | 是 | 任務板顯示的可得積分 |
| `can_claim` | boolean | 是 | 目前使用者能否接下現場任務 |
| `hidden_parts` | [HiddenPart](#hiddenpart)[] | 是 |  |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`400`、`401`

### POST /questions

發問。

`body` 和 `media_ids` 至少要有一個。
未填 `category` 時由分類器判斷；信心低於 70% 或沒有文字時為 `uncategorized`，交給志工分類。
未填 `location_sharing` 時，採用使用者的預設等級。
等級為 `off` 時不可帶 `location`，問題不會出現在附近列表，也不會通知附近的人；其他等級必須帶 `location`。
`assistance_mode` 為 `onsite` 或 `either` 時，等級不可為 `off`，且 `location` 要傳精確座標。
等級為 `approximate` 的現場問題，精確座標只在有人接案後提供給接案者。
相同使用者重送相同的 `client_request_id` 時，回傳原本的問題，不會重複建立。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `title` | string |  | 選填，未填時由 body 前 30 字產生。最長 80 字 |
| `body` | string |  | 最長 5000 字 |
| `media_ids` | string[] |  | 最多 5 項 |
| `language` | [LanguageTag](#languagetag) | 是 |  |
| `tags` | string[] |  | 選填的自訂標籤，和 `category` 並存。每個 1 到 20 字。最多 5 項 |
| `category` | [Category](#category) |  | 選填。未填時由分類器判斷，信心不足或沒有文字時為 `uncategorized` |
| `assistance_mode` | [AssistanceMode](#assistancemode) | 是 |  |
| `context` | [QuestionContext](#questioncontext) \| null |  |  |
| `location_sharing` | [LocationSharing](#locationsharing) |  | 這個問題的位置分享等級；未填時採用使用者的預設等級 |
| `location` | [Coordinates](#coordinates) \| null |  |  |
| `client_request_id` | string | 是 | 最長 64 字 |

**回應**

- `200`：重送，回傳原本的問題；`data` 是 [QuestionDetail](#questiondetail)
- `201`：已建立；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`400`、`401`、`429`

### GET /questions/{question_id}

問題詳情。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`401`、`404`

### DELETE /questions/{question_id}

撤回問題。

僅限發問者或管理員。問題與其媒體檔立即不可存取，進行中的現場協助會一併取消。管理員的操作會保留原內容在稽核紀錄。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**回應**

- `204`：已撤回，沒有內容
- 錯誤：`401`、`403`、`404`

### POST /questions/{question_id}/resolve

發問者標記問題已解決。

僅限發問者或管理員，不需要請求內容，也不需要留言或採納回答，沒有任何回答時也能使用。不會發積分。
已解決的問題回傳 409 `INVALID_STATE`；現場協助進行中回傳 409 `ASSIST_ACTIVE`。
標記後，所有人仍可回答和按讚，發問者也仍可採納回答。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`401`、`403`、`404`、`409`

### PUT /questions/{question_id}/tags

設定問題的自訂標籤。

傳入完整的標籤清單，會取代現有標籤。
發問者和管理員可以新增或移除；其他登入者只能新增，移除別人的標籤回傳 403。低可信度帳號回傳 403。
管理員的修改會留下稽核紀錄。
最多 5 個，每個 1 到 20 字，只能有文字、數字、空白、`-`、`_`、`·`；開頭的 `#` 會被移除。重複的標籤會合併。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tags` | string[] | 是 | 最多 5 項 |

**回應**

- `200`：OK；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`400`、`401`、`403`、`404`

### GET /tags

搜尋標籤。

有 `q` 時模糊比對並依相似度排序，能接受部分符合、詞序不同和打錯字；沒有 `q` 時回傳最多人使用的標籤。
比對時不分大小寫、全半形和臺台，也忽略空白和分隔符號。可用於輸入標籤時的自動完成。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `q` | query | string |  | 最長 50 字 |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 object[]

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `tag` | string | 是 |  |
| `question_count` | integer | 是 |  |
| `score` | number | 是 | 相似度，0 到 1；沒有 q 時為 1 |

- 錯誤：`400`、`401`

### PUT /questions/{question_id}/category

替問題分類。

任何登入者都能替 `uncategorized` 的問題分類；已分類的問題回傳 409 `INVALID_STATE`。
發問者隨時可以修改自己的問題。不能改回 `uncategorized`，低可信度帳號回傳 403。
管理員可以修改任何問題，也能改回 `uncategorized`，操作會留下稽核紀錄。
分類不會獲得積分。可用 `GET /questions?category=uncategorized` 列出待分類的問題。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `category` | [Category](#category) | 是 |  |

**回應**

- `200`：OK；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`400`、`401`、`403`、`404`、`409`

### POST /classify

試算問題分類。不需要 token。

回傳分類器的判斷，不會儲存文字，邏輯與 `POST /questions` 未填 `category` 時相同。不需要 token。
信心低於 `threshold` 或沒有可辨識的特徵時，`category` 是 `uncategorized`，應交給志工分類。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `text` | string | 是 | 最短 1，最長 5000 字 |

**回應**

- `200`：OK；`data` 是 object

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `category` | [Category](#category) | 是 |  |
| `predicted` | [Category](#category) | 是 |  |
| `confidence` | number | 是 | 最小 0，最大 1 |
| `threshold` | number | 是 |  |
| `scores` | object[] | 是 |  |
| `scores[].category` | [Category](#category) | 是 |  |
| `scores[].score` | number | 是 |  |

- 錯誤：`400`、`429`

## 回答與投票

### GET /questions/{question_id}/answers

回答列表。

`sort=top` 時，已採納的回答置頂，其餘依淨讚數排序。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |
| `sort` | query | `top` \| `oldest` |  | 預設 `top` |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [Answer](#answer)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `author` | [PublicUser](#publicuser) | 是 |  |
| `body` | string \| null | 是 |  |
| `media` | [Media](#media)[] | 是 |  |
| `language` | [LanguageTag](#languagetag) |  |  |
| `is_accepted` | boolean | 是 |  |
| `votes` | [VoteSummary](#votesummary) | 是 |  |
| `hidden_parts` | [HiddenPart](#hiddenpart)[] | 是 |  |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`401`、`404`

### POST /questions/{question_id}/answers

回答問題。

`body` 和 `media_ids` 至少要有一個。發問者也可以回覆自己的問題以補充說明，但不能採納自己的回答。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `body` | string |  | 最長 5000 字 |
| `media_ids` | string[] |  | 最多 5 項 |
| `language` | [LanguageTag](#languagetag) |  |  |
| `client_request_id` | string |  | 最長 64 字 |

**回應**

- `201`：已建立；`data` 是 [Answer](#answer)
- 錯誤：`400`、`401`、`404`、`429`

### DELETE /answers/{answer_id}

刪除自己的回答。

已被採納的回答不能刪除，回傳 409 `ANSWER_ACCEPTED`。管理員可以刪除任何回答，已發出的積分不收回，操作會保留原內容在稽核紀錄。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `answer_id` | 路徑 | string | 是 |  |

**回應**

- `204`：已刪除，沒有內容
- 錯誤：`401`、`403`、`404`、`409`

### POST /answers/{answer_id}/accept

採納回答。

僅限發問者，每題只能採納一次且不可撤銷。問題轉為 `resolved`，回答者獲得積分。
問題已用 `POST /questions/{question_id}/resolve` 標記解決時仍可採納；現場協助已完成時回傳 409 `INVALID_STATE`。
有進行中的現場協助時回傳 409 `ASSIST_ACTIVE`。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `answer_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [Answer](#answer)
- 錯誤：`401`、`403`、`404`、`409`

### PUT /answers/{answer_id}/vote

投正讚或倒讚。

所有登入者都能投票，不限發問者或參與者，問題解決後也能投。每人每則回答一票，重複呼叫會覆蓋原本的票。可以對自己的回答投正讚，但不加可信度；不能投倒讚。讚會影響回答排序與回答者的可信度評分，不影響積分。倒讚數和可信度評分不會出現在任何 API 回應中。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `answer_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `value` | `1` \| `-1` | 是 |  |

**回應**

- `200`：OK；`data` 是 [VoteSummary](#votesummary)
- 錯誤：`400`、`401`、`403`、`404`

### DELETE /answers/{answer_id}/vote

收回投票。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `answer_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [VoteSummary](#votesummary)
- 錯誤：`401`、`404`

## 現場協助

### GET /questions/{question_id}/assist

取得自己參與的最新現場協助。

回傳使用者參與的最新一筆，包含已完成或已取消的，前端才能在訊號後更新畫面。
精確位置只在進行中時有值。其他人在有進行中的任務時回傳 403，否則回傳 404。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [Assist](#assist)
- 錯誤：`401`、`403`、`404`

### POST /questions/{question_id}/assist

接下現場任務。

接案者需在問題 3 公里內，否則回傳 403 `TOO_FAR`。
已有人接案時回傳 409 `ASSIST_ALREADY_CLAIMED`。發問者不能接自己的任務。
接案者的等級為 `off` 時回傳 403 `LOCATION_SHARING_OFF`。此處的 `location` 只用來檢查距離，不會保存。
可信度評分低於門檻時回傳 403 `ASSIST_NOT_ALLOWED`，回應不透露評分。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `location` | [Coordinates](#coordinates) | 是 |  |

**回應**

- `201`：已接案；`data` 是 [Assist](#assist)
- 錯誤：`400`、`401`、`403`、`404`、`409`

### POST /assists/{assist_id}/arrive

接案者回報已抵達。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `assist_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [Assist](#assist)
- 錯誤：`401`、`403`、`404`、`409`

### POST /assists/{assist_id}/complete

發問者確認完成。

僅限發問者，接案者未回報抵達時也能確認。問題轉為 `resolved`，接案者獲得積分，精確位置立即清除。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `assist_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [Assist](#assist)
- 錯誤：`401`、`403`、`404`、`409`

### POST /assists/{assist_id}/cancel

取消現場協助。

發問者或接案者皆可取消。問題回到 `open`，接案者立即失去精確位置的存取權。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `assist_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`，選填）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `reason` | string |  | 最長 200 字 |

**回應**

- `200`：OK；`data` 是 [Assist](#assist)
- 錯誤：`401`、`403`、`404`、`409`

## 個資標記

### POST /pii-reports

標記疑似個資。

任何登入者都能標記。內容會立即對其他人隱藏，等發問者決定。
發問者自己標記時會直接生效。

- 圖片：填 `media_id` 與 `regions`
- 語音、影片：填 `media_id`；accept 後整段移除
- 文字：填 `text_ranges`；標記問題標題時，`text_field` 填 `title`

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `target_type` | `question` \| `answer` | 是 |  |
| `target_id` | string | 是 |  |
| `media_id` | string |  |  |
| `regions` | [ImageRegion](#imageregion)[] |  | 最多 20 項 |
| `text_ranges` | [TextRange](#textrange)[] |  | 最多 20 項 |
| `text_field` | `body` \| `title` |  | 只有問題能標記 title。預設 `body` |

**回應**

- `201`：已建立；`data` 是 object

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [PiiReportStatus](#piireportstatus) | 是 |  |

- 錯誤：`400`、`401`、`404`、`429`

### GET /me/pii-reports

列出等待我決定的個資標記。

只有發問者看得到。不會透露是誰標記的。`preview_url` 是短效連結，讓發問者查看被隱藏的原內容。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `status` | query | [PiiReportStatus](#piireportstatus) |  |  |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [PiiReport](#piireport)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [PiiReportStatus](#piireportstatus) | 是 |  |
| `target_type` | `question` \| `answer` | 是 |  |
| `target_id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `media_id` | string \| null |  |  |
| `text_field` | `body` \| `title` \| `null` |  |  |
| `regions` | [ImageRegion](#imageregion)[] |  |  |
| `text_ranges` | [TextRange](#textrange)[] |  |  |
| `original_text` | string \| null |  | 僅 pending 時回傳給發問者 |
| `preview_url` | string（URL） \| null |  | 僅 pending 時回傳的短效連結 |
| `created_at` | string（時間） | 是 |  |
| `resolved_at` | string（時間） \| null |  |  |

- 錯誤：`401`

### POST /pii-reports/{report_id}/accept

同意遮蔽。

僅限發問者或管理員。圖片會在伺服器上覆蓋不透明色塊並產生新檔與新 ID，原檔刪除；文字逐字換成 `█`，字數不變；語音和影片整段移除。此操作不可逆。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `report_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [PiiReport](#piireport)
- 錯誤：`401`、`403`、`404`、`409`

### POST /pii-reports/{report_id}/deny

拒絕遮蔽並恢復顯示。

僅限發問者或管理員。若同一內容還有其他待決定的標記，內容會繼續隱藏。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `report_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [PiiReport](#piireport)
- 錯誤：`401`、`403`、`404`、`409`

## 獎勵

### GET /users/{user_id}

公開個人頁。不需要 token。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `user_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [UserProfile](#userprofile)
- 錯誤：`404`

### GET /badges

徽章清單與自己的解鎖狀態。

**回應**

- `200`：OK；`data` 是 [Badge](#badge)[]

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `name` | string | 是 |  |
| `description` | string | 是 |  |
| `image_url` | string（URL） | 是 |  |
| `earned` | boolean | 是 |  |
| `earned_at` | string（時間） \| null |  |  |
| `share_url` | string（URL） \| null |  | 已解鎖才有值，是可分享到社群的公開頁面 |

- 錯誤：`401`

### GET /me/point-transactions

積分紀錄。

營運方日後若要做實質兌換，可沿用這份帳本。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [PointTransaction](#pointtransaction)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `amount` | integer | 是 |  |
| `reason` | `answer_accepted` \| `assist_completed` | 是 |  |
| `question_id` | string |  |  |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`401`

## 管理員

### GET /admin/users

列出使用者。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `role` | query | [UserRole](#userrole) |  |  |
| `q` | query | string |  | 搜尋暱稱或城市通使用者 ID |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [AdminUser](#adminuser)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `nickname` | string | 是 |  |
| `points` | integer | 是 |  |
| `role` | [UserRole](#userrole) | 是 |  |
| `languages` | [LanguageTag](#languagetag)[] | 是 |  |
| `nearby_notifications_enabled` | boolean | 是 |  |
| `nearby_radius_m` | integer | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |
| `townpass_user_id` | string | 是 |  |
| `trust_score` | integer | 是 |  |
| `banned_at` | string（時間） \| null | 是 |  |
| `ban_reason` | string \| null | 是 |  |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`400`、`401`、`403`

### PUT /admin/users/{user_id}/role

設定使用者身份。

不能變更自己的身份。名單內的 ID 下次登入時會依名單恢復。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `user_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `role` | [UserRole](#userrole) | 是 |  |

**回應**

- `200`：OK；`data` 是 [AdminUser](#adminuser)
- 錯誤：`400`、`401`、`403`、`404`

### POST /admin/users/{user_id}/ban

停權。

立即登出、中斷即時連線並移除推播 token，也不能重新登入。不能停權自己。已發布的內容不會自動移除。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `user_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`，選填）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `reason` | string |  | 最長 200 字 |

**回應**

- `200`：OK；`data` 是 [AdminUser](#adminuser)
- 錯誤：`401`、`403`、`404`

### POST /admin/users/{user_id}/unban

解除停權。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `user_id` | 路徑 | string | 是 |  |

**回應**

- `200`：OK；`data` 是 [AdminUser](#adminuser)
- 錯誤：`401`、`403`、`404`

### PATCH /admin/questions/{question_id}

修改問題內容。

修改前後都會留在稽核紀錄，並通知作者。有待決定的文字個資標記時回傳 409，要先處理標記。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `question_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `title` | string |  | 最短 1，最長 80 字 |
| `body` | string \| null |  | 最長 5000 字 |

**回應**

- `200`：OK；`data` 是 [QuestionDetail](#questiondetail)
- 錯誤：`400`、`401`、`403`、`404`、`409`

### PATCH /admin/answers/{answer_id}

修改回答內容。

修改前後都會留在稽核紀錄，並通知作者。有待決定的文字個資標記時回傳 409。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `answer_id` | 路徑 | string | 是 |  |

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `body` | string | 是 | 最短 1，最長 5000 字 |

**回應**

- `200`：OK；`data` 是 [Answer](#answer)
- 錯誤：`400`、`401`、`403`、`404`、`409`

### GET /admin/pii-reports

列出所有個資標記。

發問者沒回應時內容會一直隱藏，管理員可從這裡找到並處理。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `status` | query | [PiiReportStatus](#piireportstatus) |  |  |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [PiiReport](#piireport)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [PiiReportStatus](#piireportstatus) | 是 |  |
| `target_type` | `question` \| `answer` | 是 |  |
| `target_id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `media_id` | string \| null |  |  |
| `text_field` | `body` \| `title` \| `null` |  |  |
| `regions` | [ImageRegion](#imageregion)[] |  |  |
| `text_ranges` | [TextRange](#textrange)[] |  |  |
| `original_text` | string \| null |  | 僅 pending 時回傳給發問者 |
| `preview_url` | string（URL） \| null |  | 僅 pending 時回傳的短效連結 |
| `created_at` | string（時間） | 是 |  |
| `resolved_at` | string（時間） \| null |  |  |

- 錯誤：`400`、`401`、`403`

### GET /admin/audit-log

稽核紀錄。

管理員的刪除和修改都會記錄，由新到舊，紀錄不能修改或刪除。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `action` | query | string |  |  |
| `target_id` | query | string |  |  |
| `admin_id` | query | string |  |  |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [AuditEntry](#auditentry)[]，另有 `next_cursor`（string \| null）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `admin` | [PublicUser](#publicuser) | 是 |  |
| `action` | string | 是 |  |
| `target_type` | `question` \| `answer` \| `user` \| `pii_report` | 是 |  |
| `target_id` | string | 是 |  |
| `detail` | object | 是 | 刪除時保留原內容，修改時有 before 和 after |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`400`、`401`、`403`

## 通知

### GET /notifications

通知列表。

**參數**

| 名稱 | 位置 | 型別 | 必填 | 說明 |
|---|---|---|---|---|
| `unread_only` | query | boolean |  | 預設 `false` |
| `cursor` | query | string |  |  |
| `limit` | query | integer |  | 最小 1，最大 50，預設 `20` |

**回應**

- `200`：OK；`data` 是 [Notification](#notification)[]，另有 `next_cursor`（string \| null）、`unread_count`（integer）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `type` | `nearby_question` \| `new_answer` \| `answer_accepted` \| `assist_claimed` \| `assist_arrived` \| `assist_completed` \| `assist_cancelled` \| `pii_report_pending` \| `pii_report_resolved` \| `content_moderated` \| `badge_earned` | 是 |  |
| `title` | string | 是 |  |
| `body` | string | 是 |  |
| `question_id` | string \| null |  |  |
| `exact_location` | [Coordinates](#coordinates) \| null |  | 只有 nearby_question 通知且問題等級為 exact 時有值；問題解決或撤回後清除 |
| `read` | boolean | 是 |  |
| `created_at` | string（時間） | 是 |  |

- 錯誤：`401`

### POST /notifications/read

標記已讀。

`ids` 和 `all` 擇一。

**請求內容**（`application/json`）

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `ids` | string[] |  |  |
| `all` | boolean |  |  |

**回應**

- `204`：已標記，沒有內容
- 錯誤：`400`、`401`

## SSE

### GET /notifications/stream

SSE 個人通知串流。

只傳 `notification.created` 事件，內容是 `Notification`。其他資料更新走 Socket.IO 訊號加 REST，見 README。
原生 `EventSource` 不能帶 Authorization 標頭，WebView 請用 `@microsoft/fetch-event-source`。
斷線重連後不保證補發，請呼叫 `GET /notifications` 補抓。

**回應**

- `200`：事件串流；每 25 秒送一次 ping 註解（`text/event-stream`）
- 錯誤：`401`

## 系統

### GET /meta

前端需要的列舉與限制。不需要 token。

**回應**

- `200`：OK；`data` 是 object

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `categories` | object[] | 是 |  |
| `categories[].id` | [Category](#category) | 是 |  |
| `categories[].label` | string | 是 |  |
| `languages` | [LanguageTag](#languagetag)[] | 是 |  |
| `points` | object | 是 |  |
| `points.answer_accepted` | integer | 是 |  |
| `points.assist_completed` | integer | 是 |  |
| `limits` | object | 是 |  |


### GET /healthz

健康檢查。不需要 token。

**回應**

- `200`：OK；`status`

## 資料結構

### LanguageTag

BCP 47 語言標籤

型別：string

### Category

`uncategorized` 表示分類器沒有把握，由志工之後分類；`other` 是已分類但不屬於其他類別。

型別：`map_navigation` \| `admin_procedure` \| `document_contract` \| `scam_check` \| `app_usage` \| `language` \| `other` \| `uncategorized`

### AssistanceMode

型別：`online` \| `onsite` \| `either`

### QuestionStatus

型別：`open` \| `in_progress` \| `resolved`

### AssistStatus

型別：`claimed` \| `arrived` \| `completed` \| `cancelled`

### PiiReportStatus

型別：`pending` \| `accepted` \| `denied`

### Coordinates

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `lat` | number | 是 | 最小 -90，最大 90 |
| `lng` | number | 是 | 最小 -180，最大 180 |
| `accuracy_m` | number |  | 最小 0 |

### LocationSharing

- `off`：完全關閉。不保存位置，不收也不發附近通知，不能使用現場協助。
- `approximate`：模糊位置，預設值。公開頁與通知只有約 500 公尺的位置；現場問題有人接案後，只把精確座標提供給接案者。
- `exact`：具體位置。附近通知會附上精確座標，接案者也能取得；公開頁仍只顯示模糊位置。

型別：`off` \| `approximate` \| `exact`（預設 `approximate`）

### PublicArea

公開的概略位置。座標對齊約 500 公尺的網格，距離也由網格點計算並取到百公尺。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `approx_lat` | number | 是 |  |
| `approx_lng` | number | 是 |  |
| `district` | string \| null |  |  |
| `distance_m` | integer \| null |  | 查詢時有帶座標才有值 |

### UserRole

`user` 一般使用者；`admin` 管理員；`bot` 機器人，權限和一般使用者相同，前端應標示。

型別：`user` \| `admin` \| `bot`

### PublicUser

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `nickname` | string | 是 |  |
| `points` | integer | 是 |  |
| `role` | [UserRole](#userrole) | 是 |  |

### AdminUser

只有管理員 API 會回傳，包含可信度評分。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `nickname` | string | 是 |  |
| `points` | integer | 是 |  |
| `role` | [UserRole](#userrole) | 是 |  |
| `languages` | [LanguageTag](#languagetag)[] | 是 |  |
| `nearby_notifications_enabled` | boolean | 是 |  |
| `nearby_radius_m` | integer | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |
| `townpass_user_id` | string | 是 |  |
| `trust_score` | integer | 是 |  |
| `banned_at` | string（時間） \| null | 是 |  |
| `ban_reason` | string \| null | 是 |  |
| `created_at` | string（時間） | 是 |  |

### AuditEntry

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `admin` | [PublicUser](#publicuser) | 是 |  |
| `action` | string | 是 |  |
| `target_type` | `question` \| `answer` \| `user` \| `pii_report` | 是 |  |
| `target_id` | string | 是 |  |
| `detail` | object | 是 | 刪除時保留原內容，修改時有 before 和 after |
| `created_at` | string（時間） | 是 |  |

### Me

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `nickname` | string | 是 |  |
| `points` | integer | 是 |  |
| `role` | [UserRole](#userrole) | 是 |  |
| `languages` | [LanguageTag](#languagetag)[] | 是 |  |
| `nearby_notifications_enabled` | boolean | 是 |  |
| `nearby_radius_m` | integer | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |

### UserProfile

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `nickname` | string | 是 |  |
| `points` | integer | 是 |  |
| `role` | [UserRole](#userrole) | 是 |  |
| `accepted_answer_count` | integer | 是 |  |
| `completed_assist_count` | integer | 是 |  |
| `badges` | [Badge](#badge)[] | 是 |  |

### Badge

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `name` | string | 是 |  |
| `description` | string | 是 |  |
| `image_url` | string（URL） | 是 |  |
| `earned` | boolean | 是 |  |
| `earned_at` | string（時間） \| null |  |  |
| `share_url` | string（URL） \| null |  | 已解鎖才有值，是可分享到社群的公開頁面 |

### PointTransaction

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `amount` | integer | 是 |  |
| `reason` | `answer_accepted` \| `assist_completed` | 是 |  |
| `question_id` | string |  |  |
| `created_at` | string（時間） | 是 |  |

### Media

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `kind` | `image` \| `audio` \| `video` | 是 |  |
| `url` | string（URL） | 是 |  |
| `width` | integer |  |  |
| `height` | integer |  |  |
| `duration_seconds` | number |  |  |

### HiddenPart

因個資標記待決定而暫時隱藏的內容

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `part` | `body` \| `media` | 是 |  |
| `media_id` | string |  |  |
| `reason` | `pii_pending` | 是 |  |

### QuestionContext

從城市通頁面發問時自動帶入，App 外的問題為 null。不可放使用者個資，`page_route` 不含 query string。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `service_id` | string | 是 |  |
| `service_name` | string | 是 |  |
| `page_route` | string |  |  |
| `page_title` | string |  |  |
| `extra` | object |  | 由各功能自訂，最大 2 KB |

### CreateQuestionRequest

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `title` | string |  | 選填，未填時由 body 前 30 字產生。最長 80 字 |
| `body` | string |  | 最長 5000 字 |
| `media_ids` | string[] |  | 最多 5 項 |
| `language` | [LanguageTag](#languagetag) | 是 |  |
| `tags` | string[] |  | 選填的自訂標籤，和 `category` 並存。每個 1 到 20 字。最多 5 項 |
| `category` | [Category](#category) |  | 選填。未填時由分類器判斷，信心不足或沒有文字時為 `uncategorized` |
| `assistance_mode` | [AssistanceMode](#assistancemode) | 是 |  |
| `context` | [QuestionContext](#questioncontext) \| null |  |  |
| `location_sharing` | [LocationSharing](#locationsharing) |  | 這個問題的位置分享等級；未填時採用使用者的預設等級 |
| `location` | [Coordinates](#coordinates) \| null |  |  |
| `client_request_id` | string | 是 | 最長 64 字 |

### QuestionSummary

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [QuestionStatus](#questionstatus) | 是 |  |
| `title` | string \| null | 是 | 內容待個資確認時為 null |
| `category` | [Category](#category) | 是 |  |
| `tags` | string[] | 是 |  |
| `language` | [LanguageTag](#languagetag) | 是 |  |
| `assistance_mode` | [AssistanceMode](#assistancemode) | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |
| `author` | [PublicUser](#publicuser) | 是 |  |
| `context` | [QuestionContext](#questioncontext) \| null |  |  |
| `area` | [PublicArea](#publicarea) \| null |  |  |
| `thumbnail_url` | string（URL） \| null |  |  |
| `has_audio` | boolean |  |  |
| `has_video` | boolean |  |  |
| `answer_count` | integer | 是 |  |
| `reward_points` | integer | 是 | 任務板顯示的可得積分 |
| `can_claim` | boolean | 是 | 目前使用者能否接下現場任務 |
| `hidden_parts` | [HiddenPart](#hiddenpart)[] | 是 |  |
| `created_at` | string（時間） | 是 |  |

### QuestionDetail

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [QuestionStatus](#questionstatus) | 是 |  |
| `title` | string \| null | 是 | 內容待個資確認時為 null |
| `category` | [Category](#category) | 是 |  |
| `tags` | string[] | 是 |  |
| `language` | [LanguageTag](#languagetag) | 是 |  |
| `assistance_mode` | [AssistanceMode](#assistancemode) | 是 |  |
| `location_sharing` | [LocationSharing](#locationsharing) | 是 |  |
| `author` | [PublicUser](#publicuser) | 是 |  |
| `context` | [QuestionContext](#questioncontext) \| null |  |  |
| `area` | [PublicArea](#publicarea) \| null |  |  |
| `thumbnail_url` | string（URL） \| null |  |  |
| `has_audio` | boolean |  |  |
| `has_video` | boolean |  |  |
| `answer_count` | integer | 是 |  |
| `reward_points` | integer | 是 | 任務板顯示的可得積分 |
| `can_claim` | boolean | 是 | 目前使用者能否接下現場任務 |
| `hidden_parts` | [HiddenPart](#hiddenpart)[] | 是 |  |
| `created_at` | string（時間） | 是 |  |
| `body` | string \| null | 是 |  |
| `media` | [Media](#media)[] | 是 |  |
| `is_author` | boolean | 是 |  |
| `accepted_answer_id` | string \| null | 是 |  |
| `assist_status` | [AssistStatus](#assiststatus) \| null | 是 | 公開狀態，不含精確位置；沒有進行中或已完成的協助時為 null |

### VoteSummary

倒讚數只在後端用於排序和可信度評分，不回傳給任何人，包含回答者本人。

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `upvotes` | integer | 是 |  |
| `my_vote` | `1` \| `-1` \| `null` | 是 | 使用者自己的投票，用於顯示按鈕狀態 |

### Answer

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `author` | [PublicUser](#publicuser) | 是 |  |
| `body` | string \| null | 是 |  |
| `media` | [Media](#media)[] | 是 |  |
| `language` | [LanguageTag](#languagetag) |  |  |
| `is_accepted` | boolean | 是 |  |
| `votes` | [VoteSummary](#votesummary) | 是 |  |
| `hidden_parts` | [HiddenPart](#hiddenpart)[] | 是 |  |
| `created_at` | string（時間） | 是 |  |

### Assist

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `status` | [AssistStatus](#assiststatus) | 是 |  |
| `asker` | [PublicUser](#publicuser) | 是 |  |
| `helper` | [PublicUser](#publicuser) | 是 |  |
| `exact_location` | [Coordinates](#coordinates) \| null | 是 | 僅 claimed、arrived 狀態有值 |
| `claimed_at` | string（時間） | 是 |  |
| `arrived_at` | string（時間） \| null |  |  |
| `completed_at` | string（時間） \| null |  |  |
| `cancelled_at` | string（時間） \| null |  |  |
| `cancelled_by` | `asker` \| `helper` \| `null` |  |  |
| `cancel_reason` | string \| null |  |  |

### ImageRegion

以圖片寬高為基準的 0 到 1 比例座標

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `x` | number | 是 | 最小 0，最大 1 |
| `y` | number | 是 | 最小 0，最大 1 |
| `w` | number | 是 | 大於 0，最大 1 |
| `h` | number | 是 | 大於 0，最大 1 |

### TextRange

以 Unicode code point 計算，end 不包含在內

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `start` | integer | 是 | 最小 0 |
| `end` | integer | 是 | 最小 1 |

### CreatePiiReportRequest

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `target_type` | `question` \| `answer` | 是 |  |
| `target_id` | string | 是 |  |
| `media_id` | string |  |  |
| `regions` | [ImageRegion](#imageregion)[] |  | 最多 20 項 |
| `text_ranges` | [TextRange](#textrange)[] |  | 最多 20 項 |
| `text_field` | `body` \| `title` |  | 只有問題能標記 title。預設 `body` |

### PiiReport

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `status` | [PiiReportStatus](#piireportstatus) | 是 |  |
| `target_type` | `question` \| `answer` | 是 |  |
| `target_id` | string | 是 |  |
| `question_id` | string | 是 |  |
| `media_id` | string \| null |  |  |
| `text_field` | `body` \| `title` \| `null` |  |  |
| `regions` | [ImageRegion](#imageregion)[] |  |  |
| `text_ranges` | [TextRange](#textrange)[] |  |  |
| `original_text` | string \| null |  | 僅 pending 時回傳給發問者 |
| `preview_url` | string（URL） \| null |  | 僅 pending 時回傳的短效連結 |
| `created_at` | string（時間） | 是 |  |
| `resolved_at` | string（時間） \| null |  |  |

### Notification

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `id` | string | 是 |  |
| `type` | `nearby_question` \| `new_answer` \| `answer_accepted` \| `assist_claimed` \| `assist_arrived` \| `assist_completed` \| `assist_cancelled` \| `pii_report_pending` \| `pii_report_resolved` \| `content_moderated` \| `badge_earned` | 是 |  |
| `title` | string | 是 |  |
| `body` | string | 是 |  |
| `question_id` | string \| null |  |  |
| `exact_location` | [Coordinates](#coordinates) \| null |  | 只有 nearby_question 通知且問題等級為 exact 時有值；問題解決或撤回後清除 |
| `read` | boolean | 是 |  |
| `created_at` | string（時間） | 是 |  |
