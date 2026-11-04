# tdx-parking-web

手機用的「附近停車／交通即時資訊」網頁 app（PWA），資料來自交通部 TDX 與各地政府開放資料。純靜態前端，加一支 Cloudflare Worker 轉送請求；部分只接受台灣 IP 的政府主機，再經一台放在台灣的轉送站代查。

> 授權：**非商業**（見 [LICENSE](LICENSE)）。這不是 OSI 定義的開源授權；商業用途需取得書面同意（請開 GitHub issue 聯絡）。
> 部分資料處理邏輯參考 R 大（Rick Lan）的 [opview](https://github.com/herizon1054/opview)，特此致謝，授權全文見 [NOTICE](NOTICE)。

## 功能

| 分頁 | 內容 | 主要來源 |
|---|---|---|
| 🅿️ 停車 | 附近路外停車場與路邊路段、即時空位、費率文字、依距離／空位／費用排序；路邊路段可「看每一格」空／有車（目前高雄） | TDX 停車、新北市、新竹市 |
| 🚲 YouBike | 附近站點、可借／可還 | TDX 公共自行車 |
| 🚦 路況 | 國道／省道車速與國道事件、警廣即時路況、消防局 119 即時案件（高雄、臺南、新竹市） | TDX、警察廣播電臺、各市消防局 |
| 🚌 到站 | 公車、台鐵、高鐵、捷運（次分頁） | TDX 公共運輸 |
| 🧾 路邊停車費查詢 | 輸入車牌查各縣市未繳路邊停車費 | TDX 第三方服務「全國路邊停車費查詢 API」 |

其他：我的最愛地點（不定位也能以常用地點為中心查詢）、深色模式、可「加入主畫面」。

## 架構

```
手機瀏覽器（web/）
  ├─ 直接向 TDX 換 token（使用者自己的金鑰，只存在手機）
  └─ 資料請求 → Cloudflare Worker（worker/：白名單路徑、限制大小、不記錄內容）
                   ├─ 一般來源：直接打上游
                   └─ 只收台灣 IP 的來源（部分縣市停車費、警廣、消防局）
                        → Cloudflare Tunnel → 台灣境內轉送站（relay/，node，只綁 127.0.0.1、要密語）→ 上游
```

## 自己部署

需要：TDX 會員與 API 金鑰（免費）、Cloudflare 帳號、（選用）一台在台灣網路上的主機跑轉送站。

1. **前端**：把 `web/` 放到任何靜態空間（例如 GitHub Pages），並把 `web/index.html` 裡的 `PROXY` 改成你的 Worker 網址。頁尾「工具版本」與 `web/sw.js` 的 `CACHE` 每次更新要一起改。
2. **Worker**：
   ```sh
   cd worker
   # wrangler.toml：ALLOWED_ORIGINS 改成你的前端網址
   npx wrangler deploy
   ```
   路邊停車費查詢需要 `[[ratelimits]]` binding（沒有時一律回 503，避免變成無限制的查車牌代理）。
3. **轉送站**（選用；不設定時，那些只收台灣 IP 的來源會顯示「轉送站暫時連不上」，其他功能照常）：
   ```sh
   cp relay/relay_secret.example.txt relay/relay_secret.txt && chmod 600 relay/relay_secret.txt   # 填入隨機 key
   node relay/tw_relay.mjs          # 監聽 127.0.0.1:8790
   ```
   用 Cloudflare Tunnel 把一個網址指到 `http://localhost:8790`，再設定 Worker 的機密：
   ```sh
   npx wrangler secret put RELAY_URL   # 例：https://relay.example.com
   npx wrangler secret put RELAY_KEY   # 與 relay_secret.txt 的 key 相同
   ```
   開機自動啟動可參考 `relay/com.example.tw-relay.plist`（macOS launchd）。
4. `shared/paybill_rules.json` 是 Worker 與轉送站共用的規則（上游網址、轉送縣市、車牌格式、逾時），改了兩邊都要重新部署／重啟。

## 隱私

- TDX 金鑰與「記住車牌」只存在使用者自己的瀏覽器。
- 定位只在手機上計算距離；車牌只放在 POST body，不進網址，Worker 與轉送站都不記錄內容。
- 部分查詢會透露大約位置：公車站牌編號、路邊路段編號、地址搜尋文字（送到 OpenStreetMap）。

## 資料來源與授權

- 交通部 TDX 運輸資料流通服務、新北市政府、新竹市政府、警察廣播電臺、高雄市／臺南市／新竹市消防局公開資料，依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)使用；合併與篩選不代表機關背書。
- 地圖圖資 © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors；地圖元件 Leaflet。
- 詳細端點與限制見 [docs/sources.md](docs/sources.md)。
- 費率、空位等皆為各機關提供的資料，僅供參考，以現場公告為準。
