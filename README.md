# MEMORy app

《回憶》小程序的可點擊 demo，依課程簡報第四章的介面與流程製作。這是概念展示，不是正式產品，資料都只留在瀏覽器當次的畫面裡。

## 可以體驗什麼

- **裝扮自己的空間：** 掃描老物件、添加故事，在 8×8 的等距格線上拖放家具。每件物件都有佔地與高度。
- **參觀他人的空間：** 選一個空間，點亮著的老物件，閱讀、收聽或觀看故事。人物與故事都是虛構的示例。

## AI 轉換

掃描後，`src/worker.js` 會把照片和風格參考圖送給 Cloudflare Workers AI 的 FLUX.2 模型，畫在洋紅色底上，頁面再按顏色摳除，變成透明底，淺色物件也不會被挖空。另一個視覺模型會建議名稱與佔地。不需要 API 金鑰，照片不會存在本站。

額度用完或出錯時，會改用瀏覽器內的本機處理：以圖割（GrabCut）從畫面中央認出主體、去背成透明底，再壓色加描邊。背景單純、物件居中時效果最好。

模型和每日上限都在 `wrangler.jsonc` 的 `vars`（`DAILY_LIMIT` 是全站每日上限，`IP_DAILY_LIMIT` 是每個 IP 的每日上限）。要關閉 AI 時，把 `AI_ENABLED` 改成 `"false"`，再重新部署。

## 在本機執行

```bash
npm install
npm run dev
```

相機需要 HTTPS 或 localhost。沒有相機時，可以選照片或使用示例照片。

## 部署

```bash
npm run deploy
```

網站檔案都在 `public/`，後端在 `src/worker.js`，部署在 Cloudflare Workers 上，設定在 `wrangler.jsonc`。Wrangler 固定在 4.86.0，因為較新版本需要 Node 22。
