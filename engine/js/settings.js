/**
 * settings.js —— 設定頁：localStorage 讀寫（含預設值）＋即時套用面板 UI。
 *
 * 設計原則：
 *   ① 即時套用——沒有「套用」按鈕，每個控制項一改就寫 localStorage、同時對正在跑的
 *      物件（MouthDriver）直接改屬性；開機時讀一次當初始值。
 *   ② 單一真相——TTS 開關的讀取邏輯只寫一次在這裡（`getTtsEnabled`），app.js 的
 *      `TtsSpeaker.getEnabled` 直接引用這支函式，不再各自維護一份判斷邏輯。
 *   ③ 立繪顯示開關與手機版 topbar「收起他」鈕是同一份狀態（localStorage
 *      `v4.spriteVisible`）——`applySpriteVisible()` 是唯一的寫入＋套用入口，兩個
 *      UI 進入點都呼叫它，不會各自兜一份重複邏輯而漂移。
 *
 * 命名鐵則：本檔零角色專屬字樣——所有文案泛用於任何開源使用者自己的角色。
 */

import { confirmDialog } from "./confirm.js";
import { t, tEl, setLocale, getStoredChoice, localeOptions, onLocaleChange } from "./i18n.js";
import { VERSION } from "./version.js";
import { checkForUpdate, getUpdateState, onUpdateState } from "./update-check.js";
import { buildFeedbackLink } from "./feedback.js";

const KEYS = {
  ttsEnabled: "v4.ttsEnabled",
  spriteVisible: "v4.spriteVisible",
  mouthFlapMs: "v4.mouthFlapMs",
  blinkBaseMs: "v4.blinkBaseMs",
};

const DEFAULTS = {
  ttsEnabled: false,
  spriteVisible: true,
  mouthFlapMs: 105, // 開合一拍的毫秒（同 audio-mouth FLAP_MS 預設）
  blinkBaseMs: 3000, // 眨眼基準間隔＝現役 1800-4200ms 區間的中心（×0.6～×1.4）
};

// 嘴型速度拉桿的值域（range 引擎定、速度使用者自己調）：
// 60ms（很快）～180ms（沉穩）；105＝現值當預設。
export const MOUTH_FLAP_MIN = 60;
export const MOUTH_FLAP_MAX = 180;

// 眨眼頻率拉桿的值域（比照嘴型、range 引擎定、放嘴型上方）：
// 基準間隔 1500ms（眨得勤）～6000ms（沉靜）；實際每次間隔＝基準 ×0.6～×1.4
// 隨機（維持現役區間形狀，3000 預設＝1800-4200＝改版前行為一字不變）。
export const BLINK_BASE_MIN = 1500;
export const BLINK_BASE_MAX = 6000;

// localStorage 在無痕模式／被瀏覽器政策封鎖的環境可能直接 throw（不是回 null）——
// 所有讀寫一律 try/catch，讀失敗回預設值、寫失敗靜默放棄（同 app.js 既有的
// isTtsEnabled 防禦慣例，這裡收斂成共用小工具，未來只有一處要顧）。
function readBool(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch (e) {
    return fallback;
  }
}

function writeBool(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch (e) {
    /* 寫入失敗（容量滿／被封鎖）：這次設定不記住，不拋錯打斷使用者操作。 */
  }
}

/** TTS 開關（預設關）。app.js 的 `TtsSpeaker` 建構時把這支函式直接當 `getEnabled` 用。 */
export function getTtsEnabled() {
  return readBool(KEYS.ttsEnabled, DEFAULTS.ttsEnabled);
}
export function setTtsEnabled(value) {
  writeBool(KEYS.ttsEnabled, !!value);
}

/** 立繪顯示狀態（預設顯示）。只管讀寫，套用到畫面請走 `applySpriteVisible()`。 */
export function getSpriteVisible() {
  return readBool(KEYS.spriteVisible, DEFAULTS.spriteVisible);
}
export function setSpriteVisible(value) {
  writeBool(KEYS.spriteVisible, !!value);
}

/**
 * 立繪顯示狀態的唯一套用入口：寫 localStorage＋切 `body.no-sprite` class
 * （layout.css 靠這個 class 決定手機模式要不要把立繪淡出、氣泡轉不透明）。
 * topbar「收起他」鈕與設定面板的「顯示立繪」開關都呼叫這一支，不各自兜邏輯。
 */
export function applySpriteVisible(visible) {
  setSpriteVisible(visible);
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("no-sprite", !visible);
  }
}

// 嘴型敏感度拉桿（RMS 閾值）已退役（「沒作用的就不放」）——嘴型
// 改播放事件直驅後 RMS 閾值不再參與判定，getMouthLow/High 與 slider UI 整組移除；
// localStorage 舊 key（v4.mouthLow/High）不主動清、自然閒置。
// 新拉桿＝「嘴型速度」（開合拍速，有真實作用）：使用者自己調到喜歡
// 的節奏、不用每次改動引擎常數。打字口型與語音口型吃同一顆值（同拍）。

function readNum(key, fallback, min, max) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  } catch (e) {
    return fallback;
  }
}

function writeNum(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (e) {
    /* 同 writeBool：寫失敗不記住、不打斷操作 */
  }
}

/** 嘴型開合拍速（ms）。app.js 開機讀它餵 MouthDriver＋SpritePlayer。 */
export function getMouthFlapMs() {
  return readNum(KEYS.mouthFlapMs, DEFAULTS.mouthFlapMs, MOUTH_FLAP_MIN, MOUTH_FLAP_MAX);
}
export function setMouthFlapMs(value) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return;
  writeNum(KEYS.mouthFlapMs, Math.min(MOUTH_FLAP_MAX, Math.max(MOUTH_FLAP_MIN, v)));
}

