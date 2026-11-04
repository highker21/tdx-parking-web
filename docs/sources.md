# 資料來源與 opview 對照

| 資料 | 端點（經 Worker 的路徑） | opview 對照 |
|---|---|---|
| TDX 路外位置 | `/tdx/api/basic/v1/Parking/OffStreet/CarPark/City/{City}`（$top=500 分頁） | parking_api.dart downloadStatic |
| TDX 路邊位置 | `/tdx/api/basic/v1/Parking/OnStreet/ParkingSegment/City/{City}` | 同上 |
| TDX 路外空位 | `/tdx/api/basic/v1/Parking/OffStreet/ParkingAvailability/City/{City}`（$filter=CarParkID） | parking_api.dart nearby / loadKind |
| TDX 路邊空位 | `/tdx/api/basic/v1/Parking/OnStreet/ParkingSegmentAvailability/City/{City}` | 同上 |
| 新北位置／空位 | `/ntpc/{dataset}/json?page=&size=1000` | parking_local.dart（JSON 分頁；完整 CSV 會被拒） |
| 新竹位置＋空位 | `/hccg/GetParkInfo` | parking_local.dart |
| TDX token | 瀏覽器直接 POST `tdx.transportdata.tw/auth/.../token`（不經 Worker） | parking_api.dart _authorization |

- 縣市支援清單照 opview parking_catalog.dart（2026-10-31 依 TDX OAS 查核）。
- 縣市判斷：OpenStreetMap Nominatim reverse（zoom=5、座標只送小數 2 位、`ISO3166-2-lvl4` 對應縣市）。使用政策要求每秒最多 1 次、要能辨識來源：瀏覽器會自動帶 Referer，且移動不到 2 km 沿用上次結果，每次查詢最多 1 次。
- 地圖圖磚：tile.openstreetmap.org，頁面標示 © OpenStreetMap contributors，不預抓、不快取。
- 授權：opview © 2026 Rick Lan（非商業）；TDX、新北、新竹資料依政府資料開放授權條款第 1 版。

## YouBike（2026-11-04 加）
| 資料 | 端點（經 Worker） | 說明 |
|---|---|---|
| 站點 | `/tdx/api/basic/v2/Bike/Station/City/{City}`（$top=5000，必要時 $skip，最多 3 頁） | 一天快取一次 |
| 即時可借／可還 | `/tdx/api/basic/v2/Bike/Availability/City/{City}`（$filter=StationUID，最多 30 站） | 每次查詢 1 筆 |

- 來源：TDX Swagger「公共運輸-自行車」（v2；v1 回 404）。支援 15 縣市；ServiceType 1=YouBike1.0、2=YouBike2.0、3=Moovo。
- ⚠️ 欄位是用 2026-11-04 **不帶金鑰**抽樣核對（Availability 1 筆、Station 台北全量 1824 站）；**尚未做帶金鑰的端到端驗證**，本機 E2E 用 mock 回應。
- YouBike 一定要使用者自己的 TDX 金鑰：不帶金鑰的額度以 Worker 的 IP 計算，會被所有使用者共用。

## 即時路況（2026-11-04 加）
| 資料 | 端點（經 Worker） | 快取 |
|---|---|---|
| 國道／省道 路段線型 | `/tdx/api/basic/v2/Road/Traffic/SectionShape/{Freeway,Highway}` | IndexedDB 1 天（省道約 1.9 MB） |
| 國道／省道 路段名稱 | `/tdx/api/basic/v2/Road/Traffic/Section/{Freeway,Highway}`（$select 4 欄；省道 6836 段約 100 KB） | IndexedDB 1 天 |
| 路段即時車速 | `/tdx/api/basic/v2/Road/Traffic/Live/{Freeway,Highway}`（$filter=SectionID，每批 ≤40 段） | 不快取 |
| 國道事件 | `/tdx/api/basic/v2/Road/Traffic/Live/News/Freeway` | 不快取 |

- 不帶座標：整包路網下載後由前端篩附近 2 km（地圖只畫 5 km 內）。
- 車速顏色：國道 ≥60 綠／30–59 黃／<30 紅；省道 ≥40／20–39／<20。資料 >5 分鐘或車速 ≤0 為灰色。
- ⚠️ 欄位以 2026-11-04 **不帶金鑰**抽樣核對（各端點 1–2 次，合計約 12 次匿名額度）；本機 E2E 用合成路網 mock，**尚未做帶金鑰的端到端驗證**。
- 參考 opview：其路況由 comma 端 dplcc tdxd 依行進方向推「前方路段」；網頁無可靠行進方向，改為「附近路段」。

## 觀光（已移除）
- 2026-11-04 觀光分頁上線後 TDX 觀光 V2 回 500、抓不到資料，已刪除分頁；Worker 觀光路由已移除（一律 403）。

## 警廣即時路況（2026-11-04 加）
- 來源：data.gov.tw 15221「警廣即時路況」，政府資料開放授權條款第 1 版；`https://rtr.pbs.gov.tw/NMP103_PbsWS/resources/roadData/opendata`（無 CORS → 經 Worker `/pbs/roadData`，固定一條、不帶 query、不轉送認證）。
- 不需 TDX 金鑰、不吃 TDX 額度；全台最新 1000 筆（約 462 KB，B 於 2026-11-04 03:0x 唯讀實測 1 次），前端以 x1/y1（字串→parseFloat、台灣範圍檢查）篩 5 公里內；60 秒內不重抓。
- 欄位（B 實測）：roadtype、road、direction、areaNm、comment、happendate、happentime、srcdetail、x1、y1。全部 esc；comment >120 字以 details 收合。

## 公車／軌道（2026-11-04f）
- TDX 基礎服務（OAS 2998e851 公車、5fa88b0c 台鐵 v3、268fc230 軌道 v2）：公車站位＋N1 預估到站（StopUID 篩選）、台鐵車站／即時看板／今日站別時刻、高鐵車站／站別日時刻、捷運車站／即時看板（TRTC、KRTC、TYMC、KLRT）。
- 不用進階服務（NearBy）：不送座標、省點數。隱私：公車送出附近 1–4 個站位的 StopUID；台鐵／高鐵送最近一站代碼。

## 國道即時道路事件（2026-11-04i）
- TDX 基礎服務「道路事件 v1」（OAS 60abfa19）`/v1/Traffic/RoadEvent/LiveEvent/Freeway`：路名、方向、里程、交流道、座標（Positions）、影響車道。Worker 固定一條，只收 `$format=JSON`／`$top`。
- 失敗時退回 `Live/News/Freeway`（只有標題）。
