# 維運手冊

## 部署架構

```text
手機 ── HTTPS ── Cloudflare ── 反向代理 ── frp ── 本機 127.0.0.1:5121（Node.js）
```

- 後端跑在開發機上，由一支 Node.js 程序提供所有服務。
- `frpc` 把本機 `5121` 轉出去，設定在 repo 根目錄的 `frpc.toml`。
- Cloudflare 之前的轉送設定不在這個 repo，要問前任負責人。
- 伺服器**沒有**開機自動啟動，也**沒有**當掉自動重啟。

## 環境變數

範例在 `backend/.env.example`。

| 變數 | 目前的值 | 說明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 只讓本機和 frp 連線 |
| `PORT` | `5121` | 要和 `frpc.toml` 的 `localPort` 一致 |
| `PUBLIC_BASE_URL` | `https://tpcodefest.mcloudtw.com` | 媒體網址的前綴。代理沒有傳 HTTPS 資訊，**不設定會變成 `http://`** |
| `FCM_SERVICE_ACCOUNT_FILE` | 金鑰檔的路徑 | 不設定就不發推播，也不會報錯 |
| `ADMIN_TOWNPASS_IDS` | 逗號分隔的 ID | 登入時取得管理員身份。**不要寫進 repo**，目前知道 ID 就能登入 |
| `BOT_TOWNPASS_IDS` | 逗號分隔的 ID | 登入時取得機器人身份 |
| `EMBEDDING_URL` | `http://127.0.0.1:5122` | 語意快取的模型服務；不設定就不啟用 |
| `SEMANTIC_CACHE_THRESHOLD` | 預設 `0.92` | 越高越不容易誤答，也越不容易命中 |
| `DATA_DIR` | 預設 `./data` | 資料庫和媒體檔 |
| `CORS_ORIGIN` | 預設 `*` | 正式上線要改成前端網域 |
| `FCM_CHANNEL_ID` | 預設值 | 要和 App 的通知通道一致 |
| `PUSH_QUESTION_URL` | 預設值 | 點通知開啟的網址 |

## 啟動

```bash
cd backend
HOST=127.0.0.1 PORT=5121 \
PUBLIC_BASE_URL=https://tpcodefest.mcloudtw.com \
FCM_SERVICE_ACCOUNT_FILE="$PWD/<金鑰檔名>.json" \
EMBEDDING_URL=http://127.0.0.1:5122 \
ADMIN_TOWNPASS_IDS=<管理員 ID> BOT_TOWNPASS_IDS=<Bot ID> \
setsid nohup node src/server.js >> data/server.log 2>&1 < /dev/null &
```

啟動後確認：

```bash
tail -2 data/server.log                                       # 要看到 FCM push enabled
curl https://tpcodefest.mcloudtw.com/api/v1/healthz           # {"status":"ok"}
```

frp 沒在跑時，在 repo 根目錄執行 `frpc -c ./frpc.toml`。

## 語意快取的模型服務

模型是 multilingual-e5-large（MIT 授權）的量化 ONNX，約 560 MB，載入後約佔 1.1 GB 記憶體，尖峰約 2.5 GB。換模型後要清空 `question_embeddings`，否則新舊向量會混在一起比對。服務只聽本機，**不可對外開放**。沒開也不影響發問，只是不會自動回覆，恢復後會補算舊問題。

首次安裝：

```bash
cd backend/embedding
./download-model.sh
python3 -m venv venv && venv/bin/pip install -r requirements.txt
```

啟動：

```bash
cd backend/embedding
setsid nohup venv/bin/python server.py >> ../data/embedding.log 2>&1 < /dev/null &
curl http://127.0.0.1:5122/healthz
```

## 停止與重新部署

```bash
ss -ltnp | grep ':5121'      # 找到 pid
kill <pid>                   # 收到 SIGTERM 會正常關閉

git pull
cd backend && npm ci && npm test
# 再執行上面的啟動指令
```

重啟時 Socket.IO 和 SSE 會斷線，前端要能自動重連。

## 資料

全部在 `backend/data/`，不進版控：

| 路徑 | 內容 |
|---|---|
| `app.db`（含 `-wal`、`-shm`） | SQLite 資料庫 |
| `media/` | 照片與語音 |
| `server.log` | 伺服器記錄 |

**備份：** 先停止伺服器，再複製整個 `data/`。資料庫和媒體檔要一起備份，否則資料會對不起來。

**清空重來：** 停止伺服器後刪除 `data/`，啟動時會自動重建。所有帳號、問題和推播 token 都會消失；前端登入和載入時會重新建立帳號和 token。

**改資料表：** 沒有通用的遷移機制。啟動時會建立不存在的資料表；既有資料表新增欄位時，要在 `src/db.js` 的 `openDatabase` 補 `ALTER TABLE`，或清空重來。

## 常見問題

| 症狀 | 先查什麼 |
|---|---|
| 網址打不開 | `ss -ltnp \| grep 5121`、`pgrep -a frpc`，再用 `curl http://127.0.0.1:5121/api/v1/healthz` 分辨是後端還是轉送的問題 |
| 記錄沒有 `FCM push enabled` | `FCM_SERVICE_ACCOUNT_FILE` 沒設 |
| 收不到推播 | `push_tokens` 有沒有該使用者的 token、`server.log` 有沒有 `FCM 推播失敗`、App 的 `google-services.json` 是否來自同一個 Firebase 專案 |
| token 註冊後消失 | FCM 判定無效時會自動刪除，通常是專案不符或 App 重裝 |
| 媒體網址是 `http://` | `PUBLIC_BASE_URL` 沒設 |
| 回 404「找不到這個路徑」 | 線上版本可能比前端舊，比對 `git log` 和 API 規格 |
| 上傳很慢 | 曾量到 15 MB 要 69 秒，瓶頸可能在本機上傳或 frp，前端要先壓縮 |

查看資料庫（唯讀）：

```bash
cd backend
node -e "const D=require('better-sqlite3');const d=new D('data/app.db',{readonly:true});console.log(d.prepare('SELECT user_id,platform,updated_at FROM push_tokens').all())"
```

## 金鑰

- Firebase 金鑰和 `frpc.toml` 已被 `.gitignore` 排除。**repo 是 public**，commit 前請看 `git status`。
- 金鑰外流或懷疑外流時，到 Firebase 主控台撤銷並產生新的，更新檔案後重啟伺服器。