/** 眨眼基準間隔（ms）。app.js 開機讀它餵 sprite.setBlinkInterval。 */
export function getBlinkBaseMs() {
  return readNum(KEYS.blinkBaseMs, DEFAULTS.blinkBaseMs, BLINK_BASE_MIN, BLINK_BASE_MAX);
}
export function setBlinkBaseMs(value) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return;
  writeNum(KEYS.blinkBaseMs, Math.min(BLINK_BASE_MAX, Math.max(BLINK_BASE_MIN, v)));
}

let _uid = 0;
function nextId(prefix) {
  _uid += 1;
  return prefix + "-" + _uid;
}

/**
 * SettingsPanel —— 設定面板本體。同 SpritePlayer／PhoneController 的既有慣例：
 * 呼叫端只給一個空容器，DOM 完全由這個類別自己建。
 */
export class SettingsPanel {
  /**
   * @param {{container: HTMLElement, onSpriteVisibleChange?: (visible:boolean)=>void,
   *          sandboxAvailable?: boolean, getSandboxOn?: () => boolean,
   *          onSandboxChange?: (on: boolean) => Promise<void>,
   *          thoughtsToggleAvailable?: boolean, getThoughtsVisible?: () => boolean,
   *          onThoughtsVisibleChange?: (on: boolean) => Promise<void>}} opts
   */
  constructor({ container, onSpriteVisibleChange, onMouthSpeedChange, onBlinkSpeedChange, modelOptions, modelEndpoint, getCurrentModel, onModelChange, sandboxAvailable, getSandboxOn, onSandboxChange, ttsUsageEndpoint, thoughtsToggleAvailable, getThoughtsVisible, onThoughtsVisibleChange } = {}) {
    this.container = container;
    this.onSpriteVisibleChange = typeof onSpriteVisibleChange === "function" ? onSpriteVisibleChange : null;
    // 嘴型速度拉桿回呼（app.js 拿它同時餵 MouthDriver.setFlapMs＋sprite.setTalkInterval）
    this.onMouthSpeedChange = typeof onMouthSpeedChange === "function" ? onMouthSpeedChange : null;
    // 眨眼頻率拉桿回呼（app.js 拿它餵 sprite.setBlinkInterval）
    this.onBlinkSpeedChange = typeof onBlinkSpeedChange === "function" ? onBlinkSpeedChange : null;
    // 模型切換區：modelOptions（config.models 清單）沒給＝整區不
    // 出現；modelEndpoint 是引擎端點（POST {"model":id}），未就緒時切換誠實報錯。
    this.modelOptions = Array.isArray(modelOptions) && modelOptions.length ? modelOptions : null;
    this.modelEndpoint = typeof modelEndpoint === "string" && modelEndpoint ? modelEndpoint : null;
    this.getCurrentModel = typeof getCurrentModel === "function" ? getCurrentModel : () => null;
    this.onModelChange = typeof onModelChange === "function" ? onModelChange : null;
    // 沙盒測試模式：sandboxAvailable 是建構當下就解出的靜態旗標
    // （同 modelOptions——config 缺鍵／後端 flag 未開時 app.js 傳 false，整列不
    // 出現，開源殼零成本）；getSandboxOn 是即時 getter（同 getCurrentModel，開
    // 面板當下讀真值）；onSandboxChange 是 app.js 包好的非同步流程（POST＋狀態
    // 套用＋status 行），失敗會 reject，由本檔的 change handler 接手撥回 checkbox。
    this.sandboxAvailable = !!sandboxAvailable;
    this.getSandboxOn = typeof getSandboxOn === "function" ? getSandboxOn : () => false;
    this.onSandboxChange = typeof onSandboxChange === "function" ? onSandboxChange : null;
    // 語音錢包儀表：config 沒配 ttsUsageEndpoint＝整行不出現
    // （開源殼零成本，同 modelOptions 慣例）；端點 404（後端 flag 關）＝同樣不顯示。
    this.ttsUsageEndpoint = typeof ttsUsageEndpoint === "string" && ttsUsageEndpoint ? ttsUsageEndpoint : null;
    // Thinking 開關（第三列）：三件組整套照 sandbox 慣例——available 靜態旗標
    // （config 缺鍵／後端 flag 未開＝整列不出現）、即時 getter、app.js 包好的非
    // 同步切換流程（失敗 reject＝change handler 撥回）。
    this.thoughtsToggleAvailable = !!thoughtsToggleAvailable;
    this.getThoughtsVisible = typeof getThoughtsVisible === "function" ? getThoughtsVisible : () => true;
    this.onThoughtsVisibleChange = typeof onThoughtsVisibleChange === "function" ? onThoughtsVisibleChange : null;
    this._dom = {};
    this._buildDom();
  }

  /** 開啟前一定重新整理（見 `_refresh` 說明），保證看到的是當下真值。 */
  open() {
    this._refresh();
    this._dom.panel.hidden = false;
  }
  close() {
    this._dom.panel.hidden = true;
  }
  /** 跨裝置沙盒同步：另一台裝置切了沙盒、本分頁的設定頁若開著，
   * toggle 勾選態要跟著翻——app.js 收到 sandbox_state 廣播 frame 時呼叫。
   * 沙盒列不存在（sandboxAvailable=false）＝安靜 no-op。 */
  setSandboxChecked(on) {
    if (this._dom.sandboxInput) this._dom.sandboxInput.checked = !!on;
  }
  /** 跨裝置 Thinking 開關同步（同 setSandboxChecked 慣例）：app.js 收到
   * thoughts_visible_state 廣播 frame 時呼叫。列不存在＝安靜 no-op。 */
  setThoughtsVisibleChecked(on) {
    if (this._dom.thoughtsToggleInput) this._dom.thoughtsToggleInput.checked = !!on;
  }

  /** 由隱藏切到顯示的那一次也要重新整理——跟 `open()` 是同一條防線，不是兩套邏輯。 */
  toggle() {
    const willOpen = this._dom.panel.hidden;
    if (willOpen) this._refresh();
    this._dom.panel.hidden = !willOpen;
  }

