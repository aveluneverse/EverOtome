/** 色系主題系統：config.themes 驅動的介面換色——同一套框件／版式／玻璃
 * 透明度，只有顏色跟主題走。
 *
 * 設計：
 * - 預設主題（首項）＝現況零覆寫——不注入任何變數、
 *   body 無 data-theme＝chat.css/layout.css 既有 token 原樣生效（L1 天然成立）。
 * - 非預設主題＝body[data-theme=<id>]＋root 注入：
 *     底層 token（--primary／--btn-bg／--panel-bg／--text／--veil-rgb 等，
 *       chat.css :root 的角色制 token）→ ADV 框／輸入列／捲軸／選單／面板／
 *       手機列全站自動跟色（不能只換 Chat Log）
 *     --th-*（Chat Log 無皮自刻框色組；有皮時框＝per-theme 換色版框件素材）
 *   ＋ --ui-bg-room／--ui-brand-ornament／--ui-chatlog-frame 換 per-theme 素材
 *   （絕對 URL 化，同 app.js applyUiSkin 的 css/ 相對路徑解析教訓）。
 * - 泡泡色進主題（每主題配對雙方底色＋文字色＋ring 邊框）；功能色
 *   （--accept/--decline/--error）仍不進——電話語意跨主題不動。
 * - localStorage v4.theme 記使用者的選擇；重載恢復。
 * - 開源殼魂分離：config 無 themes 節＝單主題現況、零成本。
 */

const THEME_KEY = "v4.theme";

// config.themes[].vars 鍵 → CSS 變數名。分兩族：--th-*＝Chat Log 框專用、
// 其餘＝chat.css 底層 token（全站元件跟色的主幹）。
const VAR_MAP = {
  // Chat Log 框色組（無皮自刻框＋裝飾線用；也是 swatch 取色來源）
  line: "--th-line",
  lineSoft: "--th-line-soft",
  glow: "--th-glow",
  accent: "--th-accent",
  // 主行動色家族
  primary: "--primary",
  onPrimary: "--on-primary",
  primarySoft: "--primary-soft",
  hover: "--hover",
  focus: "--focus",
  // 文字階
  text: "--text",
  textDim: "--text-dim",
  textFaint: "--text-faint",
  titleInk: "--title-ink",
  // 邊框／面層
  lineFaint: "--line-2",
  surface2: "--surface-2",
  panelBg: "--panel-bg",
  panelLine: "--panel-line",
  glassBg: "--glass-bg",
  veilRgb: "--veil-rgb",
  glowRgb: "--glow-rgb",
  scrollThumb: "--scroll-thumb",
  // 按鈕系統
  btnBg: "--btn-bg",
  btnBgHover: "--btn-bg-hover",
  btnInk: "--btn-ink",
  // 訊息泡泡（乙女聊天泡泡色票：每主題配對雙方底色＋文字色＋ring
  // 邊框；主題未給這些鍵＝沿用底色系統既有色號、無框）
  bubbleSent: "--bubble-sent",
  onBubbleSent: "--on-bubble-sent",
  bubbleSentRing: "--bubble-sent-ring",
  bubbleReply: "--bubble-reply",
  onBubbleReply: "--on-bubble-reply",
  bubbleReplyRing: "--bubble-reply-ring",
  // 手機版實色列
  mBarBg: "--m-bar-bg",
  mFieldBg: "--m-field-bg",
  mDockBg: "--m-dock-bg",
};

// 別名（一鍵多寫）：同值角色跟著主鍵走，config 不用重複給
const ALIAS_MAP = {
  hover: ["--status-accent"],
  primarySoft: ["--sub-accent"],
};

// per-theme 素材鍵 → CSS 變數（值＝url(...)；baseline 於 init 時快照還原用）
const ASSET_MAP = {
  bgRoom: "--ui-bg-room",
  compass: "--ui-brand-ornament",
  chatlogFrame: "--ui-chatlog-frame",
};

function readSaved() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch (e) {
    return null;
  }
}

function writeSaved(id) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch (e) {
    /* 無痕模式等寫入失敗：這次選擇不記住，不炸操作 */
  }
}

