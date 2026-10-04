# 虎航票價追蹤（私人）

每小時抓一次虎航官網日曆票價，追蹤**桃園 ↔ 日本、韓國**未來 180 天的單程最低價。

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

## 安全

- 只會連到 `api-book.tigerairtw.com` 和 `api.github.com`，程式裡寫死白名單，其他網址一律拒絕。
- 不用任何 secret，只用 GitHub 自動提供、僅限本 repo 的 `GITHUB_TOKEN`（權限只有 contents、issues）。
- 唯一用到的外部 Action 是 GitHub 官方的 `actions/checkout`，釘在固定 commit。

## 修改

- 航線：改 `tracker.mjs` 裡的 `DESTINATIONS`
- 天數：改 `DAYS_AHEAD`
- 頻率：改 `track.yml` 的 `cron`
- 手動執行：Actions → 虎航票價追蹤 → Run workflow