  /**
   * 面板顯示前重新讀一次持久化狀態、套回每個控制項的顯示值。
   *
   * 修正一個真實回歸：舊版每個控制項只在 `_buildDom()` 建構當下讀一次
   * checked/value，之後完全不會再讀。立繪顯示開關偏偏有「兩個獨立入口」
   * （topbar 收起他鈕、這顆 checkbox）都能改同一份 `v4.spriteVisible` 狀態——
   * 若使用者先按 topbar 鈕（呼叫 `applySpriteVisible()`，完全繞過這顆
   * checkbox），checkbox 的 `checked` 屬性停在建構當下那一刻，不會自己跟著變。
   * 等使用者「第一次」打開設定面板時，看到的是建構當下的舊值，跟畫面上立繪
   * 已經收起的事實互相矛盾。兩個入口的同步只單向成立：「面板→topbar 鈕」
   * 這個方向有 `onSpriteVisibleChange` 回呼能同步 topbar 文字，反方向
   * （topbar 鈕→面板）沒有對應機制，所以「兩邊不會各自顯示矛盾的字樣」
   * 這件事只在單向成立。
   *
   * TTS 開關與兩支嘴型拉桿目前只有這一顆面板會寫對應的 key，還沒有第二個入口
   * 能造成一樣的矛盾——但這是「目前沒有第二入口」的巧合，不是這幾個控制項的
   * 讀取邏輯本身比較安全。這裡一併套用同一個防線（開面板就重新讀一次
   * localStorage），管線一致、多花的成本可以忽略，之後真的多一個入口也不需要
   * 再回頭補一次。
   */
  _refresh() {
    if (this._dom.langDd) {
      this._syncLangRow();
      this._dom.langDd.setOpen(false); // 開面板＝下拉收乾淨（同模型下拉既有防線）
    }
    if (this._dom.sandboxInput) this._dom.sandboxInput.checked = this.getSandboxOn();
    if (this._dom.thoughtsToggleInput) this._dom.thoughtsToggleInput.checked = this.getThoughtsVisible();
    if (this._dom.ttsInput) this._dom.ttsInput.checked = getTtsEnabled();
    if (this._dom.spriteInput) this._dom.spriteInput.checked = getSpriteVisible();
    if (this._dom.speedInput) {
      this._dom.speedInput.value = String(MOUTH_FLAP_MIN + MOUTH_FLAP_MAX - getMouthFlapMs());
    }
    if (this._dom.blinkInput) {
      this._dom.blinkInput.value = String(BLINK_BASE_MIN + BLINK_BASE_MAX - getBlinkBaseMs());
    }
    if (this._dom.modelInputs) {
      this._syncModelControls(this.getCurrentModel());
      this._setDdOpen(false); // 開面板＝下拉收乾淨（不留上次的展開態）
      if (this._dom.modelNote) tEl(this._dom.modelNote, "settings.modelHint");
    }
    this._refreshTtsUsage();
  }

