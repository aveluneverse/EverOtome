/**
 * confirm.js —— 引擎自刻確認彈窗（window.confirm 是系統視窗，
 * 吃不到主題 CSS，iOS/桌機瀏覽器還帶部署網域的系統抬頭
 * ＝截圖穿幫源。改 veil 玻璃＋token 配色＝主題全跟色、畫面語言永遠是引擎自己的）。
 *
 * confirmDialog(message, { imageUrl } = {}) → Promise<boolean>
 * - 確定＝true；取消／點暗幕／Esc＝false（點暗幕即關＝設定面板既有慣例，語意＝取消）；
 *   Enter＝確定（原生 confirm 同款鍵盤語意，Tab 在兩鈕間循環）。
 * - imageUrl：訊息上方插縮圖（blob URL 預覽）——Ctrl+V 貼圖的
 *   「先看見要傳什麼再確定」窗。呼叫端管 URL 生命週期（revoke 在 resolve 後，
 *   close() 先移除 DOM 再 resolve＝revoke 時 img 已不在畫面、永不破圖）。
 * - 已有彈窗開著時再呼叫＝直接回 false（單例守門：兩層確認疊在一起沒有正確語意，
 *   實務上呼叫點都在使用者動作後、不可能同時，這是防禦線不是流程）。
 * - focus 管理：開＝聚焦「確定」；關＝還原呼叫前 focus（鍵盤使用者不迷路）。
 * - 純顯示層元件：不碰 fetch／狀態，呼叫端拿 boolean 自己走原本的流程。
 */
import { t, tEl, tAttr } from "./i18n.js";

export function confirmDialog(message, { imageUrl } = {}) {
  if (document.querySelector(".confirm-veil")) return Promise.resolve(false);
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const veil = document.createElement("div");
    veil.className = "confirm-veil";
    const card = document.createElement("div");
    card.className = "confirm-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    if (imageUrl) {
      const img = document.createElement("img");
      img.className = "confirm-img";
      img.src = String(imageUrl);
      tAttr(img, "alt", "confirm.previewAlt");
      card.appendChild(img);
    }
    const msg = document.createElement("p");
    msg.className = "confirm-msg";
    msg.textContent = String(message == null ? "" : message); // XSS 紀律：textContent 路徑
    card.appendChild(msg);
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "confirm-ok";
    tEl(okBtn, "confirm.ok");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "confirm-cancel";
    tEl(cancelBtn, "confirm.cancel");
    actions.appendChild(okBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    veil.appendChild(card);

    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      veil.remove();
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Tab") {
        // 迷你 focus trap：彈窗下的頁面被暗幕蓋住，Tab 只在兩顆鈕之間走
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };
    okBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    veil.addEventListener("click", (e) => {
      if (e.target === veil) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(veil);
    okBtn.focus();
  });
}

/**
 * confirmPhotoDialog({ files, maxCount, initialText, placeholder })
 *   → Promise<{ok, text, files}>
 * —— 貼圖預覽確認窗（跟即時通訊軟體一樣，圖＋說明文字一起送；累積模式：真實
 * 工作流常是截圖→貼、再截→再貼＝逐張 Ctrl+V——窗存活期間 document 層接手
 * 後續 paste，新圖追加進縮圖列、滿額誠實提示，最後一批一起送）。
 *
 * 契約：
 * - 收 **File 物件清單**（不收 URL）：預覽 blob URL 由窗內部自建自 revoke
 *   （close 先移除 DOM 再 revoke＝永不破圖），呼叫端不管預覽 URL 生命週期。
 * - 確定＝{ok:true, text:輸入框當下內容, files:窗內當下清單（含後續貼進來的）}；
 *   取消／暗幕／Esc＝{ok:false, text:"", files:[]}。
 * - maxCount（預設 3＝單則上限）：初始清單與後續追加合計超額＝**收前 N 張＋
 *   縮圖列如實呈現＋提示行亮「一次最多 N 張」**——縮圖列就是「將送出的完整清單」，
 *   所見即所送，永不默默丟張（看一眼就知道收了哪幾張，不對就取消）。
 * - 窗存活期間 document capture 接 paste：有 image item → 追加（preventDefault
 *   ＝擋掉瀏覽器把「複製的檔案」變成檔名文字貼進說明框）；純文字貼上完全放行
 *   （說明框照常可貼字）。
 * - initialText 預填（呼叫端帶主輸入框現有文字進來＝先打字再貼圖的情境）；
 *   窗內改的以窗內為準。
 * - focus 開窗落輸入框；Enter＝確定送出，IME 組字中的 Enter（選字）不觸發
 *   （e.isComposing guard，中文輸入常見情境）；Shift+Enter＝textarea 原生換行。
 * - Tab 三元素循環：輸入框→確定→取消。
 * - 單例守門與 confirmDialog 共用 .confirm-veil 查詢＝兩種窗互斥。
 * - 不碰 fetch／WS／全域狀態；上傳與送出全歸呼叫端。
 */