/** 建主題管理器。config.themes 形狀：
 * [{ id, label, vars?: {...}, assets?: { bgRoom, compass, chatlogFrame } }, ...]
 * 首項＝預設主題（零覆寫）。uiBase＝config.ui.path（素材根，同 applyUiSkin）。 */
export function initThemes(config) {
  const themes = Array.isArray(config && config.themes)
    ? config.themes.filter((t) => t && t.id && t.label)
    : [];
  const root = document.documentElement;
  const uiPath = config && config.ui && typeof config.ui.path === "string"
    ? config.ui.path.replace(/["\\]/g, "")
    : "";

  // 預設主題還原用 baseline：init 當下 root inline style 上的素材變數值
  // （applyUiSkin 已注入完才會呼叫本函式——app.js 保證順序）。
  const baseline = {};
  for (const [key, cssVar] of Object.entries(ASSET_MAP)) {
    baseline[key] = root.style.getPropertyValue(cssVar);
  }

  const absUrl = (rel) => {
    try {
      return `url("${new URL(uiPath + rel, document.baseURI).href}")`;
    } catch (e) {
      return `url("${uiPath + rel}")`;
    }
  };

  // 主題上報：套主題時上報後端「介面現在是哪一種燈色」——後端若要據此做情境
  // 呈現（把房間現在的樣子寫進上下文之類）就有資料源。fire-and-forget：上報
  // 失敗（斷網／端點 404＝後端 flag 未開）絕不影響換色本身。config 無
  // themeEndpoint 鍵＝整個機制不存在（開源殼零成本，同 modelEndpoint 慣例）。
  // per-device localStorage 的「最後上報者」語意：最後開頁／切色的那台裝置就
  // 是使用者此刻正在看的那一版。
  const themeEndpoint =
    config && typeof config.themeEndpoint === "string" ? config.themeEndpoint : "";
  function reportTheme(id) {
    if (!themeEndpoint || !id) return;
    try {
      fetch(themeEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: id }),
      }).catch(() => { /* 上報是加分項，安靜吞 */ });
    } catch (e) {
      /* fetch 本身炸（極舊環境）也不擋換色 */
    }
  }

  let currentId = themes.length ? themes[0].id : null;

  // 注入單一主題的 assets（首項與非首項共用）：只寫入該主題實際帶的鍵，
  // 其餘沿用 clearOverrides() 剛歸零的 baseline。body.has-theme-assets 用
  // toggle 而非只加：這顆 class 要精準反映「這次 apply 是否真的注入了
  // 素材」——換到沒有 assets（或只有部分 assets）的主題時必須真的關掉，
  // 否則 class 卡在殘留的 true、但變數已被 clearOverrides() 清空，layout.css
  // 兩條消費 selector（has-theme-assets 分支／:not(has-theme-assets) fallback）
  // 都吃不到，Chat Log 會直接開天窗（無框無底無玻璃）。見 layout.css「素材
  // 消費鏈」說明——開源殼無 config.ui 時 has-ui-skin 永遠不會有，這顆 class
  // 是唯一觸發 --ui-bg-room／--ui-brand-ornament／--ui-chatlog-frame 消費鏈
  // 的旗標。
  function injectAssets(assets) {
    let injected = false;
    for (const [key, cssVar] of Object.entries(ASSET_MAP)) {
      if (assets[key]) {
        root.style.setProperty(cssVar, absUrl(assets[key]));
        injected = true;
      }
    }
    document.body.classList.toggle("has-theme-assets", injected);
    return injected;
  }

  function clearOverrides() {
    for (const cssVar of Object.values(VAR_MAP)) root.style.removeProperty(cssVar);
    for (const aliases of Object.values(ALIAS_MAP)) {
      for (const cssVar of aliases) root.style.removeProperty(cssVar);
    }
    for (const [key, cssVar] of Object.entries(ASSET_MAP)) {
      if (baseline[key]) root.style.setProperty(cssVar, baseline[key]);
      else root.style.removeProperty(cssVar);
    }
    delete document.body.dataset.theme;
  }

  // shouldReport＝true（預設）：既有全部呼叫端（面板換色、開機恢復）行為零
  // 回歸——照常上報。外部指令出口（下方 applyById）需要能關掉這次上報（後端
  // 發起的換色不可回報＝防回音），故加此參數；不傳＝舊行為原樣，不必為了新
  // 需求去動既有呼叫端。
  function apply(id, shouldReport = true) {
    const theme = themes.find((t) => t.id === id) || themes[0];
    if (!theme) return null;
    if (theme === themes[0]) {
      // 首項＝預設主題：vars／data-theme 仍零覆寫（L1 天然成立）；但若首項
      // 帶 assets（如開源殼 default），素材仍要顯式注入才會顯示——零覆寫
      // 不等於零素材，兩者是獨立的兩件事。
      clearOverrides();
      injectAssets(theme.assets || {});
    } else {
      clearOverrides(); // 先歸零再鋪新主題——主題間切換不殘留上一套的變數
      document.body.dataset.theme = theme.id;
      const vars = theme.vars || {};
      for (const [key, cssVar] of Object.entries(VAR_MAP)) {
        if (typeof vars[key] === "string" && vars[key]) {
          root.style.setProperty(cssVar, vars[key]);
          const aliases = ALIAS_MAP[key];
          if (aliases) for (const a of aliases) root.style.setProperty(a, vars[key]);
        }
      }
      injectAssets(theme.assets || {});
    }
    currentId = theme.id;
    writeSaved(theme.id);
    if (shouldReport) reportTheme(theme.id);
    return theme.id;
  }

  // 開機恢復（存的 id 不在清單＝回預設）。存的選擇存在＝完整 apply（含
  // writeSaved，重寫同值無害）；沒有存過＝首項是預設，但首項仍可能帶
  // assets（見上）——只補跑素材注入，不叫 writeSaved（這不是使用者的選擇，
  // 不該假造一筆「使用者選了預設主題」的紀錄）。
  //
  // 上報分兩種模式：
  // - **無 roomEndpoint（per-device 模式／預設殼）**：apply 內建上報；落預設
  //   這條路徑補報一次 currentId——後端的「最後上報者」才會是此刻真正看著的
  //   燈色（否則桌機報過 A 色、手機開預設 B 色卻沒聲音＝後端說錯色）。
  // - **有 roomEndpoint（全域房間模式）**：上面那套「最後上報者」語意不成
  //   立——全域現值只有一份，開機補報只會把這台裝置的 stale localStorage 蓋
  //   掉別台剛換好的全域值（隨後 app.js 的房間 GET 回讀因為「已經是自己剛蓋
  //   的舊值」冪等跳過、舊值就此定案）。故此模式下開機恢復零上報
  //   （`apply(saved, false)`）、首開也不補報，全域現值同步一律交給 app.js 的
  //   房間 GET 回讀。面板點卡路徑（`apply(id)` 單參數呼叫）不受影響，照舊上
  //   報——這條只動開機這兩個呼叫點。
  const saved = readSaved();
  const roomMode = !!(config && config.roomEndpoint);
  if (saved && themes.some((t) => t.id === saved)) {
    apply(saved, !roomMode);
  } else if (themes.length) {
    injectAssets(themes[0].assets || {});
    if (!roomMode) reportTheme(currentId);
  }

  return {
    list: themes,
    get current() {
      return currentId;
    },
    apply,

    // 外部指令出口：room_state frame handler 用這組套後端推來的主題值。
    // applyById 走既有 apply(id)＋writeSaved(id)——預設（不傳 opts 或
    // opts.report 不為 true）不回報 themeEndpoint，只有 opts.report === true
    // （使用者經既有 UI 換色的路徑）才報，防回音。
    applyById(id, opts) {
      const t = themes.find((x) => x.id === id);
      if (!t) return false;
      const shouldReport = !!(opts && opts.report === true);
      apply(t.id, shouldReport);
      writeSaved(t.id);
      return true;
    },
    // 目前顯示的主題 id：localStorage 已記的值優先（apply 恆同步寫入），
    // 從未套用過（剛 init、無 saved）時 fallback 首主題 id。
    // ⚠️ localStorage 跨分頁共用＝這支回的不是「這個分頁畫面上的主題」——要判
    // 斷「這個分頁現在顯示什麼」請用上面的 `current` getter（app.js 的
    // room_state 冪等 guard 就是這樣用的）。本方法保留為對外 API。
    currentId() {
      return readSaved() || (themes[0] && themes[0].id) || null;
    },
  };
}