  /**
   * 撈語音錢包儀表。唯讀 GET；任何失敗（沒配端點／404／網路錯）
   * ＝整行 hidden——寧可不顯示也不顯示過期或假的數字。開面板才撈（_refresh 唯一
   * 呼叫點），平時零流量。
   */
  async _refreshTtsUsage() {
    const line = this._dom.ttsUsageLine;
    if (!line) return;
    if (!this.ttsUsageEndpoint) {
      line.hidden = true;
      return;
    }
    try {
      const res = await fetch(this.ttsUsageEndpoint, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const u = await res.json();
      const fmt = (n) => Number(n || 0).toLocaleString("en-US");
      // 純 t()（非 tEl）：這行每次開面板都重新撈＋重新格式化數字，本來就不是
      // 「建構一次、之後跟語系走」的靜態文字——語系若在面板開著時被切走，
      // 下次開面板重新撈的那一刻自然會用新語系重新組字串（同它本來就有的
      // 「數字只在開面板時更新」特性一致，不算新的落後）。
      line.textContent = t("settings.ttsUsage", {
        today: fmt(u.today_chars),
        cap: fmt(u.daily_cap),
        month: fmt(Math.round(u.month_ntd || 0)),
        total: fmt(Math.round(u.total_ntd || 0)),
        usd: (Number(u.total_usd || 0)).toFixed(2),
      });
      line.hidden = false;
    } catch (e) {
      line.hidden = true;
    }
  }

  _buildDom() {
    const panel = document.createElement("div");
    panel.className = "settings-panel";
    panel.hidden = true;
    // 點暗幕（sheet 外）＝關閉（比小叉叉直覺）。右上叉叉退役——點選項以外
    // 任何位置即關，這是唯一也是夠用的關法。
    // 只認 e.target === panel——點到 sheet 內任何元素 target 都不是 panel，不誤關。
    panel.addEventListener("click", (e) => {
      if (e.target === panel) this.close();
    });

    // 素材框容器：heading＋body 包進 .settings-sheet——
    // 有素材皮（body.has-ui-skin）時 layout.css 給它上直立玻璃框
    // （settings-frame），無皮時 sheet 是純排版容器、外觀不變。
    const sheet = document.createElement("div");
    sheet.className = "settings-sheet";
    panel.appendChild(sheet);

    const heading = document.createElement("h2");
    heading.className = "settings-heading";
    tEl(heading, "settings.title");
    sheet.appendChild(heading);

    const body = document.createElement("div");
    body.className = "settings-panel-body";

    // 語言列：整個設定面板最前面的第一列，不受任何 config 旗標限制——沙盒／
    // 模型／Thinking 都是「後端有配才出現」，語言選擇是殼本身固有的能力，
    // 永遠都在。控制項沿用模型下拉的結構（trigger 按鈕＋chevron＋自刻
    // listbox），抽成 `_buildDropdownRow` 通用建構；模型下拉暫不改走它——
    // 它多了「桌機 radio／手機 dropdown 雙軌」的既有邏輯，牽動
    // `_setDdOpen`／`_syncModelControls` 兩支既有方法與一串既有測試，不值得
    // 為了 DRY 冒風險去動它；語言列選項少且不分桌機手機，結構卻是同一套
    // 「trigger+listbox」語彙，抽出來的這支之後可以直接給下一顆「只需要簡單
    // 下拉」的設定共用。
    const langOptions = localeOptions().map((opt) =>
      opt.value === "auto" ? { value: opt.value, label: opt.label, i18nKey: "settings.langAuto" } : opt,
    );
    const langRow = this._buildDropdownRow({
      label: "settings.lang",
      options: langOptions,
      current: getStoredChoice(),
      onChange: (v) => setLocale(v),
      dataSetting: "lang",
    });
    body.appendChild(langRow.row);
    // 換語系後重排三個選項的文字與勾選狀態；訂閱一次到底（同模型下拉的
    // document click／keydown listener 慣例——本檔目前沒有任何控制項的
    // 生命週期會主動取消訂閱，面板隨頁面存活，不另外處理 unsubscribe）。
    onLocaleChange(() => {
      this._syncLangRow();
      this._renderUpdateResult(); // 已查到的「檢查更新」結果跟著新語系重新渲染（見 _renderUpdateResult 說明）
    });

    // 沙盒測試模式：sandboxAvailable 沒給（config 缺鍵／後端 flag
    // 未開）＝整列不出現，開源殼零成本（同 modelOptions 既有慣例）。放最頂——
    // 比模型切換更上位的開關。關閉需要 confirm（沙盒內容會被銷毀）；開啟不用。
    // checkbox 殼直接重用 _buildToggleRow（同「顯示立繪」列的 <label> 開關
    // markup 慣例），只是 onChange 這裡是客製流程：
    // 取消／失敗都要把 checkbox 撥回切之前的狀態，不能讓畫面看起來像切成功了
    // 但其實沒有（同 _switchModel 的既有誠實原則）。
    let sandboxRow = null;
    if (this.sandboxAvailable) {
      sandboxRow = this._buildToggleRow({
        // 「沙盒模式」（sandbox 本義＝隔離遊樂場、
        // 玩完不留痕＝語意精準；下方 note 一行補白話語意）。
        label: "settings.sandbox",
        checked: this.getSandboxOn(),
        onChange: (checked) => {
          // 確認窗改自刻 confirmDialog（系統窗醜＋露網域；async 化，
          // 取消／失敗撥回的誠實原則照舊）。
          const apply = () => {
            if (!this.onSandboxChange) return;
            Promise.resolve(this.onSandboxChange(checked)).catch(() => {
              sandboxRow.input.checked = !checked; // 失敗＝撥回切之前的狀態
            });
          };
          if (!checked) {
            confirmDialog(t("settings.sandboxOffConfirm")).then((ok) => {
              if (!ok) {
                sandboxRow.input.checked = true; // 取消＝撥回開著
                return;
              }
              apply();
            });
            return;
          }
          apply();
        },
      });
      body.appendChild(sandboxRow.row);
      const sandboxNote = document.createElement("div");
      sandboxNote.className = "settings-note";
      tEl(sandboxNote, "settings.sandboxHint");
      body.appendChild(sandboxNote);
    }

    // 模型切換區（config 配了 models 才出現；沙盒列之下）：radio 群組＋狀態
    // note。切換走 POST modelEndpoint；引擎端點未就緒（404 等）＝radio 還原
    // ＋誠實報「尚未支援」（見 _switchModel）。用區域變數收集、尾端一併塞進
    // this._dom（那裡是整物件重新賦值——直接在這裡寫 this._dom.x 會被蓋掉）。
    let modelInputs = null;
    let modelNoteEl = null;
    let modelDd = null;
    if (this.modelOptions) {
      const modelHeading = document.createElement("div");
      modelHeading.className = "settings-row";
      const modelLabel = document.createElement("label");
      tEl(modelLabel, "settings.model");
      modelHeading.appendChild(modelLabel);
      body.appendChild(modelHeading);

      const group = document.createElement("div");
      group.className = "settings-model-group";
      const radioName = nextId("setting-model");
      const inputs = [];
      for (const opt of this.modelOptions) {
        if (!opt || typeof opt.id !== "string") continue;
        const optId = nextId("setting-model-opt");
        const wrap = document.createElement("label");
        wrap.className = "settings-model-option";
        wrap.setAttribute("for", optId);
        const input = document.createElement("input");
        input.type = "radio";
        input.name = radioName;
        input.id = optId;
        input.value = opt.id;
        input.addEventListener("change", () => this._switchModel(opt.id));
        const span = document.createElement("span");
        span.textContent = typeof opt.label === "string" && opt.label ? opt.label : opt.id;
        wrap.appendChild(input);
        wrap.appendChild(span);
        group.appendChild(wrap);
        inputs.push(input);
      }
      body.appendChild(group);

      // 手機版下拉選單（radio 排整列太佔空間；桌機維持 radio）。
      // 原生 <select> 的展開清單吃不到 CSS（藍選中條＋系統白底不搭；iOS 更是
      // 整個系統滾輪）——改自刻 dropdown，樣式對齊 MENU 浮層
      // （#cmd-pop 族：veil 玻璃底＋--line-2 邊框＋圓角矩形清單＋hover 變底色），
      // 全部吃主題 token＝五套主題自動跟色。同一份 modelOptions 渲染、change 同
      // 走 _switchModel，_refresh／revert／成功三路由 _syncModelControls 同步
      // radio＋dropdown 兩控件，永不各說各話。日後桌機若也要下拉＝直接拿這顆
      // （media 分流放行即可），不准再碰原生 select。
      const dd = document.createElement("div");
      dd.className = "settings-model-dd";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "settings-model-dd-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      const triggerLabel = document.createElement("span");
      triggerLabel.className = "settings-model-dd-label";
      trigger.appendChild(triggerLabel);
      const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chevron.setAttribute("viewBox", "0 0 24 24");
      chevron.setAttribute("fill", "none");
      chevron.setAttribute("stroke", "currentColor");
      chevron.setAttribute("stroke-width", "2");
      chevron.setAttribute("stroke-linecap", "round");
      chevron.setAttribute("stroke-linejoin", "round");
      chevron.setAttribute("aria-hidden", "true");
      chevron.classList.add("settings-model-dd-chevron");
      const chevPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      chevPath.setAttribute("d", "m6 9 6 6 6-6");
      chevron.appendChild(chevPath);
      trigger.appendChild(chevron);
      dd.appendChild(trigger);

      const list = document.createElement("div");
      list.className = "settings-model-dd-list";
      list.setAttribute("role", "listbox");
      list.hidden = true;
      const ddItems = [];
      for (const opt of this.modelOptions) {
        if (!opt || typeof opt.id !== "string") continue;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "settings-model-dd-item";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", "false");
        item.dataset.modelId = opt.id;
        item.textContent = typeof opt.label === "string" && opt.label ? opt.label : opt.id;
        item.addEventListener("click", () => {
          this._setDdOpen(false);
          this._switchModel(opt.id);
        });
        list.appendChild(item);
        ddItems.push(item);
      }
      dd.appendChild(list);
      body.appendChild(dd);

      trigger.addEventListener("click", () => {
        this._setDdOpen(list.hidden); // hidden＝目前收著→開；反之收
      });
      // 點 dropdown 以外任何位置＝收清單（含面板暗幕；capture 在 document 層，
      // 面板本身的「點暗幕關面板」不受影響——清單先收、面板該關照關）。
      document.addEventListener("click", (e) => {
        if (!list.hidden && !dd.contains(e.target)) this._setDdOpen(false);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !list.hidden) this._setDdOpen(false);
      });

      const modelNote = document.createElement("p");
      modelNote.className = "settings-note settings-model-note";
      tEl(modelNote, "settings.modelHint");
      body.appendChild(modelNote);
      modelInputs = inputs;
      modelNoteEl = modelNote;
      modelDd = { trigger, triggerLabel, list, items: ddItems };
    }

    // Thinking 開關（第三列＝沙盒→模型之後、語音朗讀之前）：
    // thoughtsToggleAvailable 沒給（config 缺鍵／後端 flag 未開）＝整列不出現
    // （開源殼零成本）。checkbox 殼重用 _buildToggleRow；onChange 失敗撥回
    // checkbox（同沙盒誠實原則）——切換不需 confirm 窗（無銷毀語意，隨時可逆）。
    let thoughtsToggleRow = null;
    if (this.thoughtsToggleAvailable) {
      thoughtsToggleRow = this._buildToggleRow({
        label: "settings.thoughts",
        checked: this.getThoughtsVisible(),
        onChange: (checked) => {
          if (!this.onThoughtsVisibleChange) return;
          Promise.resolve(this.onThoughtsVisibleChange(checked)).catch(() => {
            thoughtsToggleRow.input.checked = !checked; // 失敗＝撥回切之前的狀態
          });
        },
      });
      body.appendChild(thoughtsToggleRow.row);
      const thoughtsToggleNote = document.createElement("div");
      thoughtsToggleNote.className = "settings-note";
      tEl(thoughtsToggleNote, "settings.thoughtsHint");
      body.appendChild(thoughtsToggleNote);
    }

    const ttsRow = this._buildToggleRow({
      label: "settings.tts",
      checked: getTtsEnabled(),
      onChange: (checked) => setTtsEnabled(checked),
    });
    body.appendChild(ttsRow.row);
    // 語音錢包儀表：今日分子分母＋本月／開站累計估算費用。
    // 開面板時 _refresh 撈一次（唯讀端點）；config 沒配端點／端點 404／撈失敗
    // ＝整行保持 hidden，絕不顯示假數字（數據真實性：帳本真值或不顯示，二選一）。
    const ttsUsageLine = document.createElement("p");
    ttsUsageLine.className = "settings-note settings-tts-usage";
    ttsUsageLine.hidden = true;
    body.appendChild(ttsUsageLine);

    const spriteRow = this._buildToggleRow({
      label: "settings.sprite",
      checked: getSpriteVisible(),
      onChange: (checked) => {
        applySpriteVisible(checked);
        if (this.onSpriteVisibleChange) this.onSpriteVisibleChange(checked);
      },
    });
    body.appendChild(spriteRow.row);

    // 眨眼頻率拉桿（比照嘴型、放嘴型上方）。同款左慢右快鏡射——
    // slider 值＝(MIN+MAX)−基準間隔（間隔 ms 越小眨得越勤）。獨立 class
    // settings-blink-slider（tour.js 以 .settings-speed-slider 抓嘴型拉桿演示，
    // 共用 class 會讓它抓錯顆）。
    const blinkRow = document.createElement("div");
    blinkRow.className = "settings-row";
    const blinkLabelEl = document.createElement("label");
    const blinkId = nextId("setting-blink-speed");
    blinkLabelEl.setAttribute("for", blinkId);
    tEl(blinkLabelEl, "settings.blink");
    blinkRow.appendChild(blinkLabelEl);
    const blinkWrap = document.createElement("div");
    blinkWrap.className = "settings-speed-wrap";
    const blinkSlowTag = document.createElement("span");
    blinkSlowTag.className = "settings-speed-tag";
    tEl(blinkSlowTag, "settings.slow");
    const blinkInput = document.createElement("input");
    blinkInput.type = "range";
    blinkInput.id = blinkId;
    blinkInput.className = "settings-blink-slider";
    blinkInput.min = String(BLINK_BASE_MIN);
    blinkInput.max = String(BLINK_BASE_MAX);
    blinkInput.step = "250";
    blinkInput.value = String(BLINK_BASE_MIN + BLINK_BASE_MAX - getBlinkBaseMs());
    const blinkFastTag = document.createElement("span");
    blinkFastTag.className = "settings-speed-tag";
    tEl(blinkFastTag, "settings.fast");
    blinkInput.addEventListener("input", () => {
      const baseMs = BLINK_BASE_MIN + BLINK_BASE_MAX - Number(blinkInput.value);
      setBlinkBaseMs(baseMs);
      if (this.onBlinkSpeedChange) this.onBlinkSpeedChange(baseMs);
    });
    blinkWrap.appendChild(blinkSlowTag);
    blinkWrap.appendChild(blinkInput);
    blinkWrap.appendChild(blinkFastTag);
    blinkRow.appendChild(blinkWrap);
    body.appendChild(blinkRow);
    const blinkNote = document.createElement("p");
    blinkNote.className = "settings-note";
    tEl(blinkNote, "settings.blinkHint");
    body.appendChild(blinkNote);

    // 嘴型速度拉桿（range 給定、速度使用者自己調）。方向照直覺
    // 左慢右快——slider 值＝(MIN+MAX)−拍速 的鏡射（拍速 ms 越小嘴越快）。
    const speedRow = document.createElement("div");
    speedRow.className = "settings-row";
    const speedLabelEl = document.createElement("label");
    const speedId = nextId("setting-mouth-speed");
    speedLabelEl.setAttribute("for", speedId);
    tEl(speedLabelEl, "settings.mouth");
    speedRow.appendChild(speedLabelEl);
    const speedWrap = document.createElement("div");
    speedWrap.className = "settings-speed-wrap";
    const slowTag = document.createElement("span");
    slowTag.className = "settings-speed-tag";
    tEl(slowTag, "settings.slow");
    const speedInput = document.createElement("input");
    speedInput.type = "range";
    speedInput.id = speedId;
    speedInput.className = "settings-speed-slider";
    speedInput.min = String(MOUTH_FLAP_MIN);
    speedInput.max = String(MOUTH_FLAP_MAX);
    speedInput.step = "5";
    speedInput.value = String(MOUTH_FLAP_MIN + MOUTH_FLAP_MAX - getMouthFlapMs());
    const fastTag = document.createElement("span");
    fastTag.className = "settings-speed-tag";
    tEl(fastTag, "settings.fast");
    speedInput.addEventListener("input", () => {
      const flapMs = MOUTH_FLAP_MIN + MOUTH_FLAP_MAX - Number(speedInput.value);
      setMouthFlapMs(flapMs);
      if (this.onMouthSpeedChange) this.onMouthSpeedChange(flapMs);
    });
    speedWrap.appendChild(slowTag);
    speedWrap.appendChild(speedInput);
    speedWrap.appendChild(fastTag);
    speedRow.appendChild(speedWrap);
    body.appendChild(speedRow);
    const speedNote = document.createElement("p");
    speedNote.className = "settings-note";
    tEl(speedNote, "settings.mouthHint");
    body.appendChild(speedNote);

    // 版本與更新：版本號吃 version.js 單一真相（純本地、零請求）；「檢查
    // 更新」只在點擊當下查一次 GitHub 公開 API，三態結果（有新版／已最新／
    // 無法檢查）落 aria-live 結果行，失敗不絆任何功能。
    const verRow = document.createElement("div");
    verRow.className = "settings-row";
    const verLabel = document.createElement("span");
    verLabel.className = "settings-version";
    verLabel.textContent = "EverOtome v" + VERSION;
    verRow.appendChild(verLabel);
    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "settings-check-update";
    tEl(checkBtn, "settings.checkUpdate");
    checkBtn.addEventListener("click", () => this._checkUpdate());
    verRow.appendChild(checkBtn);
    body.appendChild(verRow);
    const updateNote = document.createElement("p");
    updateNote.className = "settings-note";
    tEl(updateNote, "settings.updateNote");
    body.appendChild(updateNote);
    const updateResult = document.createElement("p");
    updateResult.className = "settings-note settings-update-result";
    updateResult.setAttribute("aria-live", "polite");
    body.appendChild(updateResult);
    // 結果來自共用模組（update-check.js）的狀態，不是本面板私有——首頁版本列
    // （version-chip.js）查一次，這裡也要跟著顯示同一份結果，反之亦然。訂閱一次到底
    // ＝面板只建一次、不會被重建（同上方 onLocaleChange 訂閱同一套慣例，見下方
    // 「這兩顆 document 監聽」那段既有說明），這裡不另外處理 unsubscribe。
    onUpdateState(() => this._renderUpdateResult());

    sheet.appendChild(body);
    this.container.appendChild(panel);
    // 存住每個控制項的 input／數值標籤參照——`_refresh()` 要靠這些參照把持久化的
    // 當下值套回顯示，不是只在建構當下讀一次就再也不管（見上方 `_refresh` 說明）。
    this._dom = {
      panel,
      body,
      langDd: langRow,
      sandboxInput: sandboxRow ? sandboxRow.input : null,
      thoughtsToggleInput: thoughtsToggleRow ? thoughtsToggleRow.input : null,
      ttsInput: ttsRow.input,
      ttsUsageLine,
      spriteInput: spriteRow.input,
      speedInput,
      blinkInput,
      modelInputs,
      modelDd,
      modelNote: modelNoteEl,
      checkUpdateBtn: checkBtn,
      updateResult,
    };
    // 面板可能在首頁那顆「檢查更新」查過之後才第一次建立：建好當下就把共用狀態裡
    // 現有的結果畫上，不然要等下一次狀態變化才會出現（首頁查→開設定頁＝空行）。
    this._renderUpdateResult();
  }

