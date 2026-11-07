# 管理後台功能規劃

這份文件列出管理後台應該有的功能，以及對應的後端 API。除了「後端還沒有的功能」以外，API 都已上線。

- **API：** `https://tpcodefest.mcloudtw.com/api/v1`
- **完整規格：** [API 規格](./api/api-spec.md)

## 登入

後台沿用 `POST /sessions`，用管理員的 ID 登入。管理員 ID 由伺服器的 `ADMIN_TOWNPASS_IDS` 設定，請向後端負責人索取，不要寫進 repo。

登入後檢查回傳的 `user.role`，不是 `admin` 就不顯示後台。之後每個請求都要帶 `Authorization: Bearer <token>`。

```json
POST /sessions
{ "townpass_user_id": "<管理員 ID>" }
```

## 功能清單

### 1. 頁面問題分析

找出使用者最常在哪些頁面遇到問題。這是 Demo 的重點。

- **總覽：** 問題總數、有和沒有頁面資訊的題數。
- **頁面排行：** 問題數、未解決、已解決、沒人回答、最後發問時間。
- **分類分布：** 每個頁面最常見的問題類型。
- **篩選：** 時間範圍（`since`、`until`）、功能（`service_id`）。

API：`GET /admin/analytics/pages`

> Demo 前要確認手機裝的是新版 App。舊版 App 不會回傳 `screen`，頁面大多只會顯示 `/`，分析不出結果。

### 2. 內容管理

- **問題列表：** 依狀態、分類、語言、標籤篩選，並可依標籤模糊搜尋。
- **問題詳情：** 內容、媒體、回答、頁面資訊和 `context.extra`（裝置資訊、瀏覽過的頁面）。管理員也看得到待確認的隱藏內容。
- **修改：** 問題的標題和內文、回答的內容。
- **刪除：** 問題或回答，包含已採納的回答。
- **整理：** 修改固定標籤和手動標籤、標記已解決。

| 動作 | API |
|---|---|
| 問題列表 | `GET /questions` |
| 問題詳情 | `GET /questions/{question_id}` |
| 回答列表 | `GET /questions/{question_id}/answers` |
| 修改問題 | `PATCH /admin/questions/{question_id}` |
| 修改回答 | `PATCH /admin/answers/{answer_id}` |
| 刪除問題 | `DELETE /questions/{question_id}` |
| 刪除回答 | `DELETE /answers/{answer_id}` |
| 修改分類 | `PUT /questions/{question_id}/category` |
| 修改標籤 | `PUT /questions/{question_id}/tags` |
| 標記已解決 | `POST /questions/{question_id}/resolve` |

介面要注意：

- **刪除要二次確認：** 沒有還原功能，內容只會留在稽核紀錄；媒體檔會真的刪除。
- **修改可能被擋：** 內容有待決定的文字個資標記時，API 回傳 409，要提示管理員先處理標記。
- **作者會收到通知：** 修改或刪除別人的內容時，對方會收到 `content_moderated` 通知。

### 3. 待處理事項

**待分類問題**

顯示分類器沒有把握的問題，讓管理員直接分類。

| 動作 | API |
|---|---|
| 列表 | `GET /questions?category=uncategorized` |
| 分類 | `PUT /questions/{question_id}/category` |

**個資標記**

顯示被標記的內容和範圍，由管理員決定是否遮蔽。發問者沒有回應時，內容會一直隱藏，管理員可以從這裡處理。

| 動作 | API |
|---|---|
| 待處理列表 | `GET /admin/pii-reports?status=pending` |
| 同意遮蔽 | `POST /pii-reports/{report_id}/accept` |
| 拒絕並恢復顯示 | `POST /pii-reports/{report_id}/deny` |

同意遮蔽後**無法復原**，按下前要二次確認。

### 4. 使用者管理

- **列表：** 搜尋暱稱或 ID、依身份篩選，顯示積分、可信度評分和停權狀態。
- **身份：** 設定為 `user`、`admin` 或 `bot`。
- **停權：** 可填原因，也能解除。停權會立即登出並中斷連線，已發布的內容不會自動移除。

| 動作 | API |
|---|---|
| 列表 | `GET /admin/users` |
| 設定身份 | `PUT /admin/users/{user_id}/role` |
| 停權 | `POST /admin/users/{user_id}/ban` |
| 解除停權 | `POST /admin/users/{user_id}/unban` |

管理員不能操作自己的帳號，API 會回傳 403，頁面上要停用這些按鈕。

### 5. 語意快取評分

列出被機器人引用過的解答，找出常配對錯的內容。分數最低的排在最前面，也會顯示引用次數、正負回饋數和是否已停用。

API：`GET /admin/analytics/cache`

### 6. 稽核紀錄

查看管理員做過的刪除和修改。

- **列表：** 時間、管理員、動作、對象。
- **明細：** 修改前後的內容、被刪除的原文。
- **篩選：** 動作（`action`）、對象 ID（`target_id`）、管理員 ID（`admin_id`）。

API：`GET /admin/audit-log`

| `action` | 說明 |
|---|---|
| `question.delete`、`answer.delete` | 刪除內容，`detail` 保留原文 |
| `question.edit`、`answer.edit` | 修改內容，`detail` 有 `before` 和 `after` |
| `question.category`、`question.tags` | 修改分類或標籤 |
| `question.resolve` | 標記已解決 |
| `pii.accept`、`pii.deny` | 決定個資標記 |
| `user.role`、`user.ban`、`user.unban` | 管理使用者 |

稽核紀錄可能含有被刪內容裡的個資，只能在後台顯示。

## Demo 建議順序

1. **頁面問題分析：** 最能展示這個產品的價值。
2. **待處理事項：** 順勢展示分類器和個資保護。
3. **內容管理：** 示範刪除，再帶到稽核紀錄。
4. **使用者管理：** 時間不夠可以最後做。

## 後端還沒有的功能

| 功能 | 目前的替代方式 |
|---|---|
| 搜尋問題的標題或內文 | 用標籤模糊搜尋 |
| 依停權狀態篩選使用者 | 由前端依 `banned_at` 自行過濾 |
| 整體儀表板，例如每日問題數、解決率 | 無 |
| 還原被刪除的內容 | 從稽核紀錄查原文，再手動處理 |

如果要加，建議先做每日問題數和解決率，改動小，也適合做成 Demo 圖表。
