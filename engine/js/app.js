/**
 * app.js —— 黏合層：載 config → 立繪起身 → 聊天連線 → 完整回覆到達時開口。
 *
 * 職責範圍（聊天接線＋歷史回填＋電話搬遷）：
 *   config load（fetch config.json，撈不到 fallback config.example.json）
 *   → SpritePlayer.load()+startIdle()（失敗不擋聊天，走既有 fallback 契約）
 *   → loadHistory()：fetch /api/history、依序渲染既有對話（失敗靜默降級，不擋後面）
 *   → ChatClient.connect()
 *   → 收到對方完整回覆 frame 時：(a) renderFrame 把泡泡畫上屏 (b) TtsSpeaker.speak(原文)
 *   → 首次 pointerdown（一次性）解鎖 AudioContext（iOS 手勢限制）。
 *
 * 歷史回填絕不觸發 TTS：loadHistory 這條路徑（chat.js 內）從頭到尾摸不到
 * TtsSpeaker——見 chat.js 檔頭與 loadHistory/renderHistory 的函式說明。這裡只負責
 * 「什麼時候呼叫它、餵它哪個 DOM 容器／ctx」，即載入順序上排在 sprite 之後、
 * ChatClient.connect 之前：history 先完整上屏，WS frame 只會 append 在其後。
 *
 * 「完整回覆 frame」的判準：role 為協定的
 * 回覆字面值且沒有 room 鍵——沒有 streaming 分段這種東西，回覆 frame 一到就是整句話；
 * thoughts／[react:]／[sticker:] 都只是同一個 frame 上的欄位或內嵌文字標記，不是需要
 * 另外過濾的「還沒完成」訊號。TTS 餵的是 frame.text 原文（未經 renderFrame 剝除標記的
 * 那份），標記淨化由後端的 TTS 端點在合成前自行處理——單一淨化真相，前後端規則
 * 不會漂移。
 *
 * 電話：`chat.onFrame` 在
 * `renderFrame`／TTS 分支之前，把 call 家族三個 role（`"call"`／`"incoming_call"`／
 * `"incoming_call_end"`）與「通話進行中的 `role:"system"`」整個攔給
 * `phone.handleFrame`，chat.js 本身零改動。單一聲源鐵則：`TtsSpeaker` 的
 * `getEnabled` 多掛一個 `!phone.isActive()`（撥號中／通話中／留言播放中皆真）——
 * 他不會同時用兩張嘴說話。通話回覆與留言播放全部經 `driver.attach()`，跟聊天 TTS
 * 共用同一顆 `MouthDriver`／立繪，這是「他在畫面上跟妳說話」招牌場景成立的關鍵。
 *
 * 設定頁與雙佈局：TTS 開關／立繪顯示開關／嘴型敏感度全部收斂在
 * settings.js（localStorage 讀寫的單一真相），本檔只負責在開機時讀一次當初始值、
 * 把使用者互動接到對應的 setter／即時套用。雙欄／手機背景模式的版面本身在
 * layout.css，本檔不碰版面，只切換 `body.no-sprite` 這個語意 class。傳照片
 * 沿用既有的 `chat.send()`／`renderFrame()`，不是新協定——見下方「傳照片」區塊註解。
 *
 * 幾個收尾修復（whole-branch review 後補上的）：
 *   - `tts.onDailyCap` 命中每日語音上限時，重用既有 role:"system" 渲染
 *     路徑丟一句淡化提示，不是新 DOM 機制。
 *   - `tts.prime()` 併入既有的首次 pointerdown 解鎖處理器，跟
 *     `driver.unlock()` 並列同步呼叫。
 *   - `phone.tts = tts`（建構順序關係事後補上這條連結）——撥號／接聽時
 *     phone.js 會呼叫 `tts.stop()` 收掉正在飛的聊天 TTS。
 *   - `primeReplayEl()`（chat.js）併入同一個首次 pointerdown 解鎖處理器——
 *     句尾播放鍵（存檔／合成重播共用的 `_replayEl`）從沒被手勢碰過，第一次
 *     點擊會跳出 iOS 手勢窗被無聲擋下，見 chat.js 該函式的說明。
 */
import { SpritePlayer } from "./sprite.js";
import { MouthDriver } from "./audio-mouth.js";
import { envelopeForUrl } from "./envelope.js";
import { TtsSpeaker, TtsSynthCache } from "./tts.js";
import { ChatClient, renderFrame, loadHistory, fetchLastEntryTs, postServerClearLine, fetchServerClearLine, stripMarkers, isReplaying, primeReplayEl, CallLogRenderer, markRoseFlags, appendThought, upsertPartialBubble, clearPartialBubble, showThinkingDots, renderSceneLine } from "./chat.js";
import { ConnNoteTracker } from "./conn-note.js";
import { CgPresenter, buildCgPanel } from "./cg.js";

// 清畫面持久清除線（「清了又回來」的修法；同時支援跨裝置版「一邊清、兩邊
// 都清」）：主線存 server（POST/GET /api/v4/chat-clear）＝全裝置一致；
// localStorage 是單機 fallback（flag 未開／斷網時仍有得清）。載入取線＝
// server 優先、404/失敗用 local。L1＝關 flag（退單機線）；removeItem key
// ＋刪 server 線＝歷史顯示全回來。
const CHAT_CLEAR_KEY = "v4.chatClearedAt";
const CLEAR_SYNC_URL = "/api/v4/chat-clear";
import { AdvPresenter } from "./adv.js";
import { PhoneController } from "./phone.js";
import {
  getTtsEnabled,
  getSpriteVisible,
  applySpriteVisible,
  getMouthFlapMs,
  getBlinkBaseMs,
  SettingsPanel,
} from "./settings.js";
import { PhotoUploader } from "./photo-upload.js";
import { BlushController } from "./blush.js";
import { ExpressionController } from "./expression.js";
import { FurnitureManager } from "./furniture.js";
import { confirmDialog, confirmPhotoDialog } from "./confirm.js";
import { initMouthDebug } from "./mouth-debug.js";
import { initThemes } from "./theme.js";
import { createAdvVisibility } from "./adv-visibility.js";
import { initI18n, applyConfigLocale, t, tEl, tAttr, pickLabel, onLocaleChange } from "./i18n.js";
import { bindLocaleRelabel } from "./appearance-labels.js";
import { installViewportLock } from "./viewport-lock.js";
import { initVersionChip } from "./version-chip.js";

// iOS 頁面級捏合鎖在模組層級就掛（不等 main）：頁面一被放大，視覺視口小於
// 佈局視口＝整頁可平移、fixed 底部列被推出可視區——app 式介面開機即擋。
installViewportLock();
// 首頁標題角版本列＋檢查更新：跟 config／後端連線無關（純本地版本號＋手動點擊
// 才連 GitHub），不必等 main() 的 config load，模組層級就能掛（module script
// 預設延後到 DOM 解析完才跑，#ver-chip 這時已經在樹上）。
initVersionChip();

// config.json 撈不到（開源使用者本機、或尚未疊上私有角色覆蓋層）時的最後防線：即使
// 兩份 config 都讀不到，也不能讓整頁掛掉——退回這組跟 config.example.json 同形狀的值。
const HARD_DEFAULTS = {
  characterName: "Sample",
  assetsPath: "assets/sample/",
  wsEndpoint: "/ws",
  ttsEndpoint: "/api/v4/tts",
  photoEndpoint: "/api/photo",
  photoMaxCount: 3, // 單則訊息照片上限（沿用後端常見預設；接自家後端可在 config 調）
  layout: { desktopSpriteWidth: "42%" },
};

// 連線狀態表：改成函式而非模組頂層常數字串——本檔在 initI18n() 求出語系之前就
// 被 import／求值，頂層字串會凍結在 t() 還沒接語系前的狀態（永遠是 zh-Hant 的
// fallback）。改在使用點（chat.onStatusChange）呼叫才查字典，才吃得到當下語系。
const CONN_STATUS_KEYS = {
  connecting: "conn.connecting",
  open: null, // 連線中的「無提示」態，非缺翻譯
  reconnecting: "conn.reconnecting",
  closed: "conn.closed",
  error: "conn.error",
};
function connText(status) {
  const key = CONN_STATUS_KEYS[status];
  return key ? t(key) : "";
}

/** fetch config.json；撈不到（404／網路錯／file:// 環境）→ fallback config.example.json。 */
async function loadConfig() {
  try {
    const res = await fetch("config.json");
    if (res.ok) return await res.json();
  } catch (e) {
    // 開發環境常見（file:// 或尚未部署私有角色覆蓋層）：靜默落到下面的 fallback。
  }
  try {
    const res = await fetch("config.example.json");
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn("config.example.json could not be loaded either; using built-in defaults:", e);
  }
  return HARD_DEFAULTS;
}

function wsUrlFrom(endpoint) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + endpoint;
}