export function confirmPhotoDialog({ files, maxCount, initialText, placeholder } = {}) {
  if (document.querySelector(".confirm-veil")) {
    return Promise.resolve({ ok: false, text: "", files: [] });
  }
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const limit = Math.max(1, Number(maxCount) || 3);
    const picked = []; // File[]（縮圖列的真身；resolve 時原樣交回）
    const urls = []; // 對應預覽 blob URL（窗自管，close 全 revoke）

    const veil = document.createElement("div");
    veil.className = "confirm-veil";
    const card = document.createElement("div");
    card.className = "confirm-card";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");

    const strip = document.createElement("div");
    strip.className = "confirm-imgs";
    card.appendChild(strip);
    const hint = document.createElement("p");
    hint.className = "confirm-hint";
    hint.setAttribute("aria-live", "polite"); // 螢幕閱讀器也聽得到「沒收進來」
    card.appendChild(hint);

    /** alt 與 ✕ 鈕 aria-label 全量重算（單張 alt 不帶序號＝舊行為）。 */
    const refreshLabels = () => {
      const thumbs = strip.querySelectorAll(".confirm-thumb");
      // 迴圈變數刻意不叫 t——會遮蔽本檔從 i18n.js import 的 t()。
      thumbs.forEach((thumb, i) => {
        const img = thumb.querySelector("img");
        if (thumbs.length === 1) {
          tAttr(img, "alt", "confirm.previewAlt");
        } else {
          img.alt = t("confirm.previewAltN", { i: i + 1, n: thumbs.length });
          // 從單張（tAttr 標記）切到多張（帶參數，tAttr 不支援 params）時，
          // 舊的 data-i18n-attr 標記要一併清掉——縮圖節點會跨次 refreshLabels()
          // 留存（addFiles／removeThumb 不重建既有縮圖），沒清乾淨的話下次語系
          // 切換的全域 applyDom() 會把這裡的複數版 alt 蓋回單張版。
          delete img.dataset.i18nAttr;
        }
        thumb.querySelector(".confirm-thumb-x").setAttribute("aria-label", t("confirm.removeNth", { i: i + 1 }));
      });
    };

    /** 移除單張（縮圖右上 ✕）。刪光＝收窗（面板清空即關，語意＝取消）；
     * 低於上限後滿額提示解除、可以再貼。 */
    const removeThumb = (thumb) => {
      const thumbs = Array.prototype.slice.call(strip.querySelectorAll(".confirm-thumb"));
      const i = thumbs.indexOf(thumb);
      if (i < 0) return;
      picked.splice(i, 1);
      const removed = urls.splice(i, 1)[0];
      thumb.remove();
      try {
        URL.revokeObjectURL(removed);
      } catch (e) {
        /* jsdom／舊環境無此 API */
      }
      hint.textContent = "";
      if (!picked.length) {
        close(false);
        return;
      }
      refreshLabels();
    };

    /** 追加檔案進縮圖列（超額拒收＋提示）。每顆縮圖＝.confirm-thumb（img＋✕）。 */
    const addFiles = (list) => {
      let rejected = 0;
      for (const f of list || []) {
        if (!f) continue;
        if (picked.length >= limit) {
          rejected += 1;
          continue;
        }
        picked.push(f);
        const u = URL.createObjectURL(f);
        urls.push(u);
        const thumb = document.createElement("div");
        thumb.className = "confirm-thumb";
        const img = document.createElement("img");
        img.className = "confirm-img";
        img.src = u;
        thumb.appendChild(img);
        const x = document.createElement("button");
        x.type = "button";
        x.className = "confirm-thumb-x";
        // ✕ 圖示＝inline SVG 兩線（Feather stroke 家族，不用 emoji）；
        // createElementNS 純節點構建＝維持「不經過 innerHTML」紀律
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2.4");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("aria-hidden", "true");
        [["6", "6", "18", "18"], ["18", "6", "6", "18"]].forEach(([x1, y1, x2, y2]) => {
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", x1);
          line.setAttribute("y1", y1);
          line.setAttribute("x2", x2);
          line.setAttribute("y2", y2);
          svg.appendChild(line);
        });
        x.appendChild(svg);
        x.addEventListener("click", () => removeThumb(thumb));
        thumb.appendChild(x);
        strip.appendChild(thumb);
      }
      refreshLabels();
      if (rejected) hint.textContent = t("confirm.maxN", { n: limit });
      return rejected;
    };
    addFiles(files);

    // textarea（支援 Shift+Enter 換行——單行 input 換不了行）；
    // Enter 送出語意不變（onKey 判 shiftKey 放行原生換行）。
    const field = document.createElement("textarea");
    field.className = "confirm-input";
    field.rows = 2;
    field.value = String(initialText == null ? "" : initialText);
    field.placeholder = String(placeholder == null ? "" : placeholder);
    tAttr(field, "aria-label", "confirm.captionLabel");
    card.appendChild(field);
    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "confirm-ok";
    tEl(okBtn, "confirm.ok");
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "confirm-cancel";
    tEl(cancelBtn, "confirm.cancel");
    actions.appendChild(okBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    veil.appendChild(card);

    const close = (ok) => {
      const text = ok ? field.value : "";
      const outFiles = ok ? picked.slice() : [];
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("paste", onDocPaste, true);
      veil.remove();
      // revoke 在 DOM 移除之後＝畫面上已無 img 引用，永不破圖（confirmDialog 同慣例）
      for (const u of urls) {
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
          /* jsdom／舊環境無此 API：預覽已隨窗消失，略過即可 */
        }
      }
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve({ ok, text, files: outFiles });
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        if (e.isComposing) return; // IME 選字的 Enter 不是「送出」
        if (e.shiftKey) return; // Shift+Enter＝textarea 原生換行
        e.preventDefault();
        close(true);
      } else if (e.key === "Tab") {
        e.preventDefault();
        // ring 動態算：✕ 鈕會隨貼上／移除增減（主流輸入→送出在前、✕ 殿後）
        const ring = [field, okBtn, cancelBtn].concat(
          Array.prototype.slice.call(veil.querySelectorAll(".confirm-thumb-x")),
        );
        const i = ring.indexOf(document.activeElement);
        ring[(i + 1 + ring.length) % ring.length].focus();
      }
    };
    // 累積模式：窗開著繼續 Ctrl+V＝追加進同一批。capture 在 document 層＝不管
    // focus 落在說明框還是鈕上都接得住；有 image 才 preventDefault（擋掉「複製
    // 檔案→貼上變檔名文字」進說明框），純文字貼上原樣放行。
    const onDocPaste = (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const got = [];
      for (let i = 0; i < items.length; i++) { // index 迴圈：DataTransferItemList 的 iterator 舊 WebKit 沒有
        const it = items[i];
        if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
          const f = it.getAsFile();
          if (f) got.push(f);
        }
      }
      if (!got.length) return;
      e.preventDefault();
      e.stopPropagation(); // 主輸入框的 paste handler 不該再收到這批（窗正在收）
      addFiles(got);
    };
    okBtn.addEventListener("click", () => close(true));
    cancelBtn.addEventListener("click", () => close(false));
    veil.addEventListener("click", (e) => {
      if (e.target === veil) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("paste", onDocPaste, true);
    document.body.appendChild(veil);
    field.focus();
  });
}
