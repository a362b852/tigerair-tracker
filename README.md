# 虎航票價追蹤

每小時抓一次虎航官網日曆票價，追蹤**桃園 ↔ 日本、韓國**未來 180 天的單程最低價。

- 網站：https://a362b852.github.io/tigerair-tracker/ （可自訂天數、日期，看票價日曆）
- 最新表格：[REPORT.md](REPORT.md)
- 通知：跌到歷史新低時，以及每天早上 8 點後的第一次執行，會在「虎航票價通知」Issue 留言，GitHub 會寄信給你。
- 價格未含稅金與附加費用。

## 檔案

| 檔案 | 用途 |
|---|---|
| `tracker.mjs` | 全部邏輯，零外部套件 |
| `.github/workflows/track.yml` | 每小時排程 |
| `data/state.json` | 歷史最低價與每日紀錄（自動產生） |
| `REPORT.md` | 票價表（自動產生） |
| `docs/index.html` | 網站（GitHub Pages） |
| `docs/fares.json` | 網站用的票價資料（自動產生） |

## 安全

- 只會連到 `api-book.tigerairtw.com` 和 `api.github.com`，程式裡寫死白名單，其他網址一律拒絕。
- 不用任何 secret，只用 GitHub 自動提供、僅限本 repo 的 `GITHUB_TOKEN`（權限只有 contents、issues）。
- 唯一用到的外部 Action 是 GitHub 官方的 `actions/checkout`，釘在固定 commit。

## 來回行程（trips.json）

指定玩幾天，程式會找出每個目的地「哪天去、哪天回」來回加起來最便宜。去程那天算第 1 天，所以 5 天 = 5 天 4 夜。東京（成田／羽田）、首爾（仁川／金浦）會自動混搭機場。

```json
[
  { "名稱": "5天", "天數": 5 },
  { "名稱": "4到6天", "天數": "4-6" },
  { "名稱": "跨年", "天數": "4-6", "最早出發": "2026-12-26", "最晚出發": "2027-01-02" }
]
```

- `天數`：固定天數寫數字，範圍寫 `"4-6"`（2～30 天）
- `最早出發`、`最晚出發`：可省略
- 最多 10 個行程，在 GitHub 網頁上直接編輯這個檔案即可，下一次執行就會套用

## 修改

- 航線：改 `tracker.mjs` 裡的 `DESTINATIONS`
- 天數：改 `DAYS_AHEAD`
- 頻率：改 `track.yml` 的 `cron`
- 手動執行：Actions → 虎航票價追蹤 → Run workflow
