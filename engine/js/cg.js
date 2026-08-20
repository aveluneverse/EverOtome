// cg.js — CG 演出層。
// 職責：相冊資料（無 desc 通道）、#cg-layer 淡變、渲染規則（intimate/scene →
// 顯示哪張）、場景行回呼、桌機／手機雙軌分組（items 每張帶 target
// "desktop"|"mobile"，舊單張 mobile flag 制退役）。狀態唯一來源＝server 的
// cg_state frame（前端零猜測、無 localStorage——F5 由 WS 重連推初始態還原）。
// 卡名／描述多語：item.name／item.desc 可為字串，或每語系一個的物件
// { "zh-Hant": "…", "en": "…" }（同 config 主題／造型／家具 label 的既有契約）
// ——殼所有讀點一律走 pickLabel() 依當前介面語系挑（字串原樣回傳）；視圖態
// 面板開著時換語系即時重繪（onLocaleChange → renderView）；管理態儲存保形
// 送回（物件形＝原物件展開、只換「預填那格」的語系；卡片原本沒有的語系只在
// 使用者真的改了字才新增；字串形照舊送字串），見 mergeLabel()。
import { t, tEl, tAttr, pickLabel, getLocale, onLocaleChange } from "./i18n.js";

const MOBILE_MQ = "(max-width: 899px)";

/** 管理態儲存的保形回傳。與 pickLabel() 成對——讀用 pick、寫用 merge。
 * - orig 非物件（字串／缺）＝照舊回輸入框的字串 value。
 * - orig 是多語物件：`loc`＝這張卡預填時用的語系、`shown`＝預填進輸入框的值
 *   （pickLabel 的結果，缺 loc 那格時是 fallback 語系的字）。若 orig[loc] 缺或
 *   空字串**且** value === shown（使用者一個字沒改）→ 原物件原樣送回，不新增
 *   loc 鍵——否則會把 fallback 顯示的字（多半是 zh-Hant）抄進新語系鍵；其餘
 *   一律 { ...orig, [loc]: value }（其他語系原封不動，backend 存的是整份物件、
 *   不會被單語覆寫成字串）。 */
function mergeLabel(orig, value, loc, shown) {
  if (!orig || typeof orig !== "object" || Array.isArray(orig)) return value;
  const had = typeof orig[loc] === "string" && orig[loc] !== "";
  if (!had && value === shown) return orig;
  return { ...orig, [loc]: value };
}

// 退場淡出總時長：對齊 layout.css `.cg-img` 的 1s opacity transition，多留
// 0.1s buffer 保證 transition 播完才收層（reduced-motion 時 transition:none
// ＝畫面立即全透明，timer 只是晚一點收層、無感）。
const CG_HIDE_FADE_MS = 1100;

export class CgPresenter {
  constructor({ endpointBase, listEl, renderLine }) {
    this._base = endpointBase;
    this._listEl = listEl;         // 場景行落點（#msgs）
    this._renderLine = renderLine; // (name) => void——app.js 以 renderFrame 實作
    this.items = [];
    this._layer = document.getElementById("cg-layer");
    this._imgs = this._layer
      ? [this._layer.querySelector(".cg-img-a"), this._layer.querySelector(".cg-img-b")]
      : [];
    this._front = 0;
    this._currentId = null;   // 目前顯示中的 CG id（null＝未顯示）
    this._lastLineId = null;  // 場景行去重（同景不重複出）
    this._lastState = null;   // 最後一次 applyState 收到的快照（reapplyLast 用，見下）
    this._hideTimer = null;   // 退場淡出的收層 timer（淡出中重新進場要取消它）
    this._showGen = 0;        // _show() pending rAF 的作廢代數（見 _show/_hide 註解）
  }

  /** 相冊載入。true＝功能可用（flag ON；空相冊也算可用——要能進面板上傳）。 */
  async init() {
    try {
      const res = await fetch(`${this._base}/album`, { credentials: "same-origin" });
      if (!res.ok) return false;   // 404＝flag OFF＝功能休眠（sandbox 慣例）
      const data = await res.json();
      this.items = Array.isArray(data.items) ? data.items : [];
      return true;
    } catch (e) {
      return false;                // 斷網＝安靜休眠（loadCurrentModel 慣例）
    }
  }

  fileUrl(id) { return `${this._base}/file/${encodeURIComponent(id)}`; }

  // 雙軌制（backend 契約）：items 每張帶 target "desktop"|"mobile"（舊
  // 單張 mobile bool 鍵退役）。_itemOf 保持全組查——scene 是單一共用狀態，
  // 可能指向任一組的張，屬不屬於本機組由 applyState 判。
  _itemOf(id) { return this.items.find((it) => it.id === id) || null; }
  _groupOf(target) { return this.items.filter((it) => it.target === target); }
  /** 組內開場景：組內 opening 優先 → 組內第一張 → null（組空）。 */
  _openingOf(target) {
    const group = this._groupOf(target);
    return group.find((it) => it.opening) || group[0] || null;
  }

  isActive() { return this._currentId !== null; }

