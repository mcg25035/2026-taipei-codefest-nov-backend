# 後端交接文件

這是 2026 臺北秋季程式設計節「城市通微服務大黑客松」的後端。截至 2026-11-07，API 已部署，並由 App 與論壇前端串接中。

| 文件 | 什麼時候看 |
|---|---|
| [維運手冊](./operations.md) | 啟動、部署、備份、排查問題 |
| [程式導覽](./code-guide.md) | 要修改程式 |
| [現況與風險](./status-and-risks.md) | 要接手開發或準備正式上線 |

API 細節不在這裡重複，請看：

- [API 規格](../api/api-spec.md)：給串接的人看的完整說明
- [`openapi.yaml`](../api/openapi.yaml)：規格來源，`api-spec.md` 由它產生
- [產品決策與狀態流程](../api/README.md)：為什麼這樣設計
- [分類器說明](../../backend/ml/README.md)

## 這個專案在做什麼

比賽主題是「看不懂」。規則不能用外部 LLM，所以改由人幫人：長者和外籍人士等數位弱勢者在城市通裡發問，由線上或附近的志工解答。

## 五分鐘上手

需要 Node.js 22 以上。

```bash
git clone https://github.com/mcg25035/2026-taipei-codefest-nov-backend.git
cd 2026-taipei-codefest-nov-backend/backend
npm ci
npm test
npm start
curl http://127.0.0.1:5121/api/v1/healthz   # 另開終端機，應回傳 {"status":"ok"}
```

沒有設定 FCM 金鑰時伺服器也能啟動，只是不會發推播。

## 目前環境

| 項目 | 內容 |
|---|---|
| 公開網址 | `https://tpcodefest.mcloudtw.com` |
| API | `https://tpcodefest.mcloudtw.com/api/v1` |
| 分類器測試頁 | `https://tpcodefest.mcloudtw.com/classify-test` |
| 程式 | [mcg25035/2026-taipei-codefest-nov-backend](https://github.com/mcg25035/2026-taipei-codefest-nov-backend)（**public**） |
| 論壇前端 | [yd-tw/TownPass-2026-web](https://github.com/yd-tw/TownPass-2026-web) |
| Firebase 專案 | `tp2026-a7fd7` |

## 交接時要另外給的東西

這些不在 repo 裡，要由前任負責人私下交付，不可貼到公開的地方：

- Firebase 服務帳號金鑰
- `frpc.toml`（含 frp token）
- 目前這台機器的存取權，以及 `backend/data/` 的資料