// ── UI 素材皮 ────────────────────────────────────────
// config.ui.path 指向素材資料夾（部署＝skin/ui/、本機 overlay 同形狀）。
// 檔名是引擎約定的固定清單；只要 config 沒有
// ui 節（公開樹 config.example.json 就沒有），整站走 layout.css 的無皮 fallback——
// 同一套 DOM 骨架、純 CSS 深藍版。素材路徑來自 config（部署者自控），不是使用者
// 輸入，這裡拼進 CSS url() 前仍只做最保守的引號閉合防禦。
const UI_SKIN_VARS = {
  "--ui-bg-room": "bg-room.webp",
  "--ui-chatlog-frame": "chatlog-frame.svg",
  "--ui-brand-ornament": "deco-compass.webp",
  // settings-frame.webp 已退役（設定面板素色化）——素材檔留守。
  "--ui-btn-call": "btn-call.webp",
  "--ui-btn-hangup": "btn-hangup.webp",
  "--ui-btn-menu": "btn-menu.webp",
};
// adv-box／input-bar 素材退役——對話框與輸入框由引擎自刻。
// bg-room-panel（含框合成底圖）退役——桌機手機同用 bg-room（更寬廣的房間圖）
// cover 滿版；Chat Log 框改前景 SVG 素材、品牌角掛星盤徽章（deco-compass）。
// 舊 bg-room-panel.webp 檔案留在素材夾不引用（L1 回退來源）。
function applyUiSkin(config) {
  const ui = config && config.ui;
  if (!ui || typeof ui.path !== "string" || !ui.path) return;
  const base = ui.path.replace(/["\\]/g, ""); // 防禦性去引號／反斜線（見上）
  const root = document.documentElement;
  for (const [cssVar, file] of Object.entries(UI_SKIN_VARS)) {
    // 絕對 URL 化（Playwright 實測抓到的真 bug）：CSS 變數裡的相對 url() 在
    // Chromium 是「使用處」解析——var 被 css/layout.css 引用時，相對路徑會以
    // css/ 目錄為基準變成 css/skin/…（404）。以文件 URL 顯式解析後
    // 再塞進變數，兩種瀏覽器行為（定義處／使用處）都吃同一個正確絕對位址。
    const abs = new URL(base + file, document.baseURI).href;
    root.style.setProperty(cssVar, 'url("' + abs + '")');
  }
  document.body.classList.add("has-ui-skin");
}

async function main() {
  // 語系判定是第一件要做的事（先於任何 DOM 文字寫入）：initI18n() 依 URL
  // ?lang= → localStorage v4.locale → navigator.languages → en 的順序定案，
  // 並把靜態 HTML 的 data-i18n／data-i18n-attr 套一輪——之後任何模組再建 DOM
  // 時語系已經確定，不會有「先閃繁中再跳英文」的畫面。config.locale（自架者
  // 釘死）要等下面 loadConfig() 回來才知道，先用 applyConfigLocale() 補一次。
  initI18n();

  // 立繪顯示狀態是第一件要做的事：settings.js 的 applySpriteVisible 直接切
  // body.no-sprite class，越早套用越不會有「先看到立繪一瞬間才被收起」的閃爍
  // （TTS 開關讀取邏輯同樣收斂到 settings.js 的 getTtsEnabled，見下方 TtsSpeaker
  // 建構——這裡不再各自維護一份 localStorage 判斷邏輯）。
  applySpriteVisible(getSpriteVisible());

  const config = Object.assign({}, HARD_DEFAULTS, await loadConfig());
  // URL／localStorage 皆無明確語系時，config.locale（自架者釘死；"auto"／缺鍵
  // 略過）補上第三順位；explicitSource 存在時這支是 no-op（見 i18n.js）。
  applyConfigLocale(config);

  // 歷史回填端點（原本是寫死的 HISTORY_URL 常數，含私有 target 字面值）：改由
  // config 鍵 historyEndpoint 驅動——有這個鍵才拉歷史；沒有＝這組功能整個不出現
  // （同 sandboxEndpoint／modelEndpoint 既有的「config 缺鍵＝功能隱形」慣例），
  // 開場維持空白、不報錯，見下方各呼叫點的 guard。
  const historyUrl =
    typeof config.historyEndpoint === "string" && config.historyEndpoint
      ? config.historyEndpoint
      : null;

  // 情境顯示名：displayName 是「這套 skin 裡角色叫什麼」的顯示層
  // （skin 可能賦予角色不同的顯示稱呼），characterName 仍是協定／歷史帳本的真名——
  // 聊天內容與後端契約不因造型受限。「角色的名字」（ADV 名牌）用 displayName，
  // 沒設就落回 characterName。
  const displayName = config.displayName || config.characterName;
  // 分頁標題／PWA 桌面名走 pwaTitle——那是**這個介面／這個房間的名字**，跟
  // 「角色叫什麼」分家：開這個分頁＝走進那個房間，名牌上仍是角色的名字。
  // 三層落點（config 缺鍵就往下掉，殼 default 行為不變）：
  // pwaTitle → brandTitle（產品名，開箱＝EverOtome）→ displayName。
  const pwaTitle = config.pwaTitle || config.brandTitle || displayName;
  document.title = pwaTitle;
  // iOS「加入主畫面」的桌面名同源（index.html 那顆 meta，這裡走 config 動態設
  // ＝殼不硬編任何專案私名；iOS 讀 meta 在使用者按下加入的當下，JS 已跑完、
  // 動態值有效）。
  const iosTitleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (iosTitleMeta) iosTitleMeta.setAttribute("content", pwaTitle);

  // 素材皮＋品牌角（乙女介面輪）：皮的注入越早越好，避免先看到無皮版一瞬間才換裝。
  applyUiSkin(config);
  const brandTitleEl = document.getElementById("brand-title");
  if (brandTitleEl) brandTitleEl.textContent = config.brandTitle || "";

  // ── 沙盒測試模式 ──────────────────────────────────────────────
  // 暗號＝brandTitle：沙盒 ON 時固定顯示 "AI Model"（暗號＋截圖不露真模型，
  // 見下方 showModelOnBrand 的判斷順序——沙盒優先於模型名，即使切換模型這段
  // 測試也不會穿幫）。config 沒有 sandboxEndpoint 鍵＝整組沙盒 UI 不出現（開源
  // 殼零成本，同 modelEndpoint／roseEndpoint 既有慣例）；有鍵但這版後端 flag
  // 未開（GET 404）＝同樣視為功能不存在——兩道閘門缺一，MENU 忘記暫存項與
  // 設定測試模式列都不會出現。
  const sandboxState = { on: false, available: false };

  // ── 模型顯示與切換：左上角顯示當前模型名（引擎端點就緒時），
  // 端點還沒上（404／網路錯）＝安靜落回品牌字。
  // 端點契約（引擎側另案實作）：GET modelEndpoint → {"model":"opus"}；
  // POST {"model":"fable"} → 200。models 清單來自 config（部署配置，非引擎硬編）。
  const modelState = { current: null };
  function modelLabelOf(id) {
    const m = (config.models || []).find((x) => x && x.id === id);
    return m ? pickLabel(m.label) : id;
  }
  function showModelOnBrand() {
    if (!brandTitleEl) return;
    // 沙盒 ON＝暗號蓋過模型名，判斷放最前面——其餘 fallback 邏輯原樣不動。
    if (sandboxState.on) {
      brandTitleEl.textContent = "AI Model";
      return;
    }
    brandTitleEl.textContent = modelState.current
      ? modelLabelOf(modelState.current)
      : config.brandTitle || "";
  }
  async function loadCurrentModel() {
    if (!config.modelEndpoint) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let data;
      try {
        const res = await fetch(config.modelEndpoint, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) return; // 端點未就緒：保持品牌字，不吵
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      if (data && typeof data.model === "string" && data.model) {
        modelState.current = data.model;
        showModelOnBrand();
      }
    } catch (e) {
      // 端點不存在／網路錯——安靜 fallback 品牌字（設計如此，不 warn 洗版）。
    }
  }
  loadCurrentModel();

  /** 沙盒 UI 套用：body class（供 CSS 掛沙盒視覺提示用）＋MENU 忘記暫存項顯隱＋
   * 暗號重算，三件事收斂在同一個入口（同 applySpriteVisible／applyChatlogVisible
   * 既有慣例）。new（乾淨開始）在沙盒裡「翻頁清
   * production 記憶」語意不成立——沙盒
   * ON 時一併藏起來，零誤觸比留著點了才發現沒作用更誠實。 */
  function applySandboxUi() {
    document.body.classList.toggle("sandbox-on", sandboxState.on);
    document.querySelectorAll(".js-sandbox-forget").forEach((b) => {
      b.hidden = !sandboxState.on;
    });
    document.querySelectorAll('[data-cmd="new"]').forEach((b) => {
      b.hidden = sandboxState.on;
    });
    showModelOnBrand();
  }
  /** 開機探測：config 缺鍵直接不打（開源殼零成本）；GET 404／網路錯＝功能不
   * 存在，sandboxState 停在初始 false／false，UI 全程不出現。8s AbortController
   * 同 loadCurrentModel 既有的「卡住的 fetch」防線——這支的結果會擋住設定面板
   * 建構（見下方呼叫點：await 過這支才 new SettingsPanel，sandboxAvailable 是
   * 建構當下就要解出的靜態旗標，不是即時 getter，同 modelOptions 既有慣例）。 */
  async function initSandbox() {
    if (!config.sandboxEndpoint) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let data;
      try {
        const res = await fetch(config.sandboxEndpoint, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) return; // 404＝flag 未開＝功能不存在
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      sandboxState.available = true;
      sandboxState.on = !!(data && data.on);
      applySandboxUi();
    } catch (e) {
      // 斷網／逾時等：功能靜默不出現（同 loadCurrentModel 既有慣例，不 warn 洗版）。
    }
  }
  /** 切換沙盒：POST {on}。成功＝更新狀態＋套用 UI（暗號／MENU 項／body class
   * 全部跟著翻）；失敗（含逾時、非 2xx）拋錯給呼叫端——設定面板的 change
   * handler 負責把 checkbox 視覺撥回原狀，這支只管狀態與 fetch，不碰 DOM。 */
  async function setSandbox(on) {
    const res = await fetch(config.sandboxEndpoint, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    if (!res.ok) throw new Error("sandbox switch failed");
    const data = await res.json();
    sandboxState.on = !!data.on;
    applySandboxUi();
  }
  /** 忘記暫存排隊防重入（實測：forget 在 server 端排在途輪後面時零回饋，
   * 連按三發 POST）。true＝有一發在路上，MENU 再點忘記
   * 暫存＝無聲忽略；完成／失敗都在 .finally 歸零。只擋忘記暫存自己，不擋
   * 其他操作（FIFO 保動作順序，見 cmd 分派 sandbox_forget 分支註解）。 */
  let sandboxForgetPending = false;
  /** 忘記暫存：POST /forget，只管銷毀本身；沙盒維持 on（可能還想繼續測）——
   * 畫面清空＋回填是 MENU 分派那邊的事（見下方 cmd 分派 sandbox_forget 分支）。 */
  async function sandboxForget() {
    const res = await fetch(config.sandboxEndpoint + "/forget", {
      method: "POST", credentials: "same-origin",
    });
    if (!res.ok) throw new Error("forget failed");
  }

  // ── Thinking 開關（賞立繪時收起思緒卡＋省轉寫額度）────────────────────────
  // 管線整套照沙盒既有慣例：config 缺 thoughtsToggleEndpoint 鍵＝整組 UI 不
  // 出現（開源殼零成本）；GET 404＝後端 flag 未開＝功能不存在。與沙盒唯一的
  // 方向差：預設 on:true——功能不存在時思緒照現狀永遠顯示（fail-open，與後端
  // 偏好旗標同語意）。
  const thoughtsToggleState = { on: true, available: false };
  /** 套用到畫面：body.hide-thoughts（layout.css 藏桌機 ADV Thinking 鈕＋手機
   * THINKING 頁籤）；正停在 THINKING 頁時被關＝撥回 CHAT LOG（走 #tab-chat 的
   * 既有 click 邏輯，不另兜一份 tab 狀態；開機呼叫點在 tab listener 註冊之後、
   * WS frame 更晚——click 必有人接）。晚到的 thoughts frame 照存不顯示（CSS
   * 藏＝「浮現中那張安靜作廢」的邊界）。 */
  function applyThoughtsUi() {
    const visible = thoughtsToggleState.on;
    document.body.classList.toggle("hide-thoughts", !visible);
    if (!visible) {
      const chatlogEl = document.getElementById("chatlog");
      const tabChat = document.getElementById("tab-chat");
      if (chatlogEl && chatlogEl.classList.contains("show-thoughts") && tabChat) {
        tabChat.click();
      }
    }
  }
  /** 開機探測（照 initSandbox：8s AbortController、404／網路錯＝功能靜默不
   * 出現——available 停在 false、on 停在 true＝現狀顯示）。 */
  async function initThoughtsToggle() {
    if (!config.thoughtsToggleEndpoint) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let data;
      try {
        const res = await fetch(config.thoughtsToggleEndpoint, { credentials: "same-origin", signal: ctrl.signal });
        if (!res.ok) return; // 404＝flag 未開＝功能不存在
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      thoughtsToggleState.available = true;
      thoughtsToggleState.on = !(data && data.on === false);
      applyThoughtsUi();
    } catch (e) {
      // 斷網／逾時等：功能靜默不出現（同 initSandbox 既有慣例，不 warn 洗版）。
    }
  }
  /** 切換：POST {on}。成功＝更新狀態＋套用 UI；失敗拋錯給呼叫端——設定面板
   * change handler 負責把 checkbox 撥回原狀（同 setSandbox 誠實原則）。 */
  async function setThoughtsVisible(on) {
    const res = await fetch(config.thoughtsToggleEndpoint, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    if (!res.ok) throw new Error("thoughts toggle failed");
    const data = await res.json();
    thoughtsToggleState.on = !(data && data.on === false);
    applyThoughtsUi();
  }

  const nameEl = document.getElementById("char-name");
  if (nameEl) nameEl.textContent = displayName;

  const ctx = { characterName: config.characterName, assetsBase: config.assetsPath };
  // 句尾 play 鍵的宿主鉤子（chat.js 分層：那邊不 import
  // driver/tts/phone，動嘴／讓位／played 回報全在這裡接）。phone/tts/driver
  // 皆宣告在後（閉包晚綁定）——鉤子最早在點 play 時才執行，main() 早已跑完。
  ctx.replayHooks = {
    // 通話中禁重播（他正在電話裡說話）；播放前順手收掉正在唸的聊天 TTS。
    before: () => {
      if (phone.isActive()) return false;
      try { tts.stop(); } catch (e) { /* 沒在唸也無妨 */ }
      return true;
    },
    // 重溫他說話＝立繪動嘴（對齊舊留言卡 driver.attach 的招牌場景語意）。
    attach: (el) => { try { driver.attach(el); } catch (e) { /* 動嘴缺席不擋聲音 */ } },
    detach: () => { try { driver.detach(); } catch (e) { /* no-op */ } },
    // 樂譜制：重播每句把嘴型譜送進 driver（存檔 URL／合成 blob URL 都
    // 走 envelopeForUrl 快取；算不出＝null＝有機拍嘴）。
    envelope: (url) => { try { driver.setEnvelope(envelopeForUrl(url)); } catch (e) { /* 譜缺席退拍嘴 */ } },
    // 語音留言 URL 帶 ?cid=——開播時回報 played（listened 認知鏈：他知道被聽過了）。
    onUrl: (url) => {
      if (typeof url !== "string" || url.indexOf("/api/call/voicemail/audio/") === -1) return;
      const m = url.match(/[?&]cid=([^&]+)/);
      if (!m) return;
      fetch("/api/call/voicemail/played", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: decodeURIComponent(m[1]) }),
      }).catch((err) => console.warn("[app] voicemail played report failed:", err));
    },
  };

  // ── ADV 對話框（adv.js）：他「當前這句」的戲台；完整歷史仍全數進 Chat Log ──
  // onTypingChange：打字機吐字＝他在對妳講話——立繪口型跟著
  // 動（乙遊 pakupaku）。
  //
  // 空窗期閉嘴（樂譜制的收尾）：**語音開著＝嘴只跟聲音**。樂譜制讓語音口型變成
  // 真同步，打字口型在語音抵達前那幾秒的「亂拍」對比之下變得刺眼（明明是空窗
  // 期，嘴巴卻開始動）。規格：TTS 會出聲（ttsWillSpeak）＝打字期間閉嘴等聲音；
  // TTS 關／通話中／重播中＝打字口型照舊跟 Chat Log 動。
  //
  // ⚠️ 舊坑（勿重蹈）：「回訊息沒聲音嘴也要動」的由來，是舊預測制「開著語音＝
  // 打字全程閉嘴等合成」而合成失敗／額度用完時**沒有補位**，體感「嘴死了」。
  // 這次回到「開著＝等聲音」必須配 tts.onNoVoice 補位信號（見下方 TtsSpeaker
  // 組裝）：語音確定不來＝打字口型接手，嘴不會整句死掉。
  //
  // sprite／driver／phone／tts 變數宣告在本回呼之後（閉包晚綁定）——回呼最早在
  // 首個 WS frame 打字時才執行，彼時 main() 早已跑完，全部就緒。
  let advTyping = false; // 打字機正在吐字（onFlapStop 還嘴給打字機的判準）
  const adv = new AdvPresenter({
    container: document.getElementById("adv-root"),
    characterName: displayName,
    onTypingChange: (typing) => {
      advTyping = typing;
      if (!typing) {
        sprite.stopTalking();
        return;
      }
      if (driver.isFlapping()) return;   // 語音正在講：不搶嘴（原有仲裁）
      if (ttsWillSpeak()) return;        // 語音在路上＝空窗期閉嘴等聲音
      sprite.startTalking();
    },
  });

  // （手機 Chat Log 改常駐半透明直立矩形——浮層開關機制退役，
  //  桌機／手機都常駐顯示，無需任何開關邏輯。）

  // ── 立繪＋外觀（造型）系統 ─────────────────────────────────────────────
  // 外觀系統：
  // config.appearances＝造型清單 [{id, label, assetsPath}]，每套自己的
  // manifest 自報動態（9 幀差分）或 static（單張；不支援動態的造型不眨眼不動嘴——
  // sprite.js 讀 manifest 分流，這裡不分）。config 沒配清單＝單套現行為。
  // localStorage v4.appearance 記選擇（純顯示層——人格／對話／帳本零影響）。
  const APPEARANCE_KEY = "v4.appearance";
  const appearances = Array.isArray(config.appearances) && config.appearances.length
    ? config.appearances.filter((a) => a && a.id && a.assetsPath)
    // 沒配清單時合成的單套「預設」——存 i18nKey（旗標）不存翻好的字串，換語系
    // 才有東西可重查（見下方 appearanceLabelOf／relabelOutfits）；存死字串的話,
    // pickLabel() 收到純字串會原樣回傳,語系切了也不會變。
    : [{ id: "default", i18nKey: "appearance.defaultOutfit", assetsPath: config.assetsPath }];
  // 造型卡名現值：合成的「預設」套走 i18nKey（每次現查 t()）,config 供的造型走
  // label（字串或 {locale: 字串}，pickLabel 現查）——建卡與換語系重譯共用同一份
  // 邏輯，別各寫一次。
  const appearanceLabelOf = (ap) =>
    ap && typeof ap.i18nKey === "string" ? t(ap.i18nKey) : (pickLabel(ap.label) || ap.id);
  let savedAppearance = null;
  try { savedAppearance = localStorage.getItem(APPEARANCE_KEY); } catch (e) { /* 無痕等 */ }
  let currentAppearance =
    appearances.find((a) => a.id === savedAppearance) || appearances[0];

  const stageEl = document.getElementById("stage");
  const sprite = new SpritePlayer(stageEl, { assetsPath: currentAppearance.assetsPath });
  // 臉紅暈層：manifest 有 blush 鍵的造型才亮（syncFrom 自判）；觸發在 final reply
  // 的 stripMarkers（blushLevel）。示範素材無此鍵＝整族靜默、零報錯。
  const blush = new BlushController(stageEl);
  // 表情貼片層：manifest expressions 鍵宣告制（無鍵造型靜默）；bind＝跟著 sprite
  // 幀同步挑態；觸發／釋放在 final reply（exprId）。
  const expr = new ExpressionController(stageEl);
  expr.bind(sprite);
  // 家具擺放：config.furniture 驅動、localStorage 記放置選擇；config 無此節＝
  // 整族不長。錨點＝#stage-bg（層插它之後＝全畫面座標、房間背景之上、CG／
  // 立繪／UI 之下——家具可以被視窗或按鈕遮住）。面板家具 TAB 在下方外觀面板
  // 段接線。
  const furnitureMgr = new FurnitureManager(
    document.getElementById("stage-bg"), config.furniture,
  );
  try {
    await sprite.load();
    sprite.startIdle();
    blush.syncFrom(sprite.manifest, currentAppearance.assetsPath);
    expr.syncFrom(sprite.manifest, currentAppearance.assetsPath);
  } catch (e) {
    // 載入失敗不擋聊天——sprite.js 內部也有自己的降級（靜態 A 圖），
    // 這裡再包一層是防 manifest 本身就抓不到（load() 在讀到 manifest 之前就會 throw）。
    console.warn("sprite failed to load; portrait temporarily unavailable, chat unaffected:", e);
  }

  // 事件直驅制後 low/high 不再參與判定。仲裁鉤子：語音開講＝
  // 打字口型讓位（雙驅動會抖）、語音收嘴＋打字機還在跑＝口型還給打字機——
  // 兩條驅動源的互斥收斂在這裡，sprite／driver 本體互不相識。
  // 空窗期閉嘴：還嘴多一道 !tts.isPending()——句間空隙（這句播完、下一句語音
  // 還在合成／佇列）嘴繼續閉著等，不亂動（語音開著＝只跟聲音）。tts 宣告在後
  // （閉包晚綁定——onFlapStop 最早在首句語音播完才跑，彼時已就緒）。
  // 實際事件順序：audio ended → finish() → driver.detach() → _stop() → onFlapStop
  // 一路同步跑完，speak() 的 finally { _busy = false } 要等 done() resolve 之後的
  // microtask 才輪到——onFlapStop 當下 _busy 恆為 true，isPending() 在這個時點一律
  // 為真（佇列有沒有東西都不影響結果）。所以這道判斷擋下的不只「佇列還有下一
  // 句」那種句間空隙：最後一句播完而打字機還在跑時，嘴同樣還不回打字機，一路
  // 閉到打字結束（符合「語音開著＝只跟聲音」的規格）。
  const driver = new MouthDriver(sprite, {
    onFlapStart: () => sprite.stopTalking(),
    onFlapStop: () => { if (advTyping && !tts.isPending()) sprite.startTalking(); },
  });
  // 嘴型速度（自助拉桿）：開機套存的值——語音口型（driver）
  // 與打字口型（sprite）同一顆拍速；之後拖拉桿由 applyMouthSpeed 即時雙餵。
  const applyMouthSpeed = (ms) => {
    driver.setFlapMs(ms);
    sprite.setTalkInterval(ms);
  };
  applyMouthSpeed(getMouthFlapMs());
  // 眨眼頻率（拉桿）：開機套存值＋拉桿即時餵（static 造型內部 no-op 照舊）
  const applyBlinkSpeed = (baseMs) => sprite.setBlinkInterval(baseMs);
  applyBlinkSpeed(getBlinkBaseMs());
  // 首次 pointerdown 解鎖監聽器移到下面 tts 建構之後才註冊——
  // 需要在同一個處理器裡呼叫 tts.prime()，見該處註解；driver／tts 建構之間全程沒有
  // 任何 await（sprite 載入的 await 已經在更早之前跑完），移動監聽器註冊時機不影響
  // 「越早解鎖越好」的既有保證，同一個同步執行片段內註冊，使用者不可能在中途插入
  // 一次真的 pointerdown。

  // ── 聊天 ────────────────────────────────────────────────────────────────
  const msgsEl = document.getElementById("msgs");
  const statusEl = document.getElementById("chat-status");

  // 思緒摺疊列：事件委派綁一次在容器上（renderFrame 只管建 DOM，不掛監聽器）。
  // 點擊與鍵盤（Enter/Space，因 .thought 帶 role="button" tabindex="0"）都能觸發。
  function toggleThought(el) {
    const open = el.classList.toggle("open");
    el.setAttribute("aria-expanded", open ? "true" : "false");
  }
  msgsEl.addEventListener("click", (e) => {
    const t = e.target.closest(".thought");
    if (t) toggleThought(t);
  });
  msgsEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target.closest(".thought");
    if (!t) return;
    e.preventDefault();
    toggleThought(t);
  });

  // ── CG 模式：config 缺 cgEndpoint 鍵＝整組不出現（開源
  // 殼零成本）；album GET 404／斷網＝功能休眠（sandbox 慣例）。init 成功才
  // 亮側欄鈕（空相冊也亮——要能進面板上傳第一批）。宣告位置在 msgsEl／ctx
  // 都已可用之後（cg.js 自己的 module 文件說明：狀態唯一來源＝server 的
  // cg_state frame，這裡只管「什麼時候探測＋餵它哪個 DOM 容器」）。
  const cg = new CgPresenter({
    endpointBase: config.cgEndpoint || "",
    listEl: msgsEl,
    // 場景行走 chat.js renderSceneLine：內建「等待指示重掛」——
    // 場景行不再吃掉點卡／intimate 開啟後的三點與「思考中…」（根因與修法見該函式註解）。
    renderLine: (name) => renderSceneLine(msgsEl, ctx, name),
  });
  let cgAvailable = false;
  async function initCg() {
    if (!config.cgEndpoint) return;
    cgAvailable = await cg.init();
    // .js-open-cg＝桌機側欄鈕；.js-menu-cg＝手機 MENU 項（開面板
    // 走 MENU 分派 data-cmd="cg"）——兩個入口的可用性同一句管、永不漂移。
    document.querySelectorAll(".js-open-cg, .js-menu-cg").forEach((b) => { b.hidden = !cgAvailable; });
    // race hardening：initCg() 沒 await、chat.connect() 在後面
    // 才呼叫（見下方），但 server 一連上 WS 就推 cg_state——若那個 push 搶在
    // 這支 album fetch resolve 之前抵達，cg.applyState() 當時 this.items 還是
    // 空的，層會維持隱藏直到下一次 push 才補上（自癒但違反 F5 還原意圖，spec
    // G4）。album 就緒後用 cg.js 記下的最後一次狀態重放一次，把那個空窗關掉。
    if (cgAvailable) cg.reapplyLast();
  }
  initCg();

  // chat 先建構（不 connect）：phone 需要拿它送通話輪訊息——通話輪回覆走既有聊天
  // WS，不是另開連線也不是 REST；onFrame/onStatusChange 綁定與真正 connect() 仍
  // 留在歷史回填之後（見下方既有順序保證的說明，這裡只是把「建構」跟「啟用」
  // 拆開，不影響那個保證）。
  const chat = new ChatClient();

  // ── 電話（撥出／來電浮層／留言卡＋通話動嘴）───────────────────────
  // PhoneController 自己把面板／來電浮層
  // 的 DOM 建進 #phone-root（同 SpritePlayer 對 #stage 的既有慣例：容器留空，
  // 類別負責內容）。
  // 通話內容渲染器：通話台詞／使用者的話／旁白直接進 Chat Log——
  // 「語音的文字直接顯示在 CHAT LOG、自然接下去」；角色的台詞
  // 帶逐句 audio URL＝句尾 play 鍵**即時**掛上（不必等 F5）。
  const callLog = new CallLogRenderer(msgsEl, ctx);
  // 通話台詞 → ADV 同步的逐句累積 buffer：final 收輪、下輪重起。
  let callAdvBuf = "";
  let callAdvTurnDone = true;

  // 通話計時 pill＋左側欄鈕樣態（狀態不在 Chat Log 頂條——
  // 打電話鈕原地變掛斷樣、鈕旁小 pill 顯示「接通中」→ mm:ss）。
  const callPill = document.getElementById("call-pill");
  const fmtCallTime = (s) => {
    const p = (n) => (n < 10 ? "0" + n : String(n));
    return p(Math.floor(s / 60)) + ":" + p(s % 60);
  };

  const phone = new PhoneController({
    driver,
    chatClient: chat,
    container: document.getElementById("phone-root"),
    config,
    // 電話的狀態／失敗訊息（撥不通、額度、麥克風⋯）直接進 Chat Log
    // 當 system 行——那個「只有一顆 icon 的視窗」徹底退場。
    onStatusNote: (text) => renderFrame({ role: "system", text }, msgsEl, ctx),
    onCallContent: (ev) => {
      if (!ev) return;
      if (ev.type === "character") {
        callLog.characterSentence(ev.text, ev.audio, ev.final);
        // 「兩邊要對上」：他在通話裡說的話，ADV 對話框同步顯示——
        // 逐句累積、instant 呈現（語音正在唸＝字幕即現，不跑打字機、也不觸發
        // 打字口型——通話嘴型由 MouthDriver 管，讓位不變）。final 收輪＝下一輪
        // 第一句重起一段。手機 ADV 由 CSS 隱藏、present 無害。
        // ADV 字幕是跟 Chat Log 通話泡泡同族的
        // 具名顯示站點，[cg:]／[intimate:*]／[sticker:] 一樣不可裸奔——用同一顆
        // stripMarkers（跟非通話 assistant frame 收尾那行 `adv.present(stripMarkers
        // (frame.text).text, ...)` 同一套淨化，不是第二套規則）。累積 buffer
        // 本身也改存淨化後的字，避免下一句接續時把已上屏的舊標記文字留在
        // buffer 裡反覆重繪。
        if (typeof ev.text === "string" && ev.text) {
          const advText = stripMarkers(ev.text).text;
          callAdvBuf = callAdvTurnDone ? advText : (callAdvBuf ? callAdvBuf + "\n" + advText : advText);
          callAdvTurnDone = false;
          adv.present(callAdvBuf, { instant: true });
        }
        if (ev.final) callAdvTurnDone = true;
      } else if (ev.type === "user") callLog.userLine(ev.text);
      else if (ev.type === "thinking") renderFrame({ role: "status", text: "⋯⋯" }, msgsEl, ctx);
      else callLog.sysLine(typeof ev.text === "string" ? ev.text : "");
    },
    onCallState: ({ phase, seconds }) => {
      const active = phase !== "idle";
      // body.in-call：純 CSS 切換電話鈕 icon（icon-call↔icon-hangup，桌機手機
      // 同一條規則——比照眼睛鈕 eye/eye-off 既有 pattern）。
      document.body.classList.toggle("in-call", active);
      document.querySelectorAll(".js-open-phone").forEach((b) => {
        tAttr(b, "aria-label", active ? "side.hangup" : "side.phone");
      });
      if (callPill) {
        callPill.hidden = !active;
        callPill.textContent = phase === "dialing" ? t("call.dialing") : fmtCallTime(seconds);
      }
    },
    // 正在打字（輸入框 focus 或有內容）＝VAD 不開錄——鍵盤聲
    // 誤觸的（沒聽清楚）根治。input 宣告在後（閉包晚綁定，通話開始時早已就緒）。
    getTypingActive: () =>
      document.activeElement === input || !!(input && input.value && input.value.trim()),
  });
  // 功能入口 class 綁定（toggle）：同一顆電話鈕＝
  // 打電話／掛斷雙態——idle 按下去直撥；撥號中／通話中按下去＝掛斷（撥號中＝
  // 取消這次撥號）。icon 樣態由 body.in-call 純 CSS 切，見 onCallState。
  document.querySelectorAll(".js-open-phone").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (phone.isActive()) phone.hangUp();
      else phone.dialOut();
    });
  });

  // ── 輸入列功能選單：清畫面／乾淨開始／狀態一律可見；忘記暫存（沙盒模式限定）／
  // CG 相冊（手機限定）視情況顯示。清畫面＝前端清訊息容器；乾淨開始＝清畫面＋送
  // "/new"；狀態＝送 "/status"——上行是既有 WS 裸字串路徑，冪等無前端狀態
  // （server 是唯一真相）。
  const btnCmdMenu = document.getElementById("btn-cmd-menu");
  const cmdPop = document.getElementById("cmd-pop");
  function clearChatView() {
    msgsEl.replaceChildren();
    // 清畫面＝左邊 ADV 框一起清（present("") 清正文＋收 Thinking 鈕；
    // 清的只是畫面，帳本／記憶零觸碰——跟 Chat Log 清法同語意）。
    // 雙頁籤：THINKING 頁的思緒串同清（同「畫面歸零」語意；本就 transient）。
    // pending 錨同清——飛行中的補發卡對已歸零的畫面沒有意義
    //（寧可無卡）；鈕的 is-pending 態由 present("") 內的 _setThoughts 順路重置
    //（親驗 adv.js：present 對空字串 early-return 前就先跑 _setThoughts），
    // 不需要另補 updateThoughts(null)。pendingThoughtsTs 宣告在後＝閉包晚綁定
    //（同上 thoughtsPaneEl 先例，本函式只在點選單那一刻執行）。
    adv.present("");
    pendingThoughtsTs = null;
    if (thoughtsPaneEl) thoughtsPaneEl.replaceChildren();
    // 「清畫面後 F5／重開又回來」的修法 → 持久清除線；同時支援跨裝置版：
    // 先 POST server 線（server 端自取帳本尾 ts，全裝置一致＝即時通訊軟體同款體感），
    // 成功順手同步 localStorage（單機 fallback 保持新鮮）；404（flag 未開）／
    // 失敗＝退回單機路徑（fetchLastEntryTs→localStorage，上一版行為）。不
    // await（清畫面體感即時）；帳本資料自始至終零觸碰。
    // L1 復原＝刪 server 線＋removeItem＝歷史顯示全回來。
    postServerClearLine(CLEAR_SYNC_URL).then((serverTs) => {
      if (serverTs) {
        localStorage.setItem(CHAT_CLEAR_KEY, serverTs);
        return;
      }
      if (!historyUrl) return;
      return fetchLastEntryTs(historyUrl).then((ts) => {
        if (ts) localStorage.setItem(CHAT_CLEAR_KEY, ts);
      });
    });
  }

  /** 沙盒動作（忘記暫存／關閉測試模式）成功後共用：目前畫面可能還是沙盒測試
   * 內容，清掉後照開機同一條路徑重新拉一次正式歷史。
   *
   * clearedAt 取**當下最新的那條清除線**：先重新 GET 一次 server 線，拿不到
   * （flag 未開／網路錯）才落回 localStorage——精確沿用開機那段的優先序
   * （server 優先＝跨裝置一致），差別只在「重新問一次」而不是沿用開機那顆值。
   *
   * 為什麼一定要重問：開機那顆 `serverClearLine`
   * 是 main() 當時 await 到的**快照**。在沙盒裡按了「清畫面」，clearChatView
   * 只會更新 server 線與 localStorage，那顆 const 永遠停在開機值；沿用它回填，
   * 剛剛清掉的正式對話會整批復活在畫面上，得按 F5 才會消失——而按「忘記
   * 暫存」的當下正期待畫面乾淨（常是為了截圖）。
   *
   * 為什麼不是 `localStorage || serverClearLine`：那會把優先序顛倒。在手機清
   * 的畫面，這台電腦的 localStorage 沒有那條線、server 有——localStorage 優先
   * 會讓跨裝置清除線失效（要做到「一邊清、兩邊都清」）。
   *
   * fetchServerClearLine／thoughtsPaneEl 等宣告在後（本檔既有的閉包晚綁定慣例，
   * 見上方 clearChatView 內 thoughtsPaneEl 同款先例），這支只在點忘記暫存／
   * 關測試模式那一刻才真的執行，main() 早已跑完。 */
  function reloadProductionHistory() {
    msgsEl.replaceChildren();
    adv.present(""); // is-pending 隨 _setThoughts 重置（同 clearChatView 說明）
    pendingThoughtsTs = null; // 忘記暫存＝畫面歸零，飛行中補發卡一併作廢
    if (thoughtsPaneEl) thoughtsPaneEl.replaceChildren();
    if (!historyUrl) return Promise.resolve([]); // 沒配歷史端點＝這組功能整個不出現
    return fetchServerClearLine(CLEAR_SYNC_URL).then((freshClearLine) =>
      loadHistory(historyUrl, msgsEl, ctx, {
        clearedAt: freshClearLine || localStorage.getItem(CHAT_CLEAR_KEY),
      }),
    );
  }

  if (btnCmdMenu && cmdPop) {
    btnCmdMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = cmdPop.hidden;
      cmdPop.hidden = !willOpen;
      btnCmdMenu.setAttribute("aria-expanded", String(willOpen));
    });
    cmdPop.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cmd]");
      if (!b) return;
      cmdPop.hidden = true;
      btnCmdMenu.setAttribute("aria-expanded", "false");
      const cmd = b.dataset.cmd;
      if (cmd === "clear") {
        clearChatView();
      } else if (cmd === "new") {
        clearChatView();
        chat.send("/new");
      } else if (cmd === "status") {
        chat.send("/status");
      } else if (cmd === "sandbox_forget") {
        // 忘記暫存：確認→銷毀→畫面清空＋重回填正式歷史（沙盒維持 on，可能
        // 還想繼續測）。成功＝確認提示「（沙盒暫存已銷毀）」（測試字樣
        // 一律統一沙盒），必須等 reloadProductionHistory() resolve 完才渲染——回填
        // 內部的 msgsEl.replaceChildren() 會把先畫的行沖掉（同 onSandboxChange 那個
        // 順序坑，見下方 SettingsPanel 建構那段註解）。成功／失敗兩句都走
        // role:"status"（transient、被下一個 frame 自然蓋掉），不用
        // role:"system"（永久 append 進 scrollback）——沙盒 UI
        // 的任何提示都不可永久佔用 scrollback，開沙盒常是為了截圖，permanent
        // 行會直接穿幫（同 onSandboxChange 的理由）。
        // 實測：server 端 forget 與對話輪共用同一把序列化鎖、在途輪
        // 沒走完前會安靜排隊——按下去到「已銷毀」之間可能
        // 隔一整輪（15-60s），期間畫面零回饋＝以為沒反應而重按／先去點 CG，
        // 完成行就落在新內容後面（三連發 POST＋完成行遲到的實錄）。
        // 修＝確認當下立刻渲「銷毀中」status（同 status 取代制，之後任何 frame
        // 自然蓋掉）＋sandboxForgetPending 防重入（排隊期間再點＝無聲吞掉，不再
        // 疊 POST）。純顯示層，鎖語意與 FIFO 順序不動。
        // 確認窗改自刻 confirmDialog（系統窗吃不到主題＋露網域
        // 抬頭）——async 化後 pending 檢查兩道：開窗前擋重入、resolve 後再驗
        // 一次（單例守門下實務進不來，防禦線）。
        if (!sandboxForgetPending) {
          confirmDialog(t("sandbox.confirmForget")).then((ok) => {
            if (!ok || sandboxForgetPending) return;
            sandboxForgetPending = true;
            renderFrame({ role: "status", text: t("sandbox.forgetting") }, msgsEl, ctx);
            sandboxForget()
              .then(() => reloadProductionHistory())
              .then(() => {
                renderFrame({ role: "status", text: t("sandbox.forgot") }, msgsEl, ctx);
              })
              .catch(() => {
                renderFrame({ role: "status", text: t("sandbox.forgetFailed") }, msgsEl, ctx);
              })
              .finally(() => {
                sandboxForgetPending = false;
              });
          });
        }
      } else if (cmd === "cg") {
        // 手機 MENU 的 CG 相冊項：複用桌機側欄 CG 鈕同一開啟
        // 函式（cgPanel.open()）。cgPanel 宣告在後＝閉包晚綁定（同 clearChatView
        // 內 thoughtsPaneEl 先例——這裡只在點選單那一刻執行，main() 早跑完）。
        // 桌機此項由 layout.css 藏（#cmd-pop .js-menu-cg）；顯隱由 initCg() 管。
        if (cgPanel) cgPanel.open();
      }
    });
    document.addEventListener("click", (e) => {
      if (!cmdPop.hidden && !cmdPop.contains(e.target) && e.target !== btnCmdMenu) {
        cmdPop.hidden = true;
        btnCmdMenu.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !cmdPop.hidden) {
        cmdPop.hidden = true;
        btnCmdMenu.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ── 「收起對話」（手機底欄 eye 鈕）─────────────────────────────
  // 舊語意＝收立繪（js-toggle-sprite → applySpriteVisible）；翻轉為
  // 「立繪這麼重要，要保留在手機上」——eye 鈕改藏 **Chat Log**（欣賞模式：
  // 立繪滿版、對話框讓位；輸入列與 dock 保留、再按一下回來）。設定頁的
  // 「顯示立繪」開關不動（仍管立繪，走 settings.js 那條既有路）。
  // localStorage v4.chatlogVisible 記憶；body.hide-chatlog 由 layout.css 的
  // 手機段接手顯隱＋eye/eye-off 圖示切換。
  const CHATLOG_VIS_KEY = "v4.chatlogVisible";
  function getChatlogVisible() {
    try { return localStorage.getItem(CHATLOG_VIS_KEY) !== "0"; } catch (e) { return true; }
  }
  function applyChatlogVisible(visible) {
    try { localStorage.setItem(CHATLOG_VIS_KEY, visible ? "1" : "0"); } catch (e) { /* 無痕模式等 */ }
    document.body.classList.toggle("hide-chatlog", !visible);
    document.querySelectorAll(".js-toggle-chatlog").forEach((btn) => {
      tAttr(btn, "aria-label", visible ? "chatlog.hide" : "chatlog.show");
    });
  }
  applyChatlogVisible(getChatlogVisible());
  document.querySelectorAll(".js-toggle-chatlog").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyChatlogVisible(!getChatlogVisible());
    });
  });

  // ── Chat Log 滿版切換（手機右上滿版鈕）────────
  // 「不想遮立繪頭像 vs 對話高度太短不好讀」的兩難用可切換化解：平時中段
  // 遮罩現狀不動；點鈕 Chat Log 展開滿版（頂到 safe-area、底實色深色加讀性）
  // ＋立繪整個隱藏（不透出、免得太亂）。與眼睛鍵成家族（一小一大）、
  // 各自 localStorage 記憶；滿版樣式全在 layout.css 手機段＝桌機即使 class
  // 掛著也零效果（同 hide-chatlog 慣例）。滿版中按眼睛＝Chat Log 收起、立繪
  // 回來（賞立繪優先）——CSS :not(.hide-chatlog) 條件讓兩鍵零互鎖自洽。
  const CHATLOG_FULL_KEY = "v4.chatlogFull";
  function getChatlogFull() {
    // 預設滿版（沒動過的裝置一進來就是滿版）。滿版樣式全在
    // layout.css 手機段＝桌機掛 class 零效果，default true 對桌機無害。
    try {
      const raw = localStorage.getItem(CHATLOG_FULL_KEY);
      return raw === null ? true : raw === "1";
    } catch (e) { return true; }
  }
  function applyChatlogFull(full) {
    try { localStorage.setItem(CHATLOG_FULL_KEY, full ? "1" : "0"); } catch (e) { /* 無痕等 */ }
    document.body.classList.toggle("chatlog-full", full);
    document.querySelectorAll(".js-toggle-chatlog-full").forEach((btn) => {
      tAttr(btn, "aria-label", full ? "chatlog.collapseFull" : "chatlog.expand");
    });
  }
  applyChatlogFull(getChatlogFull());
  document.querySelectorAll(".js-toggle-chatlog-full").forEach((btn) => {
    btn.addEventListener("click", () => {
      // 捲動錨定：切換前貼底（<120px＝chat.js near-bottom 同判準）＝切換後仍
      // 貼底——高度驟變時正在讀的「最新對話」不會跳走；沒貼底＝在翻舊
      // 訊息，位置不動。#msgs 與 #thoughts-pane（THINKING 頁）各自檢查。
      const anchors = ["msgs", "thoughts-pane"].map((id) => {
        const el = document.getElementById(id);
        return el && { el, nearBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 120 };
      }).filter(Boolean);
      applyChatlogFull(!getChatlogFull());
      requestAnimationFrame(() => {
        anchors.forEach(({ el, nearBottom }) => {
          if (nearBottom) el.scrollTop = el.scrollHeight;
        });
      });
    });
  });

  // ── Chat Log 雙頁籤（手機限定）─────────────────────────────────
  // CHAT LOG｜THINKING 兩顆 tab 切 #msgs／#thoughts-pane 顯隱（#chatlog.show-thoughts
  // 由 layout.css 手機段接手；桌機 tabs 整組 CSS 藏＝點不到、class 永不掛上）。
  // 純顯示狀態、開頁預設 CHAT LOG，不記 localStorage（簡單為上）。
  const thoughtsPaneEl = document.getElementById("thoughts-pane");
  {
    const chatlogEl = document.getElementById("chatlog");
    const tabChat = document.getElementById("tab-chat");
    const tabThoughts = document.getElementById("tab-thoughts");
    if (chatlogEl && tabChat && tabThoughts) {
      const setLogTab = (showThoughts) => {
        chatlogEl.classList.toggle("show-thoughts", showThoughts);
        tabChat.classList.toggle("is-active", !showThoughts);
        tabThoughts.classList.toggle("is-active", showThoughts);
        tabChat.setAttribute("aria-selected", String(!showThoughts));
        tabThoughts.setAttribute("aria-selected", String(showThoughts));
      };
      tabChat.addEventListener("click", () => setLogTab(false));
      tabThoughts.addEventListener("click", () => setLogTab(true));
    }
  }

  // ── 桌機眼睛 expander（原「點眼睛直接藏 ADV」改兩顆子鈕）──────
  // 點眼睛＝展開右側子鈕組：①隱藏人像（applySpriteVisible＝與設定頁「顯示
  // 立繪」同一份狀態，開設定面板 _refresh 自動同步勾選）②隱藏視窗（沿用
  // .js-toggle-adv 既有綁定）。用於截 Thinking 時自行決定背景要不要有人像，
  // 由使用者自己決定。點外面／Esc 收合；手機零改動（side-btn 欄手機整欄藏）。
  {
    const eyeMenuBtn = document.querySelector(".js-eye-menu");
    const eyeSub = document.querySelector(".eye-sub");
    if (eyeMenuBtn && eyeSub) {
      const setOpen = (open) => {
        eyeSub.hidden = !open;
        eyeMenuBtn.setAttribute("aria-expanded", String(open));
        eyeMenuBtn.classList.toggle("is-open", open);
      };
      eyeMenuBtn.addEventListener("click", () => setOpen(eyeSub.hidden));
      document.addEventListener("click", (e) => {
        if (!eyeSub.hidden && !eyeSub.contains(e.target) && !eyeMenuBtn.contains(e.target)) {
          setOpen(false);
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !eyeSub.hidden) setOpen(false);
      });
    }
  }
  document.querySelectorAll(".js-toggle-sprite-desk").forEach((btn) => {
    const syncLabel = () => {
      tAttr(btn, "aria-label", getSpriteVisible() ? "side.hideSprite" : "side.showSprite");
    };
    syncLabel();
    btn.addEventListener("click", () => {
      applySpriteVisible(!getSpriteVisible());
      syncLabel();
    });
  });

  // ── 「收起對話框」（入口＝眼睛子鈕組；intimate 中自動收）───────────────
  // 藏的是左邊 ADV 對話框（名牌＋正文＋Thinking 鈕整組＝#adv-root），立繪完整
  // 露出不被遮。隱藏中新回覆照常寫進 ADV 狀態（display:none 不擋邏輯）。
  // intimate（CG 演出）模式自動收 ADV 防遮 CG、結束自動回來、中途眼睛鈕照常
  // 手動——三層狀態機抽 adv-visibility.js（intimate 中的手動切換是 session 級
  // override、不落 localStorage＝平時偏好不被 intimate 汙染），這裡只注入存取
  // 與渲染。
  const ADV_VIS_KEY = "v4.advVisible";
  const advVis = createAdvVisibility({
    getBase() {
      try { return localStorage.getItem(ADV_VIS_KEY) !== "0"; } catch (e) { return true; }
    },
    setBase(visible) {
      try { localStorage.setItem(ADV_VIS_KEY, visible ? "1" : "0"); } catch (e) { /* 無痕等 */ }
    },
    onRender(visible) {
      document.body.classList.toggle("hide-adv", !visible);
      document.querySelectorAll(".js-toggle-adv").forEach((btn) => {
        tAttr(btn, "aria-label", visible ? "side.hideAdv" : "side.showAdv");
      });
    },
  });
  advVis.setIntimate(false); // 開機基線渲染（此刻 intimate 狀態未知；cg_state 連線即推補真值）
  document.querySelectorAll(".js-toggle-adv").forEach((btn) => {
    btn.addEventListener("click", () => advVis.toggle());
  });

  // ── 設定頁 ─────────────
  // sandboxAvailable 是建構當下就要解出的靜態旗標（同 modelOptions 既有慣例：
  // 決定「測試模式」列要不要出現在 DOM，不是之後才能補的即時開關）——沙盒
  // 可用性同時看 config 鍵與後端 flag（GET 探測），必須在這裡 await 過
  // initSandbox() 才能把答案交給 SettingsPanel。initSandbox 本身有 8s
  // AbortController，不會讓這個 await 卡住整個開機流程（同 loadCurrentModel
  // 既有的「卡住的 fetch」防線）。
  await initSandbox();
  // Thinking 開關同款時序：available 是建構當下解出的靜態旗標（同 sandbox）。
  await initThoughtsToggle();
  const settingsPanel = new SettingsPanel({
    container: document.getElementById("settings-root"),
    // 底欄 eye 鈕改管 Chat Log（js-toggle-chatlog），與立繪開關
    // 解耦——設定面板的「顯示立繪」不再需要同步任何外部入口鈕。
    onSpriteVisibleChange: null,
    onMouthSpeedChange: applyMouthSpeed,
    onBlinkSpeedChange: applyBlinkSpeed,
    // 模型切換（config 沒配 models＝整區不出現；引擎端點未就緒＝切換時誠實報錯）
    modelOptions: Array.isArray(config.models) ? config.models : null,
    modelEndpoint: config.modelEndpoint || null,
    // 語音錢包儀表（config 沒配＝整行不出現，開源殼零成本）
    ttsUsageEndpoint: config.ttsUsageEndpoint || null,
    getCurrentModel: () => modelState.current,
    onModelChange: (id) => {
      modelState.current = id;
      showModelOnBrand();
    },
    // 沙盒測試模式（config 缺 sandboxEndpoint 鍵／後端 flag 未開＝整列不出現）：
    // onSandboxChange 是這裡包好的非同步流程——POST＋狀態套用（setSandbox）→
    // 關閉方向把畫面回填成正式歷史（POST off 會讓後端自動銷毀沙盒資料，前端
    // 沒有理由還留著沙盒內容在畫面上）。丟出的錯讓 settings.js 的 change
    // handler 接手把 checkbox 撥回原狀，這裡不碰 DOM。
    // 切換成功一律靜默：原本的 transient status 行（「已進入沙盒模式」／「已回到
    // 正式模式」）在下一個 frame 抵達前會一直停在畫面上，切完模式接著截圖＝那
    // 行被拍進截圖裡。左上暗號（模型名／沙盒代號）本來就分辨得出模式——成功
    // 零 status 行＝畫面乾淨，只有失敗才提示（操作失敗必須有回饋，否則使用者
    // 以為沒按到會連按）。
    sandboxAvailable: sandboxState.available,
    getSandboxOn: () => sandboxState.on,
    onSandboxChange: (on) =>
      setSandbox(on).then(
        async () => {
          if (!on) await reloadProductionHistory();
        },
        (err) => {
          renderFrame({ role: "status", text: t("sandbox.toggleFailed") }, msgsEl, ctx);
          throw err;
        },
      ),
    // Thinking 開關（config 缺鍵／後端 flag 未開＝整列不出現）：切換成功一律
    // 靜默（同沙盒慣例）；失敗丟錯讓 settings.js 撥回 checkbox＋status 行報一
    // 句（操作失敗必須有回饋）。
    thoughtsToggleAvailable: thoughtsToggleState.available,
    getThoughtsVisible: () => thoughtsToggleState.on,
    onThoughtsVisibleChange: (on) =>
      setThoughtsVisible(on).catch((err) => {
        renderFrame({ role: "status", text: t("sandbox.toggleFailed") }, msgsEl, ctx);
        throw err;
      }),
  });
  document.querySelectorAll(".js-open-settings").forEach((btn) => {
    btn.addEventListener("click", () => settingsPanel.toggle());
  });

  // ── 外觀面板 ──────────────
  // 「角色造型」＋「介面主題」兩區收斂在同一面板——獨立主題面板與調色盤鈕
  // 退役、側欄回四鈕（電話→外觀→設定→眼睛）。
  // 造型卡：點卡 → sprite.switchTo（同實例重載，動嘴／眨眼接線全不動；static
  // 造型由 manifest 自報、sprite 內部全 no-op）→ localStorage 記憶 → active 卡
  // 標記搬家。切換失敗（斷網等）→ 誠實回錯卡標記、不半殘。
  // 主題卡：theme.js 注入底層 token＋per-theme 素材（框件／房間／指南針）。
  const themeMgr = initThemes(config); // 開機恢復（localStorage v4.theme）在 init 內
  const appearanceRoot = document.getElementById("appearance-root");
  let appearancePanel = null;
  let resetAppearanceTab = () => {}; // TAB 塊內賦值（無 TAB 的開源殼＝no-op）
  // 三張卡表（造型／主題／家具）的換語系重譯——各自 TAB 塊內賦值（沒有該表＝
  // no-op，同 resetAppearanceTab 慣例）；統一由下方一個 onLocaleChange 訂閱觸發。
  let relabelOutfits = () => {};
  let relabelThemes = () => {};
  let relabelFurniture = () => {};
  // 換裝共用邏輯：面板點卡與下方 room_state frame handler 共用；無
  // appearanceRoot（縮版頁如 tour）＝no-op，同 resetAppearanceTab 慣例。
  let switchAppearanceById = async () => false;
  if (appearanceRoot) {
    appearancePanel = document.createElement("div");
    appearancePanel.className = "settings-panel appearance-panel";
    appearancePanel.hidden = true;
    // 點暗幕關閉（同設定面板慣例）。右上叉叉退役——點選項
    // 以外任何位置即關，叉叉是多餘的第二條路。
    appearancePanel.addEventListener("click", (e) => {
      if (e.target === appearancePanel) appearancePanel.hidden = true;
    });
    const apSheet = document.createElement("div");
    apSheet.className = "appearance-sheet";
    const apHeading = document.createElement("h2");
    apHeading.className = "settings-heading";
    tEl(apHeading, "appearance.title");
    // 收 i18n key（非現成文字）——這個 <p> 建一次後留在 DOM 裡不重建，用 tEl
    // 掛上 data-i18n 才吃得到之後任何一次 applyDom() 重譯（換語系時）。
    const sectionLabel = (key) => {
      const el = document.createElement("p");
      el.className = "appearance-section-label";
      tEl(el, key);
      return el;
    };
    const apList = document.createElement("div");
    apList.className = "appearance-list";

    let switching = false; // 換裝進行中不收第二單（switchTo 是 async 重載）
    const cardOf = new Map();
    const markActive = () => {
      cardOf.forEach((cardEl, id) => {
        const on = id === currentAppearance.id;
        cardEl.classList.toggle("is-active", on);
        const tag = cardEl.querySelector(".appearance-card-tag");
        // 用中才掛 tEl（讓之後的語系切換吃得到）；不使用中要清乾淨——連
        // dataset.i18n 一併刪，否則下次 applyDom() 重譯掃到這顆殘留的
        // data-i18n 標記，會把已經清空的卡片重新寫回「使用中」字樣。
        if (on) tEl(tag, "appearance.inUse");
        else { tag.textContent = ""; delete tag.dataset.i18n; }
      });
    };

    // 換裝共用邏輯：面板點卡與下方 room_state frame handler（後端推來的現值，
    // 見 applyRoomState）共用同一條路——防重入、失敗回穿、寫 localStorage、
    // 面板 is-active 同步，全部只有這一份。
    //
    // 冪等 guard 比對的是**記憶體裡的 currentAppearance.id**（＝這個分頁畫面上
    // 真正穿著的那套），不是 localStorage：localStorage 是同一瀏覽器所有分頁共
    // 用的一格，不是 per-分頁的真相。A 分頁換裝把新 id 寫進去之後，B 分頁若拿
    // 它當自己的現值判準，room_state 廣播一到就會被誤判成「已經是目標值」而提
    // 早 return，畫面卡在舊造型直到重整。改比記憶體現值＝同一則廣播能讓每個開
    // 著的分頁各自收斂。目標＝現值＝直接 return true、不重載（重複點同一張卡／
    // 後端冪等校正皆吃這條）。
    switchAppearanceById = async (id) => {
      if (switching) return false; // 換裝進行中不收第二單（switchTo 是 async 重載）
      if (id === currentAppearance.id) return true;
      const ap = appearances.find((a) => a.id === id);
      if (!ap) return false; // 未知 id（如後端造型清單領先這台前端）＝no-op
      switching = true;
      const prev = currentAppearance;
      let ok = true;
      try {
        await sprite.switchTo(ap.assetsPath);
        sprite.startIdle(); // static 內部 no-op；動態造型眨眼恢復
        blush.syncFrom(sprite.manifest, ap.assetsPath); // 新造型的臉紅素材跟著換（無鍵＝收層）
        expr.syncFrom(sprite.manifest, ap.assetsPath);
        currentAppearance = ap;
        try { localStorage.setItem(APPEARANCE_KEY, ap.id); } catch (e) { /* 無痕等 */ }
      } catch (err) {
        // 換裝失敗：試著回穿上一套（回穿也失敗＝sprite 自身降級接手，聊天不受影響）
        console.warn("[app] appearance switch failed; reverting to the previous set:", err);
        ok = false;
        try {
          await sprite.switchTo(prev.assetsPath);
          sprite.startIdle();
          blush.syncFrom(sprite.manifest, prev.assetsPath); // 回穿也要對回原套素材
          expr.syncFrom(sprite.manifest, prev.assetsPath);
        } catch (e2) { console.warn("[app] revert also failed (portrait falls back, chat unaffected):", e2); }
      } finally {
        switching = false;
        markActive();
      }
      return ok;
    };

    appearances.forEach((ap) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "appearance-card";
      const cardName = document.createElement("span");
      cardName.className = "appearance-card-name";
      cardName.textContent = appearanceLabelOf(ap);
      const cardTag = document.createElement("span");
      cardTag.className = "appearance-card-tag";
      card.appendChild(cardName);
      card.appendChild(cardTag);
      card.addEventListener("click", async () => {
        // 換裝共用邏輯已抽到 switchAppearanceById——這裡只管「這次是不是使用者
        // 真的按了一張新卡」，決定要不要 reportRoom（冪等 no-op／換裝失敗皆不
        // 報，同下方 reportRoom 呼叫慣例）。
        const prevId = currentAppearance.id;
        const ok = await switchAppearanceById(ap.id);
        if (ok && ap.id !== prevId) reportRoom({ outfit: ap.id });
      });
      cardOf.set(ap.id, card);
      apList.appendChild(card);
    });
    markActive();
    // 換語系即時重譯（見檔頭 relabelOutfits 宣告與下方唯一一個 onLocaleChange
    // 訂閱）——沿用 cardOf、不重建 DOM，卡名現值改查 appearanceLabelOf(ap)。
    relabelOutfits = bindLocaleRelabel({
      cards: cardOf,
      getLabel: (id) => appearanceLabelOf(appearances.find((a) => a.id === id) || { id }),
    });

    apSheet.appendChild(apHeading);

    // 介面主題（config.themes）＋家具（config.furniture）——任一存在＝TAB 分
    // 頁；兩者皆無＝單列現狀（config 不配即隱形，DOM 與沒有這兩族時一模一樣）。
    const hasThemesTab = themeMgr.list.length > 1;
    const hasFurnitureTab = furnitureMgr.items.length > 0;
    if (hasThemesTab || hasFurnitureTab) {
      // TAB 分頁（兩區疊一起太長——橫排 TAB 決定下方列表，
      // 桌機手機同款；設計語言沿 CG 管理態 TAB／chatlog 頁籤同 token 家族）。
      const apTabs = document.createElement("div");
      apTabs.className = "appearance-tabs";
      const tabChars = document.createElement("button");
      tabChars.type = "button";
      tabChars.className = "appearance-tab is-active";
      tEl(tabChars, "appearance.tabOutfits");
      apTabs.appendChild(tabChars);
      let tabThemes = null;
      if (hasThemesTab) {
        tabThemes = document.createElement("button");
        tabThemes.type = "button";
        tabThemes.className = "appearance-tab";
        tEl(tabThemes, "appearance.tabThemes");
        apTabs.appendChild(tabThemes);
      }
      let tabFurniture = null;
      if (hasFurnitureTab) {
        tabFurniture = document.createElement("button");
        tabFurniture.type = "button";
        tabFurniture.className = "appearance-tab";
        tEl(tabFurniture, "appearance.tabFurniture");
        apTabs.appendChild(tabFurniture);
      }
      apSheet.appendChild(apTabs);
      const thList = document.createElement("div");
      // appearance-theme-list＝主題卡片列表（TAB 分頁下手機與桌機同樣顯示卡片）
      thList.className = "appearance-list appearance-theme-list";
      const thCardOf = new Map();
      const thMarkActive = () => {
        thCardOf.forEach((cardEl, id) => {
          const on = id === themeMgr.current;
          cardEl.classList.toggle("is-active", on);
          const tag = cardEl.querySelector(".appearance-card-tag");
          // 同上方 markActive：清空要連 dataset.i18n 一併刪，見該處註解。
          if (on) tEl(tag, "appearance.inUse");
          else { tag.textContent = ""; delete tag.dataset.i18n; }
        });
      };
      themeMgr.list.forEach((theme) => {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "appearance-card";
        const cardName = document.createElement("span");
        cardName.className = "appearance-card-name";
        cardName.textContent = pickLabel(theme.label);
        // 三色點 swatch（line／btnBg／accent）＝一眼看出這套的氣質；預設主題
        // 無 vars 時給固定 fallback 色組（現值＝crystal-swan）。
        const swatch = document.createElement("span");
        swatch.className = "theme-swatch";
        const vars = theme.vars || {};
        const dots = [
          vars.line || "rgba(190,218,255,.88)",
          vars.btnBg || "#2b3f6b",
          vars.accent || "rgba(232,242,255,.96)",
        ];
        dots.forEach((color) => {
          const dot = document.createElement("span");
          dot.className = "theme-swatch-dot";
          dot.style.background = color;
          swatch.appendChild(dot);
        });
        const cardTag = document.createElement("span");
        cardTag.className = "appearance-card-tag";
        const right = document.createElement("span");
        right.className = "theme-swatch";
        right.appendChild(swatch);
        right.appendChild(cardTag);
        card.appendChild(cardName);
        card.appendChild(right);
        card.addEventListener("click", () => {
          if (theme.id === themeMgr.current) return;
          themeMgr.apply(theme.id);
          thMarkActive();
        });
        thCardOf.set(theme.id, card);
        thList.appendChild(card);
      });
      thMarkActive();
      // 換語系即時重譯——沿用 thCardOf、不重建 DOM。hasThemesTab 為假時 thList
      // 沒被掛進 DOM（單一主題不出 TAB），relabel 仍安全（改寫的是離枝節點）。
      relabelThemes = bindLocaleRelabel({
        cards: thCardOf,
        getLabel: (id) => {
          const theme = themeMgr.list.find((th) => th.id === id);
          return theme ? pickLabel(theme.label) : id;
        },
      });
      // 家具卡列表：同 appearance-card 家族；與造型單選不同，家具是**多選
      // toggle**——點一下放置、再點收起，is-active＝放置中。
      let fnList = null;
      if (hasFurnitureTab) {
        fnList = document.createElement("div");
        fnList.className = "appearance-list";
        const fnCardOf = new Map();
        const fnMark = () => {
          fnCardOf.forEach((cardEl, id) => {
            const on = furnitureMgr.isOn(id);
            cardEl.classList.toggle("is-active", on);
            const tag = cardEl.querySelector(".appearance-card-tag");
            // 同上方 markActive：清空要連 dataset.i18n 一併刪，見該處註解。
            if (on) tEl(tag, "appearance.placed");
            else { tag.textContent = ""; delete tag.dataset.i18n; }
          });
        };
        furnitureMgr.items.forEach((item) => {
          const card = document.createElement("button");
          card.type = "button";
          card.className = "appearance-card";
          const cardName = document.createElement("span");
          cardName.className = "appearance-card-name";
          cardName.textContent = pickLabel(item.label) || item.id;
          const cardTag = document.createElement("span");
          cardTag.className = "appearance-card-tag";
          card.appendChild(cardName);
          card.appendChild(cardTag);
          card.addEventListener("click", () => {
            furnitureMgr.toggle(item.id);
            fnMark();
            // 擺／收之後上報現值（切換後的真值，非切換前）。
            reportRoom({ furniture: { [item.id]: furnitureMgr.isOn(item.id) } });
          });
          fnCardOf.set(item.id, card);
          fnList.appendChild(card);
        });
        fnMark();
        // 換語系即時重譯——沿用 fnCardOf、不重建 DOM。
        relabelFurniture = bindLocaleRelabel({
          cards: fnCardOf,
          getLabel: (id) => {
            const item = furnitureMgr.items.find((it) => it.id === id);
            return item ? (pickLabel(item.label) || item.id) : id;
          },
        });
      }

      // TAB 內容包（造型｜主題｜家具各一包，hidden 切換；wrap 是素 div 無
      // display 規則＝hidden 原生有效，不踩 #cmd-pop 家族 display 蓋 hidden 的坑）
      const charsWrap = document.createElement("div");
      charsWrap.appendChild(apList);
      let themesWrap = null;
      if (hasThemesTab) {
        themesWrap = document.createElement("div");
        themesWrap.hidden = true;
        themesWrap.appendChild(thList);
      }
      let furnWrap = null;
      if (hasFurnitureTab) {
        furnWrap = document.createElement("div");
        furnWrap.hidden = true;
        furnWrap.appendChild(fnList);
      }
      const selectTab = (which) => {
        charsWrap.hidden = which !== "chars";
        if (themesWrap) themesWrap.hidden = which !== "themes";
        if (furnWrap) furnWrap.hidden = which !== "furniture";
        tabChars.classList.toggle("is-active", which === "chars");
        if (tabThemes) tabThemes.classList.toggle("is-active", which === "themes");
        if (tabFurniture) tabFurniture.classList.toggle("is-active", which === "furniture");
      };
      tabChars.addEventListener("click", () => selectTab("chars"));
      if (tabThemes) tabThemes.addEventListener("click", () => selectTab("themes"));
      if (tabFurniture) tabFurniture.addEventListener("click", () => selectTab("furniture"));
      apSheet.appendChild(charsWrap);
      if (themesWrap) apSheet.appendChild(themesWrap);
      if (furnWrap) apSheet.appendChild(furnWrap);
      // 每次開面板起點一律左 tab（角色造型）——重開＝重新開始，
      // 不留上次停在主題頁的殘態（同設定面板「開面板下拉收乾淨」慣例）。
      resetAppearanceTab = () => selectTab("chars");
    }

    // 面板說明句：有 TAB＝已自明、免說明；
    // 無 themes 無 furniture 時維持單列＋造型 note 現狀。
    if (themeMgr.list.length <= 1 && furnitureMgr.items.length === 0) {
      apSheet.appendChild(sectionLabel("appearance.tabOutfits"));
      apSheet.appendChild(apList);
      const apNote = document.createElement("p");
      apNote.className = "settings-note";
      tEl(apNote, appearances.length > 1 ? "appearance.outfitHint" : "appearance.outfitEmpty");
      apSheet.appendChild(apNote);
    }
    appearancePanel.appendChild(apSheet);
    appearanceRoot.appendChild(appearancePanel);
  }
  document.querySelectorAll(".js-open-appearance").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!appearancePanel) return;
      const willOpen = appearancePanel.hidden;
      if (willOpen) resetAppearanceTab(); // 開面板一律左 tab 起點
      appearancePanel.hidden = !willOpen;
    });
  });

  // 換語系即時重譯（final review Important 1）：三張卡表（造型／主題／家具）與
  // 品牌角模型名，建面板／建品牌角當下用 pickLabel()／t() 寫死 textContent、沒
  // 掛 data-i18n（config 標籤是物件不是翻譯鍵，applyDom() 天生套不到）——不訂閱
  // 的話，使用者切語系只有掛 data-i18n 的文案（tab／標題／in use 標籤）會跟著
  // applyDom() 變，卡名與模型名停在切換當下那一刻的語系，重整才校正。全殼唯一
  // 一處訂閱：onLocaleChange 在 i18n.js 的 commit() 內是 applyDom() 之後才
  // emit，三個 relabel*（appearanceRoot 不存在時皆為 no-op）＋showModelOnBrand
  // 順序已對，不需要再排序。
  onLocaleChange(() => {
    relabelOutfits();
    relabelThemes();
    relabelFurniture();
    showModelOnBrand();
  });

  // ── 房間現值同步（room_state 三軌）────────────────────────────────────
  // 三軌現值（介面主題／角色造型／家具擺收）從「純顯示層、單機記憶」升級成
  // 「角色也看得到、後端是共同現值來源」：使用者在面板操作 → reportRoom 告訴
  // 後端；角色在回覆裡換裝／使用者操作落盤後，後端用 room_state frame（見下方
  // chat.onFrame 分派）推現值回來、由 applyRoomState 冪等套用。開機這裡再補一
  // 次主動回讀——重開頁面／換裝置時，先用 localStorage 現狀即畫（零等待，見上
  // 面 initThemes／FurnitureManager／currentAppearance 三者建構時都已經先用
  // localStorage 現值畫過一輪），後端值到後才校正，多數時候是零視覺變化的無感
  // 補正。config 無 roomEndpoint＝整套機制不存在（不打任何請求）。
  //
  // 注意上報只走兩軌：outfit／furniture 走這裡的 roomEndpoint，主題走 theme.js
  // 既有的 themeEndpoint（面板點主題卡＝`themeMgr.apply(id)`＝照舊上報那支）
  // ——同一份房間現值、兩個端點寫入，前端不重複報。
  function reportRoom(partial) {
    const ep = config.roomEndpoint;
    if (!ep) return; // config 無此鍵＝機制不存在，零成本
    // 同步 try 包在 .catch() 之外（比照 theme.js reportTheme 的包法）：fetch 本
    // 身同步就炸的環境（極舊瀏覽器／被擴充套件動過手腳）會讓例外從家具卡的
    // click handler 竄出去，把「點一下擺家具」變成整個 handler 中斷。上報是加
    // 分項，任何形式的失敗都不該回頭咬操作本身。
    try {
      fetch(ep, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      }).catch(() => { /* 上報是加分項，安靜吞——換裝本身已經成功 */ });
    } catch (e) {
      /* fetch 同步炸也不擋操作 */
    }
  }

  // 後端發起的現值套用（room_state frame／開機回讀共用同一支）：三軌各自獨立
  // try——一軌失敗（如未知 outfit id、furniture 物件格式壞掉）不擋另外兩軌，也
  // 不擋聊天本身（換裝／擺家具永遠是加分項）。呼叫 applyById／
  // switchAppearanceById 皆不傳報上參數＝不觸發 reportRoom／reportTheme（防回
  // 音：後端推來的值不可以又被報回後端，否則形成回音圈）。
  async function applyRoomState(f) {
    // theme 軌判準用記憶體 getter `themeMgr.current`（apply() 每次都同步更新、
    // 與畫面上的 data-theme 一致），不是會讀 localStorage 的 currentId()——理由
    // 同上方 switchAppearanceById 的冪等 guard：localStorage 跨分頁共用，拿它當
    // 現值判準會讓第二個分頁把廣播吞掉。（currentId() 仍是對外 API 的一部分，
    // 只是這裡不用它。）
    if (f && f.theme && themeMgr && themeMgr.current !== f.theme) {
      try {
        themeMgr.applyById(f.theme);
      } catch (e) { console.warn("[app] room theme apply failed (chat unaffected):", e); }
    }
    if (f && f.outfit) {
      try {
        await switchAppearanceById(f.outfit);
      } catch (e) { console.warn("[app] room outfit apply failed (chat unaffected):", e); }
    }
    if (f && f.furniture && furnitureMgr) {
      try {
        for (const [id, on] of Object.entries(f.furniture)) furnitureMgr.setOn(id, on);
      } catch (e) { console.warn("[app] room furniture apply failed (chat unaffected):", e); }
    }
  }

  // 開機回讀：後端為現值來源、localStorage 為斷線／未接後端時的天然 fallback。
  // config 無 roomEndpoint＝整段不存在，連 fetch 都不打（同 sandboxEndpoint／
  // cgEndpoint 等既有慣例）。
  //
  // 遷移補報：後端全新（`v.outfit === null`＝三軌從「純顯示層」升級「全域共
  // 享」後這是第一次有裝置開機回讀、outfit 從沒被任何裝置報過）時，套用完後端
  // 值（此時 theme／furniture 可能已有值、outfit 必為 null＝套用該軌是 no-op）
  // 後，補一次性報上本機現有的 outfit／furniture 現值——否則後端側「現在穿著
  // X」這類敘述會一直卡空值，要等下次手動點卡才補上。currentAppearance.id 是本
  // 機現值（同上面點卡 handler 取「現值」的既有寫法）；furnitureMgr.snapshot()
  // 含從未記錄過、走 defaultOn 邏輯的項。POST 端（reportRoom）不推 frame＝這裡
  // 不會形成回音。判準嚴格 `=== null`：鍵缺席（undefined）不算「後端全新」。
  if (config.roomEndpoint) {
    fetch(config.roomEndpoint, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (v) => {
        if (!v) return;
        await applyRoomState({ ...v, role: "room_state" });
        if (v.outfit === null) {
          reportRoom({ outfit: currentAppearance.id, furniture: furnitureMgr.snapshot() });
        }
      })
      .catch(() => { /* 斷網／未接後端：畫面維持 localStorage 現狀，使用者感覺不到差別 */ });
  }

  // ── CG 相冊彈窗（視圖態＋管理態；雙軌
  // 制：per-device 視圖＋桌機｜手機管理 TAB＋「<」返回鍵）──────────────────────
  // 殼／卡片渲染／點卡送指令／點暗幕關／管理態（上傳／編輯／刪除／排序／
  // 開場候選），全部收在 cg.js 的 buildCgPanel（單測覆蓋見
  // tests/cg-panel.test.js＋tests/cg-manage.test.js）；這裡只接線：給宿主容器＋
  // cg presenter＋send callback＋endpointBase，`.js-open-cg` 綁 panel.open()
  // （同 `.js-open-appearance` 慣例）。按鈕本身的顯隱已由上方 initCg() 管
  // （cgAvailable 決定 hidden）——看不到的按鈕點不到，這裡不用重複判斷可用性。
  // endpointBase 與 CgPresenter 同一份 config.cgEndpoint——管理端點與相冊端點
  // 是同一個根路徑下的手足端點，沒有理由分兩份設定各自維護、將來漂移。
  const cgRoot = document.getElementById("cg-root");
  const cgPanel = cgRoot
    ? buildCgPanel(cgRoot, cg, {
        // 點卡送 /cg 成功＝出「他在打字」三點（點卡到他入景開口
        // 的等待期，Chat Log 不能空白像沒反應）。
        send: (t) => {
          const ok = chat.send(t);
          if (ok) showThinkingDots(msgsEl);
          return ok;
        },
        endpointBase: config.cgEndpoint || "",
      })
    : null;
  document.querySelectorAll(".js-open-cg").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (cgPanel) cgPanel.open();
    });
  });

  // 429（每日語音上限）提示的共用 once 包裝：自動朗讀（TtsSpeaker）與句尾播放鍵
  // 的現場合成（TtsSynthCache）兩條路都可能撞日帽，提示只需要出現一次——once
  // 收斂在這裡，兩個實例共用同一個旗標（TtsSpeaker 內部另有自己的 once 防線，
  // 兩層都在也只會出一句）。
  let ttsCapNotified = false;
  const notifyTtsDailyCap = () => {
    if (ttsCapNotified) return;
    ttsCapNotified = true;
    renderFrame({ role: "system", text: t("tts.quotaOut") }, msgsEl, ctx);
  };

  // 「這句預期會出聲」的單一判準——TtsSpeaker.getEnabled 與 onTypingChange 的
  // 空窗期讓位共用同一顆：兩處永不脫鉤（脫鉤＝打字閉嘴等一個永遠不會來的聲音）。
  const ttsWillSpeak = () => getTtsEnabled() && !phone.isActive() && !isReplaying();

  const tts = new TtsSpeaker({
    endpoint: config.ttsEndpoint,
    driver,
    // 單一聲源鐵則：撥號中／通話中／留言播放中
    // （phone.isActive()）聊天 TTS 一律靜默——他不會同時用兩張嘴說話。TTS 開關
    // 讀取邏輯收斂在 settings.js 的 getTtsEnabled（單一真相，這裡不再自己維護
    // 一份 localStorage 判斷邏輯）。
    // isReplaying：句尾 play 重播中同樣讓位——重播也是他在說話。
    getEnabled: ttsWillSpeak,
    // 空窗期閉嘴的補位信號：這句語音確定不來（合成失敗／204／429／播放層炸）
    // ＝打字口型接手（字還在跑且語音沒在講才接）——「嘴死了」舊坑的保險絲。
    onNoVoice: () => { if (advTyping && !driver.isFlapping()) sprite.startTalking(); },
    // 429（每日語音上限）：早就規劃過一句能被看見的提示，
    // 但這條線從沒真的接上——重用既有 role:"system"
    // 渲染路徑（.sys-msg，見 chat.js `_renderSystemLine`），不另開一套 DOM 機制。
    onDailyCap: notifyTtsDailyCap,
  });
  // 單一聲源鐵則的另一半：phone 建構當下 tts
  // 還不存在（見上方建構順序——tts 的 getEnabled 閉包需要引用已存在的 phone），這裡
  // 事後補上這條連結；dialOut()／acceptIncomingCall() 需要它來收掉正在飛的聊天 TTS
  // （見 phone.js `_stopChatTts` 的函式說明）。
  phone.tts = tts;

  // 首次 pointerdown（一次性）：手勢視窗內解鎖 MouthDriver 的 AudioContext ＋
  // TtsSpeaker 的持久播放元件＋chat.js 句尾播放鍵共用的 _replayEl（iOS 手勢
  // 優先播放規則，見 audio-mouth.js `MouthDriver.unlock()`、tts.js
  // `TtsSpeaker.prime()`、chat.js `primeReplayEl()` 各自的函式說明）。三者都要
  // 在同一個使用者手勢事件內同步呼叫，缺一個都會讓對應那條播放路徑在 iOS 上
  // 第一次播放時被瀏覽器無聲擋下——句尾播放鍵（存檔／合成重播共用同一顆
  // _replayEl）在補上 primeReplayEl() 之前正是這條路徑的破口。
  document.addEventListener("pointerdown", () => { driver.unlock(); tts.prime(); primeReplayEl(); }, { once: true });

  // ?mouthdebug=1 嘴型除錯浮層：本機除錯用的 ground truth 出口——通話中
  // 截一張圖＝定生死 fork。不帶參數＝no-op 零成本，正式使用零影響。
  initMouthDebug({ driver, sprite, phone, adv, isTtsEnabled: getTtsEnabled });

  // 歷史回填：await 完整跑完才往下接 WS，保證一開頁面
  // 看到的是完整回填好的歷史，不會有「連線比回填先跑完、WS 新訊息插在歷史中間」
  // 這種順序倒錯的尷尬瞬間。失敗（4xx/5xx/網路錯誤/逾時）loadHistory 內部已經
  // console.warn 並吞掉，這裡不需要、也不應該再包一層 try/catch。
  // clearedAt＝清畫面持久清除線：server 線優先（跨裝置一致——在手機
  // 清的，電腦這裡 GET 到同一條）；404（flag 未開）／失敗＝單機 localStorage
  // 線。有線＝只回填線後 entries；沒線＝全量。ADV 開場末句吃濾後回傳值。
  const serverClearLine = await fetchServerClearLine(CLEAR_SYNC_URL);

  // ── 玫瑰相簿愛心鈕 ────────────────────────────
  // 按泡泡旁的愛心＝那則話存進玫瑰相簿；F5 後亮過的還亮。開機序刻意「先
  // probe 再回填」，放在 loadHistory 之前 await：GET /api/v4/rose-flags 成功
  // （200）才設 ctx.roseHooks＋記住這批 flags，loadHistory 畫完歷史泡泡後再
  // 點亮；404／網路錯／config 缺鍵——整個 session 都不設 ctx.roseHooks，之後
  // 不管是歷史回填還是即時 WS 新訊息，reply 泡泡一律不長玫瑰鈕。
  //
  // 為什麼不能「先設 hooks、loadHistory 完再 probe」（更直覺的順序）：那樣
  // 歷史泡泡會在 probe 結果出來前就照「hooks 存在」畫上玫瑰鈕了——若 probe
  // 之後才發現該 404（後端這版其實沒開這個 flag），沒辦法讓已經畫出來的鈕
  // 消失（renderFrame 早跑完），只能落得「歷史泡泡有鈕但摸不到人、之後訊息
  // 看設定值」這種不上不下的狀態。先 probe 再回填保證同一個 session 全程只
  // 有「整個有」或「整個沒有」兩種一致狀態，不會一半有鈕一半沒有。
  //
  // config 缺 roseEndpoint／roseFlagsEndpoint 任一（開源殼／這台還沒部署這版
  // 後端）＝整段直接略過，連 fetch 都不打——不是「打了才發現沒用」，是設計上
  // 就不碰。15s AbortController 同 loadHistory 的既有逾時保護（見 chat.js）：
  // 這裡同樣是 await loadHistory() 之前的卡點，一個卡住不 resolve 的 fetch
  // 會讓整個開機流程卡在「連線中⋯⋯」之前，連聊天輸入框都進不去。
  let roseFlagsToApply = null;
  if (config.roseEndpoint && config.roseFlagsEndpoint) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let data = null;
      try {
        const res = await fetch(config.roseFlagsEndpoint, { credentials: "same-origin", signal: ctrl.signal });
        if (res.ok) data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      if (data && Array.isArray(data.flags)) {
        const roseEndpoint = config.roseEndpoint;
        ctx.roseHooks = {
          add: (text) => fetch(roseEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "add", text }),
          }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
          remove: (id) => fetch(roseEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "remove", id }),
          }).then((r) => r.ok),
        };
        roseFlagsToApply = data.flags;
      }
    } catch (e) {
      // 網路錯／逾時＝同 404 靜默降級，不設 ctx.roseHooks（見上）；不 warn 洗版
      // ——這條探測路徑失敗是常態分支之一（這版後端沒開這個 flag 很正常）。
    }
  }

  // ── 句尾播放鍵擴到每一句普通聊天句 ──────────────────────────────────────
  // 普通聊天句後端不落檔（電話系才有 archive）——重聽＝現場重合成，由
  // TtsSynthCache 快取「同一句同頁面只合成一次」。三態閘門：
  //   ① 沒配 ttsEndpoint＝後端沒開語音／開源殼，整段略過，DOM 與本功能上線前
  //      byte-identical。
  //   ② 配了 ttsEndpoint 但沒配 ttsUsageEndpoint＝視為後端明確開了語音、只是
  //      沒接用量端點，直接注入 hooks.synth，不 probe。
  //   ③ 兩鍵都配＝先 probe ttsUsageEndpoint（GET、唯讀零記帳），2xx 才注入。
  // ② 不 probe 的理由：TTS 本體端點是 POST-only，拿 GET 探它只會拿到 405，
  // 分不出「後端沒開」與「後端不支援 GET」兩種情況；ttsUsageEndpoint 是選配的
  // 用量計費端點，沒配它不代表語音沒開，只代表這版後端沒實作用量統計——不該
  // 因為一個選配端點缺席就連主功能一起關掉。probe 走 GET（唯讀零記帳）、15s
  // 逾時同其餘開機期 fetch 慣例；探測失敗（網路錯／逾時／非 2xx）＝本 session
  // 視為無合成鍵，靜默不注入，不 warn 洗版（同玫瑰鈕探測失敗的既有慣例）。
  // 放在 loadHistory 之前 await：保證歷史泡泡與之後 WS 新泡泡「整個 session
  // 有就全有、沒有就全沒有」，不會一半有播放鍵一半沒有。
  if (config.ttsEndpoint) {
    let ttsAlive = true;
    if (config.ttsUsageEndpoint) {
      ttsAlive = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(config.ttsUsageEndpoint, { credentials: "same-origin", signal: ctrl.signal });
          ttsAlive = !!res && res.ok;
        } finally { clearTimeout(timer); }
      } catch (e) { /* 探測失敗＝本 session 無合成鍵，靜默 */ }
    }
    if (ttsAlive) {
      const synthCache = new TtsSynthCache({ endpoint: config.ttsEndpoint, onDailyCap: notifyTtsDailyCap });
      ctx.replayHooks.synth = (text) => synthCache.get(text);
    }
  }

  const historyEntries = historyUrl
    ? await loadHistory(historyUrl, msgsEl, ctx, {
        clearedAt: serverClearLine || localStorage.getItem(CHAT_CLEAR_KEY),
      })
    : []; // 沒配 historyEndpoint＝不拉歷史，開場空白、不報錯
  // 歷史泡泡畫完才點亮（見上方 probe 區塊說明）；roseFlagsToApply 為 null＝
  // 這個 session 沒有玫瑰鈕，no-op。
  if (roseFlagsToApply) markRoseFlags(roseFlagsToApply);

  // ADV 開場：把歷史裡最後一句對方的話直接放上對話框（instant，
  // 不跑打字機）——一開頁面他就「在框裡等著」，而不是一塊空玻璃。"Assistant" 是
  // 帳本 speaker 欄的 wire literal（protocol literal, not branding，同 renderHistory）。
  for (let i = historyEntries.length - 1; i >= 0; i--) {
    const entry = historyEntries[i];
    if (entry && entry.speaker === "Assistant" && typeof entry.text === "string" && entry.text.trim()) {
      const { text } = stripMarkers(entry.text);
      if (text) adv.present(text, { instant: true });
      break;
    }
  }

  const connNote = new ConnNoteTracker(); // 待機提示選句（見 conn-note.js）
  chat.onStatusChange = (status) => {
    const noteKey = connNote.keyFor(status);
    if (statusEl) statusEl.textContent = connText(status);
    // ADV 待機提示：正文空著時框裡給一句介面系統文字（不是對方的話——本機預覽
    // 沒有後端、或斷線期間，看到的不該是一塊沉默的空玻璃）。正文已有內容時
    // `:empty` 不成立，這行純粹是設 data 屬性、不會蓋掉任何一句話。
    if (status === "open") {
      adv.setIdleNote("");
      return;
    }
    // 狀態離開 "open"（重連中／已關閉／錯誤，含開機第一次
    // connect 前那顆初始 "connecting"——此時本來就沒有殘留可清，下面兩行都是
    // 安全的 no-op）＝這一輪被迫中斷：chat.onFrame 那三個「這輪結束」分支
    // （assistant/system/call 家族）都不會被呼叫，半成品泡泡沒有主人收——孤兒留在
    // 畫面上，一路留到重連後下一輪內容把它蓋掉，中間這段空窗看到的是一句讀到
    // 一半、再也不會更新的話。比照 chat.onFrame 的 assistant final frame 分支同款
    // 收尾：清半成品泡泡＋解除武裝（下一次送出訊息會重新 streamArmed=true，
    // guard 語意不變，見 chat.onFrame 上方 streamArmed 說明）。
    clearPartialBubble(msgsEl);
    streamActive = false;
    streamArmed = false;
    // 斷線＝pending 一併收掉——server 的補發只送當輪那條 ws、
    // 已斷即吞（契約「ws 已斷→吞」），這張卡在新連線上永遠不會來；不清
    // 的話鈕會呼吸到下一輪才停。updateThoughts(null) 只殺 pending、不動已送達的
    // 思緒（見 adv.js），開機第一次 "connecting" 時是安全 no-op。
    pendingThoughtsTs = null;
    adv.updateThoughts(null);
    adv.setIdleNote(t(noteKey)); // 從沒連上過又已失敗＝「尚未連線」句；其餘照舊（見 conn-note.js）
  };
  // 邊寫邊送：partial frame＝這一輪目前累積的完整文字（非
  // 增量，每次都是從頭算的全文，見 chat.onFrame 內對應分支）。streamArmed／
  // streamActive 兩顆旗標職責分開，別合成一顆：
  //   streamArmed（武裝）：送出下一則訊息時武裝＝true（見下方 submit／傳照片
  //     兩處 `streamArmed = true`），assistant/system/call 家族任一「這輪結束」frame
  //     處理完解除武裝＝false。partial frame 只在武裝時才處理——這是防呆閘門
  //     本身：final frame 剛處理完那瞬間，網路上可能還有上一輪殘留的遲到
  //     partial 在飛（毫秒級 race window），解除武裝後這種漏網之魚會被直接
  //     忽略（不建泡泡、不動 ADV），不會讓已經定案的畫面又跳出半成品殘影。
  //   streamActive（真的有串流）：只在 partial frame 真的被處理（武裝狀態下）
  //     才設 true，assistant 收尾時用它決定 Chat Log 要不要 instant（已經看過
  //     逐字浮現、不用再重播一次）＋ADV 要不要用 resume 收尾。刻意跟
  //     streamArmed 分開：如果兩者合一，「武裝但這輪其實沒收到任何 partial」
  //     （如後端旗標關閉、或這輪太短沒機會流）也會被誤判成「有串流」，讓
  //     Chat Log 平白失去逐行顯現。
  let streamArmed = false;
  let streamActive = false;
  // 思緒補發錨：reply frame 帶 thoughts_pending=true（該輪
  // thoughts 恆 null、轉寫在背景跑）時，記下該 frame 的 timestamp 原值當錨；
  // 晚到的 {"role":"thoughts","text":<str|null>,"for_ts":...} 補發 frame 必須
  // for_ts === 錨才被採納（嚴格比對 timestamp 原字串），不合＝已開新輪／F5 後
  // 殘留晚到＝整包丟棄（寧可無卡——thoughts 本就 transient，錯輪補掛的表演傷害
  // 大於無卡）。錨的生滅：assistant reply frame 到達＝無條件重算（帶 pending＝覆蓋、
  // 不帶＝清空）；送出新訊息＝清（舊輪的卡不掛到新輪的戲台上）；命中補發＝
  // 清（一輪最多一張卡）；清畫面／忘記暫存／WS 斷線＝清（斷線時 server 端對已斷
  // ws 的補發一律吞掉，這張卡永遠不會來，別讓鈕永遠呼吸）。null＝當前無 pending。
  let pendingThoughtsTs = null;
  chat.onFrame = (frame) => {
    // call 家族三個 role（"call"／"incoming_call"／"incoming_call_end"，都是後端真的
    // 會送過來的 wire literal，protocol literal, not branding）整個交給 phone 分派
    // ——chat.js 的 renderFrame 對這三者本來就是「已知但故意不處理」的 no-op，
    // 這裡攔在 renderFrame 之前，chat.js 零改動。
    // 電話輪也算「這輪結束」（通話內容走 CallLogRenderer 另一條管道，見下方
    // onCallContent）——清掉可能殘留的半成品泡泡＋解除武裝，不留 graceful/
    // 錯誤輪的鬼影；沒有殘留可清時兩行都是安全的 no-op。
    if (frame && (frame.role === "call" || frame.role === "incoming_call" || frame.role === "incoming_call_end")) {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      phone.handleFrame(frame);
      return;
    }
    // CG 演出狀態：無 room 鍵、role 為
    // 協定字面值 "cg_state"——開／關 intimate 狀態或換景時 server 推播，cg.js
    // 自己決定顯不顯示層／出不出場景行，這裡只管轉發，不算「這輪結束」（不動
    // streamArmed／不碰半成品泡泡，intimate 中仍可能正等一句回覆）。
    if (frame && !frame.room && frame.role === "cg_state") {
      cg.applyState({ intimate: !!frame.intimate, scene: frame.scene || null });
      // 自動收 ADV（防遮 CG）：intimate 欄位＝門的第一手語義。開門＝預設收、
      // 關門＝回平時偏好＋清臨時 override；換景（intimate 不變）＝冪等重推，
      // 使用者手動打開的不被收回去。F5 intimate 中＝重連即推＝還原。
      advVis.setIntimate(!!frame.intimate);
      return;
    }
    // 房間現值（協定字面值 "room_state"）：角色換裝／使用者從面板操作後任一
    // 側落盤，後端推現值過來——冪等套用三軌（現值＝目標＝跳過，見
    // applyRoomState），旁路處理比照上面 cg_state：不算「這輪結束」，不動
    // streamArmed／半成品泡泡（可能正等下一句回覆，換裝與聊天輪是兩條互不相干
    // 的軌）。
    if (frame && !frame.room && frame.role === "room_state") {
      applyRoomState(frame);
      return;
    }
    // 沙盒跨裝置同步（「按一下哪邊的暫存都要忘光光」）：另一台裝置
    // 按了忘記暫存／切換沙盒，server 對所有在線分頁廣播。旁路
    // 處理比照 cg_state（不算這輪結束）。forgot＝有清除發生：本分頁清畫面＋
    // 重回填（沙盒維持 on＝回填正式拼接、剛銷毀的暫存自然消失；關沙盒＝回
    // 正式歷史——同一支 reloadProductionHistory 兩種情境都對）。發起分頁自己
    // 也會收到＝重複清一次畫面，冪等無感。開沙盒（forgot=false）＝只切暗號
    // 與 UI，畫面不動。
    // 切換靜默：關沙盒不再渲「（已回到正式模式）」——status 行在下一個 frame
    // 抵達前會一直停在畫面上、會被截圖拍進去；回填＋暗號變化本身就是提示。
    // 忘記暫存（on=true）的「沙盒暫存已銷毀」是銷毀操作的回饋、照舊保留（銷
    // 毀零回饋會招來連按）。
    if (frame && !frame.room && frame.role === "sandbox_state") {
      const on = !!frame.on;
      sandboxState.on = on;
      applySandboxUi();
      // settingsPanel 宣告在後＝閉包晚綁定（frame 只在 connect 後到達，main()
      // 早已跑完——同 cgPanel／thoughtsPaneEl 慣例）。
      if (settingsPanel && settingsPanel.setSandboxChecked) settingsPanel.setSandboxChecked(on);
      if (frame.forgot) {
        reloadProductionHistory().then(() => {
          if (on) {
            renderFrame({ role: "status", text: t("sandbox.forgot") }, msgsEl, ctx);
          }
        });
      }
      return;
    }
    // Thinking 開關跨裝置同步（照 sandbox_state 慣例）：另一台裝置切了開關，
    // 本分頁的 Thinking 鈕／THINKING 頁籤跟著收起或回來；設定面板若開著、
    // checkbox 一併翻面。發起分頁自己也收到＝冪等無感。
    if (frame && !frame.room && frame.role === "thoughts_visible_state") {
      thoughtsToggleState.on = !(frame.on === false);
      applyThoughtsUi();
      if (settingsPanel && settingsPanel.setThoughtsVisibleChecked) {
        settingsPanel.setThoughtsVisibleChecked(thoughtsToggleState.on);
      }
      return;
    }
    // 思緒補發 frame（server 契約）：role 為協定字面值
    // "thoughts"——背景轉寫完成後 server 對本輪 ws 補發 {text:<str|null>, for_ts}。
    // 旁路處理**比照上面 cg_state**：不算「這輪結束」——不動 streamArmed／
    // streamActive、不清半成品泡泡、不進 Chat Log（renderFrame 不呼叫；它對未知
    // role 本來就靜默略過，這裡攔在所有 end-of-stream 分支之前，雙保險）。可能
    // 正在等下一輪的 partial 串流，這個 frame 只是上一輪思緒卡的晚到快遞。
    // for_ts 校驗見上方 pendingThoughtsTs 宣告：命中＝更新 ADV Thinking 鈕＋
    // THINKING 頁 append（text 為字串時；null＝這輪定案無卡，只收 pending）；
    // 不合＝整包丟棄且**不清錨**（錨若屬於更新的一輪，那張卡還在路上）。
    if (frame && !frame.room && frame.role === "thoughts") {
      if (pendingThoughtsTs !== null && frame.for_ts === pendingThoughtsTs) {
        pendingThoughtsTs = null; // 一輪最多一張卡：命中即清，重複補發不二次採納
        const text = typeof frame.text === "string" ? frame.text : null;
        adv.updateThoughts(text);
        if (text) appendThought(thoughtsPaneEl, text);
      }
      return;
    }
    // （舊「通話中 role:"system" 改道通話字幕區」的特殊分派退場——
    // 通話內容本身已渲在 Chat Log，system 行走下方 renderFrame 主路徑就是對的
    // 位置，全程單一路徑。）
    // 思考中（role:"status"）兩路都送：ADV 脈動點（桌機戲台）＋
    // Chat Log 尾行（renderFrame 既有 status-line——手機沒有 ADV 框，這行是唯一
    // 看得到的思考訊號；桌機兩者並存，Chat Log 是「紀錄視窗」本來就該記）。
    // 非 status frame 到達時 renderFrame 自動清行、ADV 由 present 收，兩邊各自收尾。
    // status 不算「這輪結束」（還在等回覆，串流可能接著來）——不動 streamArmed。
    if (frame && !frame.room && frame.role === "status") {
      adv.thinking(typeof frame.text === "string" ? frame.text : "");
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    // partial frame：ADV 用 resume 續打累積全文＋Chat Log 半成品
    // 泡泡 upsert。未武裝＝忽略（見上方 streamArmed 說明）。
    if (frame && !frame.room && frame.role === "partial" && typeof frame.text === "string") {
      if (!streamArmed) return; // 漏網的遲到 partial（上一輪已收尾）——不建泡泡、ADV 不動
      streamActive = true;
      const clean = stripMarkers(frame.text).text;
      adv.present(clean, { resume: true });
      upsertPartialBubble(msgsEl, clean);
      return;
    }
    // system frame（引擎錯誤／逾時等提示，見下方 tts.onDailyCap 等呼叫點）同樣算
    // 「這輪結束」：清半成品泡泡＋解除武裝，不讓錯誤輪留下讀不完的殘影——只會
    // 看到一句友善提示，不會看到卡住的半句話。
    if (frame && !frame.room && frame.role === "system") {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    // 完整回覆到達＝role 為協定回覆字面值且沒有 room 鍵；thoughts/
    // react/sticker 都只是這個 frame 上的欄位或內嵌標記，不需要額外排除。"assistant"
    // 是後端真的會送過來的 wire literal（protocol literal, not branding）。
    if (frame && !frame.room && frame.role === "assistant" && typeof frame.text === "string") {
      // 收尾三件事：①清掉半成品泡泡（不管這輪有沒有真的串流過，呼叫皆安全、
      // 冪等）②解除武裝（這輪結束，下一顆 partial 要等下次送出訊息才會被接受）
      // ③依 streamActive 決定 Chat Log 要不要 instant、ADV 要不要 resume——
      // frame.instant 必須在 renderFrame(frame,...) 之前設好，_renderReplyBubble
      // 才讀得到（這是把 renderFrame 呼叫從最前面挪進本分支、不再無條件擺在
      // 分派最前面的唯一原因；呼叫本身的參數 renderFrame(frame, msgsEl, ctx)
      // 跟改之前一模一樣）。
      // 捲位凍結（開頭錨定的配套）：串流過的輪，半成品拆掉的瞬間內容變矮、
      // 瀏覽器會把 scrollTop 夾回去（clamp）——若正停在回覆開頭讀，畫面會往上
      // 跳一屏。記住拆前捲位、正式泡泡上屏後原位放回（instant 全文與半成品內容
      // 相同＝高度幾乎一致，視覺零跳動）。沒串流的輪維持 renderFrame 自己的
      // 近底跟捲，不做凍結。
      const frozenScrollTop = streamActive ? msgsEl.scrollTop : null;
      clearPartialBubble(msgsEl);
      streamArmed = false;
      if (streamActive) frame.instant = true; // 內容已看過＝不逐行重播；ADV 用 resume 收尾
      // 思緒轉寫 pending：thoughts_pending 只在 true 時出現（缺鍵＝falsy、
      // 舊後端零影響），出現時該輪 thoughts 恆 null、補發 frame 稍後靠 for_ts 對錨。
      // timestamp 缺席（協定上不會，防禦而已）＝沒有可對的錨＝不進 pending 態，
      // 免得鈕呼吸到天荒地老等一張永遠對不上的卡——寧可無卡。
      const thoughtsPending = !!frame.thoughts_pending && frame.timestamp != null;
      pendingThoughtsTs = thoughtsPending ? frame.timestamp : null; // 新 reply＝錨無條件重算（覆蓋或清空）
      const finalOpts = streamActive
        ? { thoughts: frame.thoughts, thoughtsPending, resume: true }
        : { thoughts: frame.thoughts, thoughtsPending };
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      if (frozenScrollTop !== null) msgsEl.scrollTop = frozenScrollTop;
      // ADV 戲台：剝掉 [react:]/[sticker:] 標記的正文跑打字機（或續打收尾）。剝完
      // 是空（純貼圖／純表情回應）也照 present("")——清掉思考點與上一句，Chat Log
      // 那邊的占位泡泡會說明發生了什麼。
      const parsed = stripMarkers(frame.text);
      adv.present(parsed.text, finalOpts);
      // 臉紅：final reply 才觸發（partial／歷史只剝不觸發）——[blush]＝mid、
      // [blush:deep]＝deep，濃度由角色自己決定；無素材造型內部 no-op。
      if (parsed.blushLevel) blush.show(parsed.blushLevel);
      // 表情：final reply 帶 [expr:ID]＝亮（未知 ID／此造型無素材＝內部 no-op）；
      // 沒帶＝持續型表情釋放、淡回平靜（每句由角色自己決定帶不帶）。
      if (parsed.exprId) expr.show(parsed.exprId); else expr.release();
      // 雙頁籤：思緒同步進 THINKING 頁（手機的家；桌機 pane 恆藏、append 無害）。
      if (typeof frame.thoughts === "string") appendThought(thoughtsPaneEl, frame.thoughts);
      tts.speak(frame.text); // 原文餵 TTS，淨化交後端單一真相（見檔頭說明）
      return;
    }
    // 其餘 role（本地 "sent" 偽 frame、房間系／未來未知 role）——舊行為不變，直接
    // 交給 renderFrame（它自己對未知 role／房間 frame 靜默略過）。
    renderFrame(frame, msgsEl, ctx);
  };
  chat.connect(wsUrlFrom(config.wsEndpoint));

  const form = document.getElementById("inputbar");
  const input = document.getElementById("chat-input");

  // textarea 預設 Enter＝換行、不會觸發 form submit（跟 <input type="text"> 不同）——
  // 這裡補常見的 IME-safe 慣例：注音／拼音組字中的 Enter
  // 一律放行給輸入法選字；沒有 Shift 的 Enter 才攔截預設換行、觸發送出；Shift+Enter
  // 讓 textarea 自然插入換行。requestSubmit() 觸發標準 submit 事件，跟按鈕送出走同一條邏輯。
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    // 通話中打字＝這句話進**通話輪**——包成
    // {call:true,text} frame，跟 STT 轉出的文字走同一個後端入口，他照樣語音＋字幕回。
    // 只在嚴格 in-call 包（撥號中還沒接通＝照舊私聊）；字幕上屏交給
    // phone 的字幕流（同 STT 成功的渲染語意），Chat Log 的 sent 泡泡照畫
    // ——通話視圖是疊層，掛斷後在 Chat Log 仍看得到自己說過的話。
    const inCall = phone.isInCall();
    const sent = chat.send(inCall ? JSON.stringify({ call: true, text }) : text);
    if (!sent) {
      // 連線還沒接上：不清空輸入框、不畫已送出的泡泡——沒有真的送出，畫面不能騙人已經送了。
      // 頭部的連線狀態文字（connText）已經在說明現況，這裡不用再彈一次訊息。
      return;
    }
    input.value = "";
    if (inCall) phone.noteTypedUtterance(text);
    // 邊寫邊送：送出新訊息＝下一輪可能有 partial 串流要來，重新武裝
    // guard（見 chat.onFrame 上方 streamArmed 說明）。通話中送出也一併武裝——
    // 無害：通話回覆走 CallLogRenderer／onCallContent 另一條管道，不會有 partial
    // frame，這顆旗標對通話輪只是不會被用到，不是誤用。
    streamArmed = true;
    pendingThoughtsTs = null; // 開新輪＝上一輪晚到的思緒卡作廢（見錨宣告：寧可無卡）
    renderFrame({ role: "sent", text }, msgsEl, ctx);
    // 「他在打字」三點——必須在 sent 泡泡之後（renderFrame 的
    // dispatch 會先清 status 行，順序反了三點會被自己的 sent 泡泡清掉）。
    showThinkingDots(msgsEl);
  });

  // ── 傳照片 ───────────────────────────────────────────────────
  // 私聊沒有下行「照片回顯」frame——上傳成功後直接本地樂觀渲染
  // （URL.createObjectURL 的 blob URL，只活這個分頁的 session），不等任何伺服器
  // 確認；WS 那頭送的是既有協定裡「帶照片」的 JSON 形狀 {text, photos}，
  // `ChatClient.send()` 本來就是「原樣把字串送出去」，不需要為這個形狀
  // 加任何新方法。
  const btnAttach = document.getElementById("btn-attach");
  const photoInput = document.getElementById("photo-input");
  const photoStatusEl = document.getElementById("photo-status");
  const photoUploader = new PhotoUploader({ endpoint: config.photoEndpoint });

  function setPhotoStatus(text, isError) {
    if (!photoStatusEl) return;
    photoStatusEl.textContent = text || "";
    photoStatusEl.classList.toggle("is-error", !!isError);
  }

  // 照片送出流程（迴紋針 change 與
  // Ctrl+V 貼上兩個入口走同一條——大小防呆／防重入／樂觀渲染／WS 送出／誠實失敗
  // 全一份；單張行為與清單化前逐行等價）。captionOverride（預覽窗帶說明
  // 輸入框）＝貼圖窗內打的說明文字；未給（迴紋針路徑）＝照舊讀主輸入框。
  //
  // 多張：uploadMany 序列上傳（任一失敗即中止、不送半批）→
  // 收齊 photoIds 一則 WS `{text, photos:[...]}`（後端天生吃 id
  // 清單，順序＝上傳序）→ 樂觀渲染 N 顆照片泡泡直向堆疊。
  async function sendPhotoFiles(files, captionOverride) {
    const list = (files || []).filter(Boolean);
    if (!list.length) return;

    setPhotoStatus(list.length > 1 ? t("photo.sendingN", { i: 1, n: list.length }) : t("photo.sending"), false);
    btnAttach.disabled = true;
    btnAttach.classList.add("is-sending");

    const caption = (typeof captionOverride === "string" ? captionOverride : input.value).trim();
    // 大小防呆在 uploadMany 內建（開傳前全量檢查、訊息點名第幾張，零 fetch 零浪費）。
    const result = await photoUploader.uploadMany(list, {
      onProgress: (i, n) => {
        if (n > 1) setPhotoStatus(t("photo.sendingN", { i, n }), false);
      },
    });

    btnAttach.disabled = false;
    btnAttach.classList.remove("is-sending");

    if (!result.ok) {
      setPhotoStatus(result.message, true); // 誠實失敗訊息，聊天本身不受影響、可繼續打字
      return;
    }

    setPhotoStatus("", false);
    input.value = "";
    // 本地樂觀渲染：這些圖只有這個分頁看得到（沿用既有設計）。
    const localUrls = list.map((f) => URL.createObjectURL(f));
    // 邊寫邊送：配文字傳照片也是「送出新訊息」——同步武裝 guard（見
    // chat.onFrame 上方 streamArmed 說明），配圖回覆一樣可能串流。
    streamArmed = true;
    pendingThoughtsTs = null; // 同 submit：開新輪＝舊輪思緒卡作廢
    renderFrame({ role: "sent", text: caption, photoUrls: localUrls }, msgsEl, ctx);

    const sent = chat.send(JSON.stringify({ text: caption, photos: result.photoIds }));
    if (!sent) {
      // /api/photo 已經成功、但 WS 斷線送不出去——ChatClient.send() 對這種帶
      // photos 的 JSON 訊息沒有既有的離線佇列可用（那是純文字 ws.send(text) 的
      // 場景），誠實告知，不假裝訊息已經送達對方。
      setPhotoStatus(t("photo.uploadedOffline"), true);
    } else {
      showThinkingDots(msgsEl); // 照片輪同款（sent 泡泡已在上面渲染過）
    }
  }

  if (btnAttach && photoInput) {
    // 兩個入口（迴紋針／貼上）共用的單則上限，預設 3（config.photoMaxCount 可調）
    const photoMaxCount = Math.max(1, Number(config.photoMaxCount) || 3);

    btnAttach.addEventListener("click", () => {
      if (photoUploader.busy) return; // 按鈕理論上已停用，這裡再守一道防重入
      photoInput.click();
    });

    // 迴紋針（也要能一次選多張；選完不直接傳、一律先過預覽窗）：
    // input 已開 multiple；選檔後與貼上走同一個窗、同一套規則（先看見要傳
    // 什麼、可補說明、窗開著可續 Ctrl+V 追加、✕ 移除單張、可取消）。
    photoInput.addEventListener("change", async () => {
      const files = Array.from(photoInput.files || []).filter(Boolean);
      photoInput.value = ""; // 清空：允許使用者連續兩次選同一批檔案都能觸發 change
      if (!files.length) return;
      const res = await confirmPhotoDialog({
        files,
        maxCount: photoMaxCount,
        initialText: input.value,
        placeholder: t("photo.captionPlaceholder"),
      });
      if (res.ok && res.files.length) await sendPhotoFiles(res.files, res.text);
    });

    // ── Ctrl+V 貼圖＝視同夾帶（即時通訊軟體同款直覺）────
    // 輸入框 paste 事件抓剪貼簿 image/*（截圖工具 Win+Shift+S／右鍵複製圖片）
    // → 自刻預覽確認窗 → 確定走 sendPhotoFiles 同一條（防呆／樂觀渲染／WS 全
    // 現成）。純文字貼上完全不攔（沒有 image item 就原樣放行）；iOS 長按貼上
    // 圖片同樣觸發 paste＝手機順帶可用，無額外分流。
    //
    // 多圖累積（即時通訊軟體同款）：真實工作流常是截圖→貼、再截→再貼＝逐張
    // Ctrl+V——**窗開著時後續貼上由窗自己接手累積**（縮圖列 +1、滿
    // config.photoMaxCount 誠實提示拒收；縮圖列＝將送出的完整清單，所見即所
    // 送）。一次剪貼簿多張（檔案總管多選複製）同樣全收進窗。確定＝一則訊息
    // N 張圖（後端 resolve_photos 吃 id 清單）；預覽 URL 生命週期歸窗自管。
    input.addEventListener("paste", async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) { // index 迴圈：DataTransferItemList 的 iterator 舊 WebKit 沒有
        const it = items[i];
        if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return; // 純文字／非圖片貼上照常進 textarea
      e.preventDefault(); // 圖片輪：別讓瀏覽器把它以任何形式塞進輸入框
      if (photoUploader.busy) {
        setPhotoStatus(t("photo.stillUploading"), true);
        return;
      }
      // 跟即時通訊軟體一樣——窗內直接打說明文字、圖＋文一起送。預填主
      // 輸入框現有文字（先打字再貼圖的情境）；窗內改的以窗內為準，送出
      // 成功後主輸入框照 sendPhotoFiles 既有行為清空（文字已隨圖送出）。
      const res = await confirmPhotoDialog({
        files,
        maxCount: photoMaxCount,
        initialText: input.value,
        placeholder: t("photo.captionPlaceholder"),
      });
      if (res.ok && res.files.length) await sendPhotoFiles(res.files, res.text);
    });
  }
}

main().catch((e) => console.error("app.js failed to initialize:", e));