  /** 「檢查更新」：只由設定頁按鈕觸發。實際查詢／比對／三態判斷全部搬進共用模組
   * `update-check.js`（`checkForUpdate()`，首頁版本列 version-chip.js 共用同一份）；
   * 本檔只剩「查詢中鎖鈕」這一件私有職責。結果不是這裡直接寫，`checkForUpdate()`
   * 開始與結束都會把結果寫進共用狀態並通知訂閱者，`_renderUpdateResult()` 已經訂閱
   * 了那份狀態（見 `_buildDom` 的 `onUpdateState` 呼叫），會自動被叫到、不必在這裡
   * 手動呼叫。 */
  async _checkUpdate() {
    const btn = this._dom.checkUpdateBtn;
    if (btn.disabled) return; // 查詢中不收第二單
    btn.disabled = true;
    await checkForUpdate();
    btn.disabled = false;
  }

  /** 「檢查更新」結果行的唯一渲染入口：只讀共用模組的 `getUpdateState()`，不重新
   * fetch。`checkForUpdate()` 查完會通知訂閱者（見 `_buildDom` 的 `onUpdateState`）；
   * `onLocaleChange` 訂閱也呼叫一次——換語系時已經查到的結果（有新版／已最新／
   * 查詢失敗）跟著用新語系重新組字串。沒有狀態（尚未查過、或查詢中先清一次）＝
   * 清空這一行。 */
  _renderUpdateResult() {
    const line = this._dom.updateResult;
    if (!line) return;
    const state = getUpdateState();
    line.textContent = "";
    if (!state) return;
    if (state.kind === "latest") {
      line.textContent = t("settings.updateLatest");
    } else if (state.kind === "found") {
      line.textContent = t("settings.updateFound", { tag: state.tag }) + " ";
      const a = document.createElement("a");
      a.href = state.href;
      a.target = "_blank";
      a.rel = "noopener";
      tEl(a, "settings.updateView");
      line.appendChild(a);
    } else if (state.kind === "failed") {
      line.textContent = t("settings.updateFailed") + " ";
      line.appendChild(buildFeedbackLink()); // 跟 Chat Log 表頭共用同一份建構式（見 feedback.js）
    }
  }