  /** 渲染規則唯一判準（雙軌制）。scene 指向已刪＝視同 null；本組空
   * ＝維持房間。 */
  applyState({ intimate, scene }) {
    // 快取快照（無條件、任何 early return 之前）——reapplyLast() 用：album
    // fetch 與 WS 首次 cg_state push 有 race（app.js initCg() 沒 await，見該檔
    // 註解），push 若搶先抵達、this.items 當下還是空的，這裡先把「當時收到的
    // 狀態」記下來，等 album 補到後 initCg() 呼叫 reapplyLast() 用同一份狀態
    // 重跑一次判斷，把 F5 還原補齊。
    this._lastState = { intimate: !!intimate, scene: scene || null };
    if (!this._layer) return;
    if (!intimate) { this._hide(); return; }
    // 雙軌渲染（桌機組／手機組對稱同一條規則）：scene 命中的張**屬本機組**才
    // 用它（在本裝置點本組卡的情境）；scene 指向對方組／查無＝fallback 本組
    // 開場景（cg_state 是雙組共用的單一 scene——對方組的 scene 對本機畫面沒有
    // 意義，硬顯示會跨組穿幫）；本組空＝維持房間（graceful 照舊——舊「手機沒
    // 標固定張＝隱藏」的單張 flag 制一併退役）。
    const isMobile = typeof window.matchMedia === "function"
      && window.matchMedia(MOBILE_MQ).matches;
    const want = isMobile ? "mobile" : "desktop";
    const sceneItem = scene ? this._itemOf(scene) : null;
    const target = (sceneItem && sceneItem.target === want)
      ? sceneItem
      : this._openingOf(want);
    if (!target) { this._hide(); return; }
    this._show(target);
    // 場景行：依「顯示中的張」變化才出行（進場含開場景）——桌機組／手機組
    // 同一條去重規則（Chat Log 一致性）。
    if (this._lastLineId !== target.id) {
      this._lastLineId = target.id;
      try { this._renderLine(pickLabel(target.name)); } catch (e) { /* 顯示旁枝不絆聊天 */ }
    }
  }

  /** album fetch 補到之後重放最後一次收到的狀態（race hardening，見 applyState
   * 開頭註解）——app.js initCg() 在 cg.init() 成功後呼叫。從未收過 cg_state
   * （_lastState 仍是建構時的 null）＝安靜 no-op，不動層、不拋錯。這裡直接
   * 把同一份物件再送進 applyState 一次：_lastState 會被原值原封重新賦值，
   * 不需要另外防遞迴。 */
  reapplyLast() {
    if (this._lastState) this.applyState(this._lastState);
  }

  _show(item) {
    // 淡出進行中又開門／換景＝先取消收層 timer，否則 timer 燒完會把剛顯示的
    // 新圖整層藏掉（hidden=true 一刀切）。
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    if (this._currentId === item.id) return;
    const back = 1 - this._front;
    const backEl = this._imgs[back];
    const frontEl = this._imgs[this._front];
    if (!backEl || !frontEl) return;
    backEl.style.backgroundImage = `url("${this.fileUrl(item.id)}")`;
    this._layer.hidden = false;
    document.body.classList.add("cg-active");
    // 下一 frame 再翻 opacity＝讓 transition 生效（雙 rAF 慣例）。gen guard：
    // rAF 落地前若 _hide()（或下一次 _show()）已發生，這筆翻頁作廢——舊制
    // hidden 同 tick 收層看不見這個 race，退場改淡出後（hidden 延遲 1.1s）
    // pending rAF 會把 is-shown 加回去＝淡出中圖又亮回來，必須擋。
    const gen = ++this._showGen;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (gen !== this._showGen) return;
      backEl.classList.add("is-shown");
      frontEl.classList.remove("is-shown");
    }));
    this._front = back;
    this._currentId = item.id;
  }

  _hide() {
    if (this._layer.hidden && this._currentId === null) return;
    this._showGen++;           // 作廢 pending 的 _show() rAF 翻頁（見 _show 註解）
    this._imgs.forEach((el) => el && el.classList.remove("is-shown"));
    document.body.classList.remove("cg-active");
    this._currentId = null;
    this._lastLineId = null;   // 下一場 intimate 重新出場景行
    // 退場淡出（結束 intimate 狀態要淡出，體驗才舒服——取代原
    // hard cut）：拿掉 is-shown 的當下 1s opacity transition 開始播，這段期間
    // 層必須留著（hidden 維持 false）淡出才看得見；房間背景在下層（z=0）
    // 同步透出、立繪走自己的 0.25s 淡回（body.cg-active 已移除）＝整體
    // crossfade 退場。timer 燒完才真正收層；淡出中若再進場，_show() 會先
    // 取消這顆 timer。
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      this._layer.hidden = true;
    }, CG_HIDE_FADE_MS);
  }
}

// 扳手 icon（Feather tool／Lucide wrench 同款 path）——側欄第一
// 層設定鈕已經是齒輪，這顆管理鈕改扳手做語意區隔（管理＝維修工具）。靜態
// 字串、零使用者資料插值——同 chat.js REPLAY_PLAY_SVG／ROSE_SVG 既有的
// 「innerHTML 僅限寫死 icon 常數」慣例（adv.js 禁的是動態內容走 innerHTML，
// 不是這種零插值的靜態圖示）。
const CG_MANAGE_WRENCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>' +
  '</svg>';

