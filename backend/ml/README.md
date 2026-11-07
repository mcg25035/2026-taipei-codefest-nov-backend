# 問題分類器

字元 n-gram + TF-IDF + 邏輯迴歸，純 JavaScript。不使用 LLM，不呼叫外部服務，文字只在記憶體內計算。

```bash
node ml/tune.mjs       # 只用訓練句做交叉驗證，選設定
node ml/train.mjs      # 輸出 ml/model.json
node ml/evaluate.mjs   # 用 seed/test 評估
```

`seed/test` 不參與訓練；要改資料或參數時，請用 `tune.mjs` 判斷，不要拿測試集來調。

## 線上行為

`POST /questions` 沒帶 `category` 時會呼叫分類器。信心達 70% 才自動分類，否則是 `uncategorized`，由志工用 `PUT /questions/{id}/category` 分類。

## 訓練資料

下載後放在 `ml/data/`（不進版控）：

| 檔案 | 來源 | 用途 |
|---|---|---|
| `taipei-faq.json` | [臺北市市政網站整合平台之常見問答](https://data.gov.tw/dataset/129074)，臺北市政府資訊局 | 只取標題，用關鍵字產生弱標籤 |
| `scam165.csv` | [165 反詐騙諮詢專線－詐騙闢謠專區](https://data.gov.tw/dataset/38262)，內政部警政署 | 只取標題，標為疑似詐騙 |

兩份皆依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)使用。`seed/` 內的句子由 Claude 模擬長輩和外籍人士的口吻生成，不是真實使用者資料。

## 限制

測試句和訓練句出自同一個作者，準確率很可能高於真實情況。上線前要用真人寫的句子重新評估。