  /**
   * 通用下拉列建構：`<div class="settings-row" data-setting>` 包 `<label>` ＋
   * 自刻 trigger／chevron／listbox（原生 `<select>` 展開清單吃不到 CSS，同
   * 模型下拉退役原生 select 的既有理由）。目前唯一呼叫端是語言列；`options`
   * 每項 `{value, label, i18nKey?}`——有 `i18nKey` 的項用 `tEl` 標記（跟語系
   * 走，`applyDom` 會自動重譯），沒有的項是固定字串（如語言選項裡的
   * 「繁體中文」「English」——語言的原生名字不隨目前語系翻譯）。回傳的
   * `sync(value)`／`setOpen(open)` 給呼叫端自己保管，之後要重新對齊目前選中
   * 值、或收合清單時呼叫（本檔的 `_syncLangRow`／`_refresh` 就是包這兩支）。
   */
  _buildDropdownRow({ label, options, current, onChange, dataSetting }) {
    const row = document.createElement("div");
    row.className = "settings-row";
    if (dataSetting) row.dataset.setting = dataSetting;

    // id 給 dataSetting 派生（呼叫端已經傳、用來認列——目前唯一呼叫端是語言列
    // dataSetting="lang"）：<label> 沒有原生表單控制項可 for（trigger 是
    // <button> 不是 <input>），讀屏靠 aria-labelledby 把 label 文字＋trigger
    // 現值兩顆節點兜成一句（如「Language English」），不然 trigger 只會念出
    // 現值、漏掉這是在選什麼。
    const rowKey = dataSetting || "dd";
    const labelEl = document.createElement("label");
    labelEl.id = `settings-dd-label-${rowKey}`;
    tEl(labelEl, label);
    row.appendChild(labelEl);

    const dd = document.createElement("div");
    dd.className = "settings-dd";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = `settings-dd-trigger-${rowKey}`;
    trigger.className = "settings-dd-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-labelledby", `${labelEl.id} ${trigger.id}`);
    const triggerLabel = document.createElement("span");
    triggerLabel.className = "settings-dd-label";
    trigger.appendChild(triggerLabel);
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 24 24");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("stroke", "currentColor");
    chevron.setAttribute("stroke-width", "2");
    chevron.setAttribute("stroke-linecap", "round");
    chevron.setAttribute("stroke-linejoin", "round");
    chevron.setAttribute("aria-hidden", "true");
    chevron.classList.add("settings-dd-chevron");
    const chevPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    chevPath.setAttribute("d", "m6 9 6 6 6-6");
    chevron.appendChild(chevPath);
    trigger.appendChild(chevron);
    dd.appendChild(trigger);