// 管理態返回鈕：Feather chevron-left——「<」＝回上一層（相冊
// 集錦視圖態），不是關面板（面板本身不設「關閉」叉叉；點暗幕關
// 面板照舊）。同上零插值靜態 icon 慣例。
const CG_BACK_CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="15 18 9 12 15 6"></polyline>' +
  '</svg>';

/**
 * buildCgPanel —— CG 相冊彈窗（視圖態＋管理態）。
 * 視圖態：卡片式相冊，縮圖＋場景名，點卡＝`send("/cg " + id)`＋立即收合面板
 * （他要開演了，不留舊面板擋畫面）。殼沿用 `.settings-panel` 暗幕慣例（外觀／
 * 設定面板同款：點暗幕關、不設關閉叉叉，見 app.js 外觀面板同一
 * 段落）。
 *
 * 誠實關面板：`send()` 回傳布林（同 `ChatClient.send()`
 * 的既有契約——WS 未開時同步回 `false`，見 chat.js）。只有真的送出去才關
 * 面板；WS 斷線／重連中點卡＝送不出去，面板留著＋面板內顯示一句誠實提示，
 * 不能讓使用者以為場景已經在換了（同 app.js 文字送出／傳照片送出
 * 的既有誠實模式：`if (!sent) { ... }` 不裝作送到了）。
 *
 * 管理態（雙軌制）：sheet 右上扳手（`.cg-manage-btn`，
 * 從齒輪換的）進管理態；管理態中扳手隱藏、heading 左側改出「<」返回鈕
 * （`.cg-back-btn`＝exitManage，單一返回語意，不留兩顆做同件事的鈕）——兩顆都
 * 不是關閉鈕（面板本身不設「關閉」叉叉；點暗幕關面板照舊）。
 * `endpointBase` 沒給（或空字串）＝管理功能不可用＝整個 `.cg-sheet-head`（含
 * 扳手與返回鈕）不建立，視圖態行為與呼叫介面一字不動（舊呼叫端不補這
 * 個參數照樣能跑）。desc 只在管理態才會出現在 DOM——`presenter.items`
 * （`/album` 通道）從來不含 desc 欄位（見 CgPresenter 檔頭），管理態的資料另外
 * 走 `${endpointBase}/manage`（唯一含 desc 的通道）；`open()`／`exitManage()`
 * 都會把整個內容容器（`stage`）清空重建，結構上保證離開管理態後不會殘留任何
 * desc 節點。
 *
 * 雙軌制：視圖態只列**當前裝置組**（桌機視圖＝desktop 組、手機視圖＝
 * mobile 組）——跨裝置點對方組的卡＝scene 指向對方組＝本機畫面 fallback 開場景
 * （行為怪），per-device filter 天然正確；跨組瀏覽與管理走管理態 TAB
 * （桌機｜手機，預設桌機、每次 enterManage 重設）。上傳歸屬當前 TAB 組
 * （form 帶 `target`）；「手機張」flag 鈕已拆除（`set_mobile` op 退役，送了
 * backend 回 400）；「開場景」照舊——backend 對 set_opening 做同 target 組內
 * radio。
 *
 * 每個變更動作（編輯／刪除／排序／開場景／上傳）一律「先 POST、成功
 * 才重新 fetch `/manage` 並重繪」——server 是唯一真相，不做樂觀 UI；失敗＝
 * 本地狀態原封不動＋面板內誠實提示（沿用視圖態既有的 `.cg-send-hint` 元件與
 * 2.5s 自動清除時序，管理態不另立第二套提示機制）。
 *
 * @param {HTMLElement} root - 面板宿主（index.html 的 #cg-root）。
 * @param {{items: Array, fileUrl: (id:string)=>string, _currentId: string|null,
 *          init: () => Promise<boolean>}} presenter
 * @param {{send: (text:string)=>boolean, endpointBase?: string}} opts -
 *   `send` 同視圖態既有契約；`endpointBase` 給了管理端點的根路徑（如
 *   "/api/v4/cg"）才會出現管理入口。
 * @returns {{el: HTMLElement, open: () => void,
 *            enterManage: () => Promise<void>, exitManage: () => Promise<void>}}
 */