    const list = document.createElement("div");
    list.className = "settings-dd-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    const setOpen = (open) => {
      list.hidden = !open;
      trigger.setAttribute("aria-expanded", String(!!open));
      trigger.classList.toggle("is-open", !!open);
    };

    const items = [];
    for (const opt of options) {
      if (!opt || typeof opt.value !== "string") continue;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "settings-dd-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      item.dataset.value = opt.value;
      if (opt.i18nKey) tEl(item, opt.i18nKey);
      else item.textContent = opt.label;
      item.addEventListener("click", () => {
        setOpen(false);
        onChange(opt.value);
        // 直接對齊剛剛選的值——不能只靠下面 onLocaleChange／emit() 那條線：
        // i18n.js 的 commit() 在「目標值解回的語系＝目前已生效的語系」時會
        // 提早 return、不觸發 emit()（例如目前是 en、又點了 auto、瀏覽器語言
        // 剛好也是 en）。這種情況 setLocale 仍可能真的改了 storage（auto 會
        // 清掉），只是「目前生效的語系」沒變──row 的勾選狀態跟 trigger 文字
        // 必須反映「使用者選了什麼」，不能卡在 emit 有沒有發生，click 當下
        // 就要自己 sync 一次（同 _switchModel 成功後直接呼叫
        // _syncModelControls(id) 的既有慣例，不繞道等通知）。
        sync(opt.value);
      });
      list.appendChild(item);
      items.push(item);
    }
    dd.appendChild(list);
    row.appendChild(dd);

    trigger.addEventListener("click", () => setOpen(list.hidden));
    // 點 dropdown 以外任何位置＝收清單：掛在 document 上、bubble 階段（沒有
    // 傳 capture 旗標——冒泡到 document 這一刻 e.target 早就定案，dd.contains()
    // 判斷不需要搶在 capture 階段攔截，bubble 階段一樣抓得到）；面板本身的
    // 「點暗幕關面板」只認 e.target===panel，不受影響。
    // 這兩顆 document 監聽＋上方 onLocaleChange 訂閱（見 :343）目前活整個分頁
    // 生命週期沒問題——SettingsPanel 只建一次，之後只切 hidden、不重建。若哪天
    // 面板改成會被重建（而非單純 toggle），這裡要補一支 destroy()：兩個監聽
    // removeEventListener＋onLocaleChange 回傳的退訂函式一併呼叫，否則每次
    // 重建都會多疊一份監聽。
    document.addEventListener("click", (e) => {
      if (!list.hidden && !dd.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !list.hidden) setOpen(false);
    });

    const sync = (value) => {
      let matchedText = null;
      for (const item of items) {
        const hit = item.dataset.value === value;
        item.classList.toggle("is-current", hit);
        item.setAttribute("aria-selected", String(hit));
        if (hit) matchedText = item.textContent;
      }
      triggerLabel.textContent = matchedText != null ? matchedText : value || "";
    };
    sync(current);

    return { row, dd, trigger, triggerLabel, list, items, setOpen, sync };
  }

  /** 語言列跟語系走：換語系後重排選項的顯示值＋目前選中的勾選狀態。文字本身
   * 不用在這裡重翻——`auto` 那顆帶 `data-i18n`，`onLocaleChange` 通知之前
   * `applyDom` 已經重譯完，這裡只需要比對 `getStoredChoice()` 重新決定
   * is-current／trigger 文字（顯示的是「使用者選了什麼」，不是目前實際套用
   * 的語系——選了 auto 時兩者可能不同，見 i18n.js `resolveLocale`）。 */
  _syncLangRow() {
    const dd = this._dom.langDd;
    if (!dd) return;
    dd.sync(getStoredChoice());
  }

  /** 自刻下拉開合（手機模型選單）：trigger aria-expanded＋清單 hidden 同步；
   * 開＝掛 is-open（chevron 轉向）。 */
  _setDdOpen(open) {
    const dd = this._dom.modelDd;
    if (!dd) return;
    dd.list.hidden = !open;
    dd.trigger.setAttribute("aria-expanded", String(!!open));
    dd.trigger.classList.toggle("is-open", !!open);
  }

  /** radio＋自刻下拉（trigger 文字／清單當前項）一次同步到指定模型——
   * _refresh／_switchModel 成功／revert 三路共用，永不各說各話。 */
  _syncModelControls(id) {
    (this._dom.modelInputs || []).forEach((input) => {
      input.checked = input.value === id;
    });
    const dd = this._dom.modelDd;
    if (!dd) return;
    let label = null;
    for (const item of dd.items) {
      const hit = item.dataset.modelId === id;
      item.classList.toggle("is-current", hit);
      item.setAttribute("aria-selected", String(hit));
      if (hit) label = item.textContent;
    }
    dd.triggerLabel.textContent = label || (typeof id === "string" && id ? id : "—");
  }

  /**
   * 切換模型：POST modelEndpoint {"model": id}。成功＝onModelChange 通知（app.js
   * 更新左上角顯示）＋note 回預設句；失敗（端點未就緒 404／網路錯／逾時）＝radio
   * 還原成當前值＋note 誠實報錯——絕不假裝切換成功。
   */
  async _switchModel(id) {
    const note = this._dom.modelNote;
    const revert = () => {
      this._syncModelControls(this.getCurrentModel());
    };
    if (!this.modelEndpoint) {
      revert();
      if (note) tEl(note, "settings.modelUnsupported");
      return;
    }
    if (note) tEl(note, "settings.switching");
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let res;
      try {
        res = await fetch(this.modelEndpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: id }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (this.onModelChange) this.onModelChange(id);
      // 兩控件（radio＋手機下拉）對齊到新值——change 只來自其中一顆，另一顆要跟。
      this._syncModelControls(id);
      if (note) tEl(note, "settings.modelHint");
    } catch (e) {
      revert();
      if (note) tEl(note, "settings.modelUnsupported");
    }
  }

  /** Checkbox 偽裝成 pill 開關；純 CSS 視覺，語意仍是原生 checkbox（鍵盤／螢幕報讀器原生可用）。
   * `label` 是 i18n 鍵（不是字面文字）——內部用 `tEl` 標記，換語系時面板自己的文字跟著重譯。 */
  _buildToggleRow({ label, checked, onChange }) {
    const row = document.createElement("div");
    row.className = "settings-row";

    const id = nextId("setting-toggle");
    const labelEl = document.createElement("label");
    labelEl.setAttribute("for", id);
    tEl(labelEl, label);
    row.appendChild(labelEl);

    // 真機實測：開關點不開——track/thumb 兩層裝飾 span 疊在透明 checkbox 上，
    // 點到的是裝飾、不會轉發給 checkbox（程式化 .click() 直打 input 所以測試
    // 照樣全綠、抓不到這個坑）。改用 <label> 包裹＝隱式關聯，點 track/thumb
    // （label 內任何位置）瀏覽器原生轉發 activation 給 checkbox。
    const toggle = document.createElement("label");
    toggle.className = "settings-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = !!checked;
    input.addEventListener("change", () => onChange(input.checked));
    toggle.appendChild(input);

    const track = document.createElement("span");
    track.className = "settings-toggle-track";
    toggle.appendChild(track);

    const thumb = document.createElement("span");
    thumb.className = "settings-toggle-thumb";
    toggle.appendChild(thumb);

    row.appendChild(toggle);
    return { row, input };
  }

}