export function buildCgPanel(root, presenter, { send, endpointBase }) {
  const hasManage = !!endpointBase;

  const el = document.createElement("div");
  el.className = "settings-panel cg-panel";
  el.hidden = true;
  // 點暗幕（sheet 外）＝關閉，同設定／外觀面板慣例；只認 e.target === el——
  // 點到 sheet 內任何元素 target 都不是 el，不誤關。管理態中點暗幕直接關掉
  // 整個面板也合理（同設定面板既有行為）——下次 open() 一律強制回視圖態
  // （見 open() 內 `mode = "view"`），不會把管理態殘留狀態帶進下一次開啟。
  el.addEventListener("click", (e) => {
    if (e.target === el) el.hidden = true;
  });

  const sheet = document.createElement("div");
  sheet.className = "cg-sheet";
  el.appendChild(sheet);

  const heading = document.createElement("h2");
  heading.className = "settings-heading";
  tEl(heading, "cg.title");

  // byte-identical 保證——endpointBase 沒給時
  // 完全不建立 `.cg-sheet-head` 這層包裹，heading 直接進 sheet，DOM 結構跟
  // computed style 都跟舊版一模一樣。原本的 bug：這層包裹不論 hasManage
  // 都會建立，而 layout.css 的 `.cg-sheet-head .settings-heading{margin:0}`
  // 會蓋掉 `.settings-heading` 原本 `margin:0 0 0.25rem` 的下間距——即使扳手
  // 本身 hidden，heading 間距已經悄悄變了，不是「多包一層無害」。管理功能真
  // 的存在（hasManage）才多包一層＋放扳手；`manageBtn` 留 `null` 讓下面
  // renderView／renderManage 知道要不要碰它。
  let manageBtn = null;
  let backBtn = null;
  let switching = false; // 換態進行中不收第二單
  // （enterManage/exitManage 都是 async——同 app.js 外觀面板既有的 switching
  // 慣例，防連點兩下賽出兩個併發 fetch）。
  if (hasManage) {
    const head = document.createElement("div");
    head.className = "cg-sheet-head";
    sheet.appendChild(head);

    // 「<」返回鈕：heading 左側、只在管理態現身（renderManage
    // 翻開 hidden）＝hasManage=false 時整個 head 不存在的 byte-identical 保證
    // 天然不受影響。走同一顆 switching 防重入（back 也是 async exitManage）。
    backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "cg-back-btn";
    backBtn.hidden = true;
    tAttr(backBtn, "aria-label", "cg.back");
    backBtn.innerHTML = CG_BACK_CHEVRON_SVG;
    head.appendChild(backBtn);
    backBtn.addEventListener("click", async () => {
      if (switching) return;
      switching = true;
      try { await exitManage(); } finally { switching = false; }
    });

    head.appendChild(heading);

    manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "cg-manage-btn";
    tAttr(manageBtn, "aria-label", "cg.manage");
    manageBtn.innerHTML = CG_MANAGE_WRENCH_SVG;
    head.appendChild(manageBtn);

    manageBtn.addEventListener("click", async () => {
      if (switching) return;
      switching = true;
      try {
        if (mode === "manage") { await exitManage(); } else { await enterManage(); }
      } finally {
        switching = false;
      }
    });
  } else {
    sheet.appendChild(heading);
  }

  // 內容容器：view／manage 兩態共用同一個掛點，每次切換整個清空重建（不是
  // 兩個容器切 hidden）——這是「離開管理態後 desc 節點保證不殘留」的結構性
  // 理由，不是靠自律記得清，是物理上沒有別的節點可以殘留。
  const stage = document.createElement("div");
  stage.className = "cg-stage";
  sheet.appendChild(stage);

  // 送出失敗的誠實提示（管理態各動作共用同一顆，
  // 不另立第二套）：獨立於 stage 之外的固定元素——重繪 stage 時不會被一起
  // 清掉，也不需要每次 open() 重建。空字串時 `:empty` 天然收合零高度（同
  // .photo-status 既有 idiom）。
  const hint = document.createElement("p");
  hint.className = "cg-send-hint";
  hint.setAttribute("aria-live", "polite");
  sheet.appendChild(hint);

  let hintTimer = null;
  function clearHint() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hint.textContent = "";
  }
  /** ~2.5s 後自動清，或使用者下一次操作時立即清（見各 click handler 開頭）。 */
  function showHint(text) {
    if (hintTimer) clearTimeout(hintTimer);
    hint.textContent = text;
    hintTimer = setTimeout(() => {
      hint.textContent = "";
      hintTimer = null;
    }, 2500);
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  let mode = "view";          // "view" | "manage"
  let manageItems = [];       // 只在 manage 態有值；離開即清空（見 exitManage）
  let manageTab = "desktop";  // 管理態 TAB（"desktop"|"mobile"）；每次 enterManage
  // 重設回「桌機」——TAB 是面板 transient 狀態，不跨開合殘留（同 mode 慣例）。

  // ── 刪除就地二段確認（house「就地確認」慣例）：同一時間最多一顆武裝中，
  // 武裝逾時／點別的地方都會解除，不留鬼武裝態跨 render 殘留。 ──────────────
  let armedDeleteBtn = null;
  let armedTimer = null;
  function disarmDelete() {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    if (armedDeleteBtn) {
      armedDeleteBtn.classList.remove("is-armed");
      tEl(armedDeleteBtn, "cg.delete");
      armedDeleteBtn = null;
    }
  }
  function armDelete(btn) {
    disarmDelete(); // 同時只有一顆武裝——武裝別顆前先解除這顆
    btn.classList.add("is-armed");
    tEl(btn, "cg.confirmDelete");
    armedDeleteBtn = btn;
    armedTimer = setTimeout(disarmDelete, 4000);
  }
  // 點武裝鈕以外任何地方＝解除武裝（house 慣例）。武裝鈕自己的 click handler
  // 走 bubble 到這裡時 armedDeleteBtn 早被那顆自己的 handler 處理掉了（見下方
  // buildManageCard 的刪除鈕邏輯），不會誤判成「點別處」。
  document.addEventListener("click", (e) => {
    if (armedDeleteBtn && e.target !== armedDeleteBtn) disarmDelete();
  });

  /** 每次 open() 呼叫——項目與 active 標記都以 presenter 當下值重繪，不留舊快照。 */
  function renderView() {
    if (manageBtn) {
      manageBtn.classList.remove("is-active"); // hasManage=false 時無此鈕
      manageBtn.hidden = false;                // 回視圖態扳手復現
    }
    if (backBtn) backBtn.hidden = true;        // 「<」只在管理態現身
    tEl(heading, "cg.title");
    clearChildren(stage);
    const grid = document.createElement("div");
    grid.className = "cg-grid";
    // 視圖態只列**當前裝置組**（雙軌制）：跨裝置點對方組的卡＝scene 指向
    // 對方組＝本機畫面 fallback 開場景（applyState 雙軌規則）＝點了沒反應的怪
    // 行為——per-device filter 天然正確；跨組瀏覽與管理走管理態 TAB。
    const isMobile = typeof window.matchMedia === "function"
      && window.matchMedia(MOBILE_MQ).matches;
    const want = isMobile ? "mobile" : "desktop";
    const items = (Array.isArray(presenter.items) ? presenter.items : [])
      .filter((it) => it.target === want);
    items.forEach((item) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "cg-card";
      card.classList.toggle("is-active", item.id === presenter._currentId);

      const thumb = document.createElement("span");
      thumb.className = "cg-thumb";
      thumb.style.backgroundImage = `url("${presenter.fileUrl(item.id)}")`;
      card.appendChild(thumb);

      const name = document.createElement("span");
      name.className = "cg-card-name";
      name.textContent = pickLabel(item.name); // 字串原樣；多語物件依當前語系挑
      card.appendChild(name);

      // 點卡＝送場景指令；只有真的送出去才關面板（他要開演了，面板不該擋
      // 畫面）——WS 斷線／重連中送不出去＝面板留著＋誠實提示，不騙使用者已經
      // 換場（同 app.js 文字／照片送出的既有 `if (!sent)` 模式）。
      card.addEventListener("click", () => {
        clearHint(); // 新點擊先清舊提示，不留疊字
        const sent = send("/cg " + item.id);
        if (sent) {
          el.hidden = true;
        } else {
          showHint(t("cg.connecting"));
        }
      });

      grid.appendChild(card);
    });
    stage.appendChild(grid);
  }

  /** GET `${endpointBase}/manage`——`/manage` 是唯一含 desc 的通道。 */
  async function fetchManageItems() {
    const res = await fetch(`${endpointBase}/manage`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  /** POST `${endpointBase}/manage`；網路例外也吞成 null（呼叫端統一走失敗分支）。 */
  async function postManage(body) {
    try {
      return await fetch(`${endpointBase}/manage`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return null;
    }
  }

  /** 重新 fetch 管理清單＋重繪——reorder／edit／delete／set_opening
   * 成功後共用同一條路，永遠以 server 回傳的清單為準，不本地拼湊。 */
  async function refreshManage() {
    manageItems = await fetchManageItems();
    renderManage();
  }

  /** 編輯／刪除／排序／標記共用的執行器：先清舊提示、POST、成功才重新整團刷新，
   * 失敗＝本地狀態不動＋誠實提示（no optimistic UI）。
   *
   * 按鈕回饋：server-confirm 兩趟往返（POST＋GET）期間按鈕零回饋，部署遠端時
   * 看起來像按了沒反應。觸發鈕 disabled＋.is-busy＋aria-busy 直到操作結束——
   * 資料流不動（不做樂觀 UI）。成功路徑 refreshManage 整團重繪＝觸發鈕節點
   * 被丟棄，天然復原；失敗路徑節點還在，手動復原。opBusy 單飛：一次一單，
   * busy 中點其他操作鈕直接忽略——防兩單併發賽出交錯的 refreshManage（跟
   * enterManage/exitManage 的 switching 同款防重入慣例，分開兩顆 flag 是因為
   * 生命週期不同：switching 管換態、opBusy 管管理態內的單筆操作）。 */
  let opBusy = false;
  async function runManageOp(body, btn) {
    if (opBusy) return;
    opBusy = true;
    clearHint();
    if (btn) {
      btn.disabled = true;
      btn.classList.add("is-busy");
      btn.setAttribute("aria-busy", "true");
    }
    let settled = false; // true＝成功且畫面已重繪（按鈕節點已是新的）
    try {
      const res = await postManage(body);
      if (res && res.ok) {
        await refreshManage(); // 這行 throw（POST 成功、GET 失敗）走 catch 復原
        settled = true;
      } else {
        showHint(t("cg.opFailed"));
      }
    } catch (e) {
      // 操作其實已成功、只是清單沒抓回來——訊息照實講，不謊報「沒成功」。
      showHint(t("cg.opStale"));
    } finally {
      opBusy = false;
      if (!settled && btn) {
        btn.disabled = false;
        btn.classList.remove("is-busy");
        btn.removeAttribute("aria-busy");
      }
    }
  }

  function buildManageCard(item) {
    // 語系以卡片建構當下為準：預填值（shownName／shownDesc）跟儲存時寫入的鍵是同
    // 一個語系——管理態中切語系不重繪（見 onLocaleChange 訂閱），輸入框裡仍是建構
    // 當下語系的字，儲存就該寫回那個語系，不能改用儲存瞬間的 getLocale()。
    const loc = getLocale();
    const shownName = pickLabel(item.name);
    const shownDesc = pickLabel(item.desc);
    const label = shownName; // ↑↓／儲存／刪除／開場景 aria-label 用：當前語系的名字
    const card = document.createElement("div");
    card.className = "cg-manage-card";

    // 排序欄（↑↓ 移到每列最前面＝「抓著整列上下移」的直覺；
    // 原本混在右側動作欄裡、跟儲存/刪除擠一起沒有調順序的感覺）
    const reorder = document.createElement("div");
    reorder.className = "cg-manage-reorder";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "cg-manage-up";
    upBtn.textContent = "↑";
    upBtn.setAttribute("aria-label", t("cg.moveUp", { name: label }));
    upBtn.addEventListener("click", () => {
      runManageOp({ op: "reorder", id: item.id, direction: "up" }, upBtn);
    });
    reorder.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "cg-manage-down";
    downBtn.textContent = "↓";
    downBtn.setAttribute("aria-label", t("cg.moveDown", { name: label }));
    downBtn.addEventListener("click", () => {
      runManageOp({ op: "reorder", id: item.id, direction: "down" }, downBtn);
    });
    reorder.appendChild(downBtn);

    card.appendChild(reorder);

    const thumb = document.createElement("span");
    thumb.className = "cg-thumb cg-manage-thumb";
    thumb.style.backgroundImage = `url("${presenter.fileUrl(item.id)}")`;
    card.appendChild(thumb);

    const fields = document.createElement("div");
    fields.className = "cg-manage-fields";

    // 輸入框預填當前語系那格（多語物件）或原字串；儲存時經 mergeLabel 保形送回。
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cg-manage-name";
    nameInput.value = shownName;
    tAttr(nameInput, "aria-label", "cg.nameLabel");
    fields.appendChild(nameInput);

    const descInput = document.createElement("textarea");
    descInput.className = "cg-manage-desc";
    descInput.value = shownDesc;
    tAttr(descInput, "aria-label", "cg.descLabel");
    fields.appendChild(descInput);

    card.appendChild(fields);

    const actions = document.createElement("div");
    actions.className = "cg-manage-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cg-manage-save";
    tEl(saveBtn, "cg.save");
    saveBtn.setAttribute("aria-label", t("cg.saveNamed", { name: label }));
    saveBtn.addEventListener("click", () => {
      runManageOp({
        op: "edit",
        id: item.id,
        name: mergeLabel(item.name, nameInput.value, loc, shownName),
        desc: mergeLabel(item.desc, descInput.value, loc, shownDesc),
      }, saveBtn);
    });
    actions.appendChild(saveBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "cg-manage-delete";
    tEl(delBtn, "cg.delete");
    delBtn.setAttribute("aria-label", t("cg.deleteNamed", { name: label }));
    delBtn.addEventListener("click", () => {
      if (delBtn.classList.contains("is-armed")) {
        disarmDelete();
        runManageOp({ op: "delete", id: item.id }, delBtn);
      } else {
        armDelete(delBtn);
      }
    });
    actions.appendChild(delBtn);

    card.appendChild(actions);

    const flags = document.createElement("div");
    flags.className = "cg-manage-flags";

    // 「開場景」照舊送 set_opening——backend 對同 target 組內做 radio（unset
    // others 限同組），aria-label 帶組語意讓讀屏也知道 radio 範圍。「手機張」
    // flag 鈕已拆除（雙軌制：set_mobile op 退役、送了 backend 回 400——
    // 手機顯示哪張改由 mobile 組自己的 opening 決定）。
    const groupLabel = item.target === "mobile" ? t("cg.groupMobile") : t("cg.groupDesktop");
    const openingBtn = document.createElement("button");
    openingBtn.type = "button";
    openingBtn.className = "cg-flag-btn cg-flag-opening";
    tEl(openingBtn, "cg.opening");
    openingBtn.setAttribute("aria-pressed", item.opening ? "true" : "false");
    openingBtn.setAttribute("aria-label", t("cg.setOpening", { name: label, group: groupLabel }));
    openingBtn.addEventListener("click", () => {
      runManageOp({ op: "set_opening", id: item.id }, openingBtn);
    });
    flags.appendChild(openingBtn);

    card.appendChild(flags);
    return card;
  }

  function buildUploadRow() {
    const row = document.createElement("div");
    row.className = "cg-manage-upload";

    // 上傳歸屬小字（雙軌制）：上傳列跟著當前 TAB 走——在哪組上傳就進
    // 哪組，這行把歸屬講明白，不讓使用者猜。renderManage 每次切 TAB 整團重繪＝
    // 這行文字天然跟著 manageTab 更新。
    const targetNote = document.createElement("span");
    targetNote.className = "cg-manage-upload-target";
    targetNote.textContent = t("cg.uploadTo", {
      group: t(manageTab === "mobile" ? "cg.groupMobile" : "cg.groupDesktop"),
    });
    row.appendChild(targetNote);

    // 自刻選檔鈕（原生「選擇檔案」系統鈕吃不到主題 CSS＝醜、要跟
    // token 變色——自刻下拉鐵則的同族延伸：任何原生控件殼一律自刻）。
    // <label> 隱式關聯＝點擊原生轉發開檔案選擇器（同設定開關的做法：不做 JS
    // click() 合成轉發）；原生 input 收在 label 內、視覺上 sr-only 藏住但**不用
    // display:none**（那會踢出 tab 序＝鍵盤選不了檔），focus ring 由 label 的
    // :focus-within 代顯。選中檔名顯示在旁邊的 span（原生鈕的「未選擇任何檔案」
    // 資訊不丟失），上傳成功後 refreshManage 整列重建＝天然歸零。
    const pickWrap = document.createElement("label");
    pickWrap.className = "cg-manage-upload-pick";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp";
    fileInput.className = "cg-manage-upload-file";
    tAttr(fileInput, "aria-label", "cg.chooseImage");
    const pickText = document.createElement("span");
    pickText.className = "cg-manage-upload-pick-text";
    tEl(pickText, "cg.chooseFile");
    pickWrap.appendChild(fileInput);
    pickWrap.appendChild(pickText);
    row.appendChild(pickWrap);
    const pickName = document.createElement("span");
    pickName.className = "cg-manage-upload-pick-name";
    tEl(pickName, "cg.noFile");
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      // 顯示真檔名（非譯文）要連 dataset.i18n 一併清掉，否則下次 applyDom() 重譯
      // 會把已經換上的真檔名蓋回「（未選擇）」（同 app.js markActive 既有慣例）。
      if (f) { pickName.textContent = f.name; delete pickName.dataset.i18n; }
      else tEl(pickName, "cg.noFile");
    });
    row.appendChild(pickName);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "cg-manage-upload-name";
    tAttr(nameInput, "placeholder", "cg.uploadNamePlaceholder");
    tAttr(nameInput, "aria-label", "cg.uploadNameLabel");
    row.appendChild(nameInput);

    const descInput = document.createElement("textarea");
    descInput.className = "cg-manage-upload-desc";
    tAttr(descInput, "placeholder", "cg.uploadDescPlaceholder");
    tAttr(descInput, "aria-label", "cg.uploadDescLabel");
    row.appendChild(descInput);

    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "cg-manage-upload-btn";
    tEl(uploadBtn, "cg.upload");
    uploadBtn.addEventListener("click", async () => {
      clearHint();
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showHint(t("cg.pickFirst"));
        return;
      }
      // 按鈕回饋＋單飛（同 runManageOp）：上傳是管理態最慢的一單，最需要
      // 「它在忙」的訊號；共用同一顆 opBusy＝上傳中點排序（或反過來）一律
      // 忽略，不賽。
      if (opBusy) return;
      opBusy = true;
      uploadBtn.disabled = true;
      uploadBtn.classList.add("is-busy");
      uploadBtn.setAttribute("aria-busy", "true");
      let settled = false; // true＝成功且整列已重建（上傳鈕節點已是新的）
      const fd = new FormData();
      fd.append("file", file, file.name || "cg.png");
      fd.append("name", nameInput.value);
      fd.append("desc", descInput.value);
      // 雙軌制：上傳自動帶當前 TAB 的組別——backend 契約 target 可省
      //（預設 desktop），但明送讓歸屬顯式、不吃預設值的巧合。
      fd.append("target", manageTab);
      try {
        let res;
        try {
          res = await fetch(`${endpointBase}/upload`, {
            method: "POST",
            credentials: "same-origin",
            body: fd,
          });
        } catch (e) {
          showHint(t("cg.uploadFailed"));
          return;
        }
        if (res.ok) {
          try {
            await refreshManage(); // 重繪會連帶重建這個上傳列＝欄位天然清空
            settled = true;
          } catch (e) {
            // 上傳其實已成功、清單沒抓回來——照實講（同 runManageOp）。
            showHint(t("cg.uploadStale"));
          }
        } else if (res.status === 400) {
          showHint(t("cg.badType"));
        } else if (res.status === 413) {
          showHint(t("cg.tooLarge"));
        } else {
          showHint(t("cg.uploadFailed"));
        }
      } finally {
        opBusy = false;
        if (!settled) {
          uploadBtn.disabled = false;
          uploadBtn.classList.remove("is-busy");
          uploadBtn.removeAttribute("aria-busy");
        }
      }
    });
    row.appendChild(uploadBtn);

    return row;
  }

  /** 管理態分組 TAB（雙軌制）：桌機｜手機兩顆，filter＝純前端（/manage 回
   * 的是雙組整包，切 TAB 不重新 fetch）；上傳列歸屬跟著當前 TAB（見
   * buildUploadRow）。設計語言沿手機 Chat Log 頁籤（.chatlog-tab：透明底＋
   * is-active 亮字＋accent 底線），token 體系、主題跟色。 */
  function buildManageTabs() {
    const tabs = document.createElement("div");
    tabs.className = "cg-manage-tabs";
    tabs.setAttribute("role", "tablist");
    tAttr(tabs, "aria-label", "cg.groups");
    [["desktop", "cg.desktop"], ["mobile", "cg.mobile"]].forEach(([key, i18nKey]) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "cg-manage-tab";
      tEl(tab, i18nKey);
      tab.setAttribute("role", "tab");
      tab.classList.toggle("is-active", manageTab === key);
      tab.setAttribute("aria-selected", manageTab === key ? "true" : "false");
      tab.addEventListener("click", () => {
        if (manageTab === key) return;
        manageTab = key;
        renderManage();
      });
      tabs.appendChild(tab);
    });
    return tabs;
  }

  function renderManage() {
    disarmDelete(); // 整團重繪＝舊武裝鈕節點即將被丟棄，狀態一併歸零
    // renderManage() 只可能在 hasManage 為真時被呼叫（見 enterManage 的
    // `if (!hasManage) return;` 守門），manageBtn／backBtn 這裡邏輯上一定存在
    // ——仍加 null 檢查是防禦性寫法，不依賴這條隱性不變量長期成立。
    if (manageBtn) {
      manageBtn.classList.add("is-active");
      manageBtn.hidden = true; // 管理態中扳手隱藏（單一返回語意，
      // 不留兩顆做同件事的鈕）——「<」返回鈕接手唯一出口
    }
    if (backBtn) backBtn.hidden = false;
    tEl(heading, "cg.manage");
    clearChildren(stage);
    stage.appendChild(buildManageTabs());
    stage.appendChild(buildUploadRow());
    const list = document.createElement("div");
    list.className = "cg-manage-list";
    manageItems
      .filter((it) => it.target === manageTab) // 清單只列當前 TAB 組（雙軌制）
      .forEach((item) => list.appendChild(buildManageCard(item)));
    stage.appendChild(list);
  }

  /** 進管理態：fetch `/manage`（唯一含 desc 的通道）成功才切態＋重繪；失敗＝
   * 留在視圖態＋沿用 `.cg-send-hint` 誠實提示，不留半殘的管理態畫面。 */
  async function enterManage() {
    if (!hasManage) return;
    clearHint();
    try {
      manageItems = await fetchManageItems();
      manageTab = "desktop"; // 每次進管理態重設預設「桌機」（TAB 不跨次殘留）
      mode = "manage";
      renderManage();
    } catch (e) {
      showHint(t("cg.loadFailed"));
    }
  }

  /** 離開管理態：重新 fetch 相冊（`presenter.init()`，含管理態間可能新增的
   * 縮圖）才回視圖態重繪——stage 整團清空重建，desc 節點物理上不會殘留。 */
  async function exitManage() {
    disarmDelete(); // 跟 renderManage() 同款清理
    // 對稱——武裝中離開管理態，armedTimer 不留孤兒（原本要等 4s 自己燒完，
    // 燒完時操作的按鈕節點早被 renderView() 丟棄，屬於同一類「鬼武裝態」）。
    mode = "view";
    manageItems = [];
    clearHint();
    await presenter.init();
    renderView();
  }

  // 扳手鈕的 click 接線＋switching 防重入已經在上面 `if (hasManage)` 區塊內
  // 完成（跟 manageBtn 的建立綁在一起，hasManage 為假時兩者一起不存在）。

  function open() {
    clearHint(); // 上次關面板前若留著提示，重開不該看到舊的
    mode = "view"; // 每次開面板一律回視圖態——即使上次是在管理態被點暗幕關掉
    manageItems = [];
    renderView();
    el.hidden = false;
    // 背景重抓相冊：管理態排序／刪除後點暗幕直接關（不走「<」的 exitManage）
    // 再重開，相冊會停在頁面載入時的舊快照——舊順序、已刪的還在。這裡先用
    // 手上資料即時重繪（開面板不等網路），再背景 re-fetch，落地後以 server
    // 新真相重繪一次。guard：落地時已進管理態／面板已關＝不重繪（不覆蓋
    // 管理畫面）；fetch 失敗＝init() 回 false、保持現狀（同 init 既有的安靜
    // 休眠語意，開面板不該因斷網跳錯）。
    Promise.resolve(presenter.init()).then((ok) => {
      if (ok && mode === "view" && !el.hidden) renderView();
    }).catch(() => {});
  }

  // 換語系：卡名走 pickLabel 不是 data-i18n，applyDom() 翻不到——面板可見且在
  // 視圖態時重跑 renderView() 才會換字；管理態不動（不丟使用者打到一半的字，
  // 儲存語系以卡片建構當下為準，見 buildManageCard）；隱藏中也不動（open()
  // 本就每次以當下語系重繪）。面板與 app 同壽命，不另設退訂。
  onLocaleChange(() => {
    if (!el.hidden && mode === "view") renderView();
  });

  root.appendChild(el);
  return { el, open, enterManage, exitManage };
}
