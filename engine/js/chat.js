/**
 * chat.js —— 通用 WS 聊天協定客戶端＋frame 渲染。
 *
 * 協定依據：後端實查產出的結論（逐項附 file:line 引註）。三個對本檔設計
 * 影響最大的實查結論：
 *   ① 下行 frame 一律由 `role` 分派（不是 type/speaker）；私聊 frame 沒有 `room` 鍵。
 *   ② `[react:X]`／`[sticker:Y]` 不是獨立 frame type，是嵌在對方回覆 frame 的
 *      `text` 欄裡的純文字標記，本檔負責剝除＋渲染。
 *   ③ 沒有 streaming 分段、沒有 keepalive/ping frame——回覆一到就是完整的。
 *
 * 命名鐵則：本檔零角色專屬字樣（開源分離規範）——對方回覆用 "reply"、使用者自己
 * 送出的訊息用 "sent"，這兩個字串在 CSS class／函式名／本地偽 role 裡全部通用；
 * 唯一允許出現角色協定字面值的地方是下面 switch 對 `role` 的比對本身（那是後端
 * 真的會送過來的 wire literal，不是本檔取的名字），每處都標了「protocol literal,
 * not branding」。
 *
 * ChatClient 的重連策略（3s 固定退避＋世代計數）是刻意的設計決策，比
 * 常見前端的重連機制（指數退避、無世代計數）更嚴格，不是協定探查發現。
 *
 * `loadHistory`／`renderHistory`——/api/history 回填，重用
 * 上面同一個 `renderFrame` 管線渲染（marker 剝除／XSS 紀律不重寫第二套）。刻意跟
 * `ChatClient.onFrame` 那條即時 WS 路徑完全分開的呼叫鏈：本檔整份從頭到尾不 import
 * tts.js，歷史訊息在架構上就摸不到 `TtsSpeaker.speak`——這是路徑分離，不是靠旗標擋。
 */
import { t, tAttr } from "./i18n.js";
import { logWarn } from "./feedback.js";

const RECONNECT_DELAY_MS = 3000;

// 逐行顯現（長訊息像即時通訊軟體一行一行到、從第一行讀起，不再整包跳底）。
// 只作用於「即時 WS 到達的多行回覆」；歷史回填（frame.instant）／單行訊息／
// prefers-reduced-motion 一律整包直貼（舊行為）。行間隔對長訊息自動縮短：
// 總展開時間以 REVEAL_TOTAL_CAP_MS 封頂，單行間隔floor REVEAL_MIN_MS——
// 40 行的長信不會拖 18 秒才展完。export 供測試鎖行為（調速免同步改測試）。
export const REVEAL_LINE_MS = 450;
export const REVEAL_TOTAL_CAP_MS = 6000;
export const REVEAL_MIN_MS = 150;

/** 尊重系統「減少動態效果」設定（jsdom 無 matchMedia → false，測試走 reveal 路徑）。 */
function _prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// [react:X]：X＝1-8 個非 "]"/空白字元（通常是一個 emoji）。
// 行首錨定刻意保留——後端以同樣的行首錨定規則解析，
// 兩端對「什麼算 react 標記」的語意必須一致，前端不得單方面放寬。
const REACT_RE = /^\[react:\s*([^\]\s]{1,8})\s*\]\s*/;
// [sticker:Y]：Y＝1-24 字元標籤；約定標準位置在句首，句尾是容錯。
const STICKER_HEAD_RE = /^\[sticker:\s*([^\]]{1,24}?)\s*\]\s*/;
const STICKER_TAIL_RE = /\s*\[sticker:\s*([^\]]{1,24}?)\s*\]\s*$/;
// 全文保底（實測命中）：[intimate:open] 這類引擎狀態標記佔住行首時，
// 後面的 [sticker:] 就錨不到行首＝兩個標記一起裸奔上屏。保底規則全文掃、
// 位置無關，一律剝乾淨（對齊後端同款的全文剝除慣例）。
const STICKER_ANY_RE = /\s*\[sticker:\s*([^\]]{1,24}?)\s*\]\s*/;
// [intimate:*]：切換 intimate 狀態的引擎狀態標記家族（[intimate:open] 等）——
// 純機器訊號，永不顯示；標籤靜默丟棄（狀態切換機制屬 backend／CG 範圍，非顯示層）。
const INTIMATE_RE = /\s*\[intimate:\s*[^\]]{0,24}\s*\]\s*/g;
// [cg:X]：角色的換景暗號——純機器訊號，永不顯示；位置無關
// 全文剝（INTIMATE_RE 同族）。場景切換由 server 掃描＋cg_state frame 通知，
// 前端剝除只管「不裸奔上屏」。export＝供 cg.js／測試直接核對同一顆 regex。
export const CG_ANY_RE = /\s*\[cg:\s*[^\]]{1,32}\s*\]\s*/g;
// 房間暗號三族（[theme:]／[outfit:]／[furniture:]）：換裝／換景由後端掃描暗號
// ＋推 room_state frame 通知（cg_state 同款分工），殼只負責顯示衛生——恆剝、
// 不掛 flag、殘標記永不裸奔上屏；值由後端定義（殼不解讀內容）。
export const ROOM_MARKER_RE = /\s*\[(?:theme|outfit|furniture):[^\]]{1,40}\]\s*/gi;

// [blush]／[blush:deep]：角色的臉紅暗號——與 [cg:] 同族：位置無關全文剝、永不上屏。
// 與 CG 不同處＝**純前端事件**：臉紅是一陣的（transient、F5 不還原），不走 server
// state；stripMarkers 剝除時順手抽出級別（blushLevel），app.js 在 final reply 觸發
// 暈層。帳本存原文含標記＝歷史回填照樣被本 RE 剝乾淨（CG 同款紀律）。
// 剝除寬鬆、級別解析嚴格（與 EXPR_ANY_RE 同一紀律）：級別位吃 [^\]]{0,40}，後端輸出
// [blush:很紅] 這種不合法級別字時照樣剝乾淨（嚴格版會漏剝＝暗號裸奔上屏）；級別由下面
// BLUSH_LEVEL_RE 另外嚴格解析，抽不到＝null。
// 收尾的 \s* 刻意保留（`\s*\]`）：無級別位的 [blush ]（] 前有空白）也要剝得掉，放寬不可退化。
export const BLUSH_ANY_RE = /\s*\[blush(?::[^\]]{0,40})?\s*\]\s*/gi;
// 級別解析（非剝除用）：抓有無 deep——多顆取最深（先微紅後大紅＝取大紅）
const BLUSH_LEVEL_RE = /\[blush(?::\s*([a-z]{1,16}))?\s*\]/gi;

// [expr:ID]：角色的表情暗號——[blush] 同族：位置無關全文剝、永不上屏；純前端事件
// （transient、F5 不還原、不走 server state）；stripMarkers 剝除時順手抽 exprId
// （多顆取最後一顆＝這句最終的臉；小寫），app.js 在 final reply show(id)／沒帶就
// release()（每句由角色自己決定帶不帶）。帳本存原文含標記＝歷史回填照樣被本 RE 剝乾淨。
// **剝除寬鬆、抽取嚴格**：兩顆 regex 分工不同，寬嚴刻意不對稱——
//   剝除（EXPR_ANY_RE）：任何 [expr:*] 一律不上屏，同族 CG_ANY_RE／ROOM_MARKER_RE
//     與後端全文寬鬆剝除慣例。後端輸出不合法 id（[expr:笑]／[expr:laugh!]／
//     [expr:laugh 2]／超長 id）時，嚴格版會漏剝＝暗號裸奔上屏。
//   抽取（EXPR_ID_RE）：維持嚴格 id 形狀（小寫英數 - _、1-24 字），非法 id 抽不到
//     ＝exprId null＝app.js 走 release()、表情淡回平靜（安全的預設臉）。
export const EXPR_ANY_RE = /\s*\[expr:[^\]]{0,40}\]\s*/gi;
const EXPR_ID_RE = /\[expr:\s*([a-z0-9_-]{1,24})\s*\]/gi;

// [照片×N]：帳本寫入時的格式（後端格式：`f"[照片×{n}] {text}".rstrip()`）
// ——這是「存檔格式」，不是協定 frame 格式，只會出現在 `/api/history` 回填的文字裡，
// 即時 WS 訊息／app.js 自建的本地 sent frame 從來不會帶這個標記，因此只在
// `renderHistory` 這一條路徑剝除，`renderFrame` 本體（即時渲染）完全不碰它。
const PHOTO_MARKER_RE = /^\[照片×(\d+)\]\s*/;

/** 剝開頭的 [照片×N] 標記；命中回 {count, rest}，否則回 null。歷史回填專用（見上）。 */
function _stripPhotoMarker(text) {
  const m = text.match(PHOTO_MARKER_RE);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  return { count: Number.isFinite(count) ? count : 0, rest: text.slice(m[0].length) };
}

/** WS 客戶端：3s 固定退避重連＋世代計數（防舊連線的殘留 frame 在重連後竄入）。 */
export class ChatClient {
  constructor() {
    this._ws = null;
    this._url = null;
    this._gen = 0;
    this._reconnectTimer = null;
    this._intentionalClose = false;
    this.onFrame = null; // (frame) => void —— 每個下行 JSON frame 呼叫一次
    this.onStatusChange = null; // (status: "connecting"|"open"|"reconnecting"|"closed"|"error") => void
  }

  /** 連線（或重新指定 URL 後重連）。 */
  connect(wsUrl) {
    this._url = wsUrl;
    this._intentionalClose = false;
    this._open();
  }

  send(text) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      // 私聊純文字上行是裸字串，不是 JSON——這裡原樣送出，不包裝。
      this._ws.send(text);
      return true;
    }
    return false;
  }

  /** 主動關閉：不重連、世代立即作廢（任何仍在飛的回呼/計時器都失效）。 */
  close() {
    this._intentionalClose = true;
    this._gen += 1;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch (e) {
        // 已經關閉／連線從沒成功建立過，安全略過。
      }
    }
  }

  _open() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const gen = (this._gen += 1);
    this._setStatus("connecting");

    let ws;
    try {
      ws = new WebSocket(this._url);
    } catch (e) {
      // 環境不支援 WebSocket 建構：靜默、不排重連——這不是「斷線」，是這個環境
      // 本來就不能開 WS。
      this._setStatus("error");
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      if (gen !== this._gen) return; // 世代已過期，這顆 socket 已經被取代
      this._setStatus("open");
    };

    ws.onmessage = (event) => {
      if (gen !== this._gen) return; // 舊連線的殘留訊息——世代計數擋下
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch (e) {
        return; // 下行協定永遠是 JSON；解析失敗視為雜訊，忽略。
      }
      if (this.onFrame) this.onFrame(frame);
    };

    ws.onerror = () => {
      // onerror 後瀏覽器必觸發 onclose，交給 onclose 統一處理重連。
    };

    ws.onclose = () => {
      if (gen !== this._gen) return; // 已被更新世代取代，這顆 socket 的收尾不算數
      if (this._intentionalClose) {
        this._setStatus("closed");
        return;
      }
      this._setStatus("reconnecting");
      this._reconnectTimer = setTimeout(() => this._open(), RECONNECT_DELAY_MS);
    };
  }

  _setStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }
}

/**
 * 把單一下行 frame（或 app.js 自建的本地 role:"sent" 偽 frame，代表使用者自己
 * 剛送出的那句）渲成氣泡 DOM，附加到 listEl 尾端。純 DOM 建構——不掛事件監聽器、
 * 不發網路請求、不修改傳入的 frame 物件本身（呼叫端事後仍可放心把原始 frame.text
 * 交給 TtsSpeaker.speak）。
 *
 * @param {object} frame  下行 JSON frame（或本地 {role:"sent", text}）
 * @param {HTMLElement} listEl  訊息串容器（如 #msgs）
 * @param {{characterName?: string, assetsBase?: string}} [ctx]
 */
// ── 語音重播（句尾紫圓 play 鍵）─────────────────────────
// 帳本 entry 帶 audio（URL 清單）的訊息，在泡泡／System 行尾掛一顆紫圓 play——
// 點了順序連播該句的逐句 mp3（通話台詞＝一輪多句、留言＝單句），再點＝停。
// 模組級單例：同時只有一顆在播（單一聲源精神——角色不會同時用兩張嘴說話）；
// 立繪動嘴／TTS 讓位／voicemail played 回報全部透過 ctx.replayHooks 由 app.js
// 注入（本檔不 import driver/tts/phone，分層同 loadHistory 的 TTS 隔離慣例）：
//   before(): boolean —— 播放前呼叫；回 false＝禁播（如通話中）。app.js 在這裡
//              順手停掉正在唸的聊天 TTS。
//   attach(el)/detach() —— 共用播放元件掛上／卸下 MouthDriver（重溫角色說話＝
//              立繪動嘴，對齊舊留言卡 driver.attach 的招牌場景語意）。
//   onUrl(url) —— 每句開播時回呼（app.js 據此對留言 URL 回報 played）。
const REPLAY_PLAY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const REPLAY_STOP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';

let _replayEl = null;    // 共用 HTMLAudio（lazy；建構失敗＝重播功能靜默缺席）
let _replayBtn = null;   // 正在播的那顆鈕（UI 還原用；null＝沒在播）
let _replayGen = 0;      // 世代 token：停止／換鈕後讓舊 onended/onerror 失效
let _replayHooks = null; // 目前播放批次的 hooks（detach 用）

// iOS 手勢解鎖用的 44-byte 靜音 wav data URI——與 tts.js／phone.js 的
// SILENT_WAV 是同一個常數（同一套純 HTMLMediaElement 手勢優先播放規則的解法，
// 跟 Web Audio API／AudioContext 無關）。三檔各自持有一份避免互相 import
// 造成耦合（見 tts.js 檔頭同款說明）；改動需同步三處。
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** lazy 建立共用 HTMLAudio（見上方 _replayEl 宣告處說明）；建構失敗＝回
 * null，呼叫端（_startReplay／primeReplayEl）各自決定失敗時的靜默收場。鏡照
 * tts.js `TtsSpeaker._ensureAudioEl()` 的既有手法，這裡是 chat.js 側對應的
 * 共用播放元件版本。 */
function _ensureReplayEl() {
  if (!_replayEl) {
    try { _replayEl = new Audio(); } catch (e) { _replayEl = null; }
  }
  return _replayEl;
}

/** 目前是否有句尾 play 在播（app.js 的 TTS getEnabled 讓位判斷用）。 */
export function isReplaying() {
  return _replayBtn !== null;
}

/** iOS 手勢窗口內呼叫（app.js 首次 pointerdown 解鎖處理器裡，跟
 * `MouthDriver.unlock()`／`TtsSpeaker.prime()` 並列同步呼叫，見 app.js 該處
 * 說明）：同步 play() 一段靜音片段解鎖這顆共用播放元件之後的所有播放。這顆
 * 元件被存檔重播（`_buildReplayBtn`）與合成重播（`_buildSynthReplayBtn`）
 * 兩條路徑共用，但兩者的 `play()` 都排在 `_startReplay` 供應器起跑那段
 * `Promise.resolve().then(...)` 之後才真正呼叫（合成路還要先等 `hooks.synth`
 * 這個網路請求）——早就跳出使用者手勢的同步呼叫堆疊。iOS 的手勢優先播放規則
 * 只認「呼叫堆疊仍在使用者手勢事件內」這件事，任何 microtask／await 都會跳出
 * 手勢窗口（同 tts.js 檔頭 89-94 行說明的同一條規則）；沒有這一支，`_replayEl`
 * 從沒被手勢碰過，使用者第一次點句尾 play 鍵時瀏覽器會無聲擋下播放。手法鏡照
 * `TtsSpeaker.prime()`：同步、不 await，`play()` 的 rejection 用 `.catch()`
 * 吞掉——解鎖失敗也無妨，最壞情況只是回到「這句話播不出來」的既有靜默收場
 * （`_stopReplay`），不會拋出未處理例外。 */
export function primeReplayEl() {
  // 正在播放／合成中不解鎖——共用同一顆持久元件，SILENT_WAV 會把飛行中的那句
  // 話從喇叭上擠掉（onended 也會被搶）；isReplaying() 為真＝早就被使用者手勢
  // 解鎖過了，這次 prime 沒有存在必要（鏡照 tts.js prime() 的同款理由）。
  if (isReplaying()) return;
  const el = _ensureReplayEl();
  if (!el) return;
  try {
    el.src = SILENT_WAV;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {
    /* 解鎖失敗也無妨，見上 */
  }
}

function _stopReplay() {
  _replayGen += 1;
  if (_replayEl) {
    try { _replayEl.pause(); } catch (e) { /* 停不下來也無妨，src 會被下一批蓋掉 */ }
  }
  if (_replayHooks && typeof _replayHooks.detach === "function") {
    try { _replayHooks.detach(); } catch (e) { /* detach 失敗不擋 UI 還原 */ }
  }
  _replayHooks = null;
  if (_replayBtn) {
    _replayBtn.classList.remove("playing", "loading");
    _replayBtn.removeAttribute("aria-busy"); // 合成飛行中設的忙碌態，還原時一併摘掉（見 _startReplay）
    _replayBtn.innerHTML = REPLAY_PLAY_SVG;
    tAttr(_replayBtn, "aria-label", "chat.play");
    _replayBtn = null;
  }
}

/** 播放核心（存檔重播與合成重播共用抽出）：存檔重播（電話系 urls 現成）與現場
 * 合成重播（普通聊天句，urls 要先等 hooks.synth）共用同一套單例紀律——同時只有
 * 一顆在播、再點＝停、通話中禁播、動嘴 attach/detach。getUrls＝async 供應器：
 * 存檔版立即 resolve；合成版飛行中按鈕先進「playing＋loading」態（停止形＋
 * 脈動），這段期間再點一下＝取消（世代 token 讓遲到的 URL 直接作廢，不會突然
 * 出聲）。供應器契約：getUrls 必須保證 settle（resolve 或 reject 二選一，不能
 * 永遠掛著）——永不 settle 的供應器會讓按鈕卡在播放態（"playing"／"loading"
 * class 與 aria-busy 都摘不掉）且 isReplaying() 恆真，讓位判斷（app.js 的
 * TTS getEnabled）會誤判成「一直在播」。 */
function _startReplay(btn, hooks, getUrls) {
  if (_replayBtn === btn) { _stopReplay(); return; } // 播放／合成中再點＝停
  if (typeof hooks.before === "function" && hooks.before() === false) return;
  _stopReplay();
  if (!_ensureReplayEl()) return;
  const gen = ++_replayGen;
  _replayBtn = btn;
  _replayHooks = hooks;
  btn.classList.add("playing", "loading");
  // 合成請求飛行中／等待存檔 urls 供應器 settle 的這段期間標成 aria-busy——
  // 螢幕閱讀器會唸出「忙碌中」而不是把按鈕當成已經在播放的停止鍵（兩處摘除見
  // 下方 URL 到手處與 _stopReplay）。存檔重播的供應器同步 resolve、這段忙碌態
  // 只會閃過一個 microtask，無害。
  btn.setAttribute("aria-busy", "true");
  btn.innerHTML = REPLAY_STOP_SVG;
  tAttr(btn, "aria-label", "chat.stop");
  Promise.resolve()
    .then(() => {
      // 供應器起跑前再驗一次世代：點了立刻反悔（同一 tick 內取消）＝連合成請求
      // 都不打——重合成是要記字數帳的，能省就省；起跑後才取消的批次由下一關擋。
      if (gen !== _replayGen) return null;
      return getUrls();
    })
    .then((urls) => {
      if (gen !== _replayGen) return;      // 等合成期間被停掉／換批＝遲到結果作廢
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");    // URL 到手＝不再忙碌（見上方設置處說明）
      const clean = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === "string" && u);
      if (!clean.length) { _stopReplay(); return; } // 合成失敗／空批＝靜默還原按鈕
      if (typeof hooks.attach === "function") {
        try { hooks.attach(_replayEl); } catch (e) { /* 動嘴掛載失敗不擋播放 */ }
      }
      let i = 0;
      const playNext = () => {
        if (gen !== _replayGen) return;    // 已被停止／換批
        if (i >= clean.length) { _stopReplay(); return; }
        const url = clean[i++];
        if (typeof hooks.onUrl === "function") {
          try { hooks.onUrl(url); } catch (e) { /* played 回報失敗不擋播放 */ }
        }
        if (typeof hooks.envelope === "function") {
          // 樂譜制：這句的嘴型譜跟句走（app.js 注入；缺席＝拍嘴照舊）
          try { hooks.envelope(url); } catch (e) { /* 譜缺席不擋播放 */ }
        }
        _replayEl.src = url;
        _replayEl.onended = playNext;
        _replayEl.onerror = playNext;      // 某句檔缺（極舊資料）＝跳下一句
        const p = _replayEl.play();
        if (p && typeof p.catch === "function") {
          p.catch(() => { if (gen === _replayGen) playNext(); });
        }
      };
      playNext();
    })
    .catch(() => { if (gen === _replayGen) _stopReplay(); }); // synth reject＝還原按鈕
}

function _makePlayBtnShell() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-play-btn";
  tAttr(btn, "aria-label", "chat.play");
  btn.innerHTML = REPLAY_PLAY_SVG;
  return btn;
}

function _buildReplayBtn(urls, ctx) {
  const clean = urls.filter((u) => typeof u === "string" && u);
  if (!clean.length) return null;
  const hooks = (ctx && ctx.replayHooks) || {};
  const btn = _makePlayBtnShell();
  btn.addEventListener("click", () => _startReplay(btn, hooks, () => clean));
  return btn;
}

/** 合成重播鍵：沒有存檔的普通聊天句（後端刻意不落檔——電話系才有 archive）也要
 * 能重播，點了現場把泡泡原文送 TTS 端點合成一次來播；同一句同頁面第二次點＝
 * app.js 側 TtsSynthCache 快取直出、不再花錢。hooks.synth 未注入＝依 config
 * 三態閘門判定不該注入（沒配 ttsEndpoint；或兩鍵都配了但開機 probe
 * ttsUsageEndpoint 沒過——只配 ttsEndpoint 沒配 ttsUsageEndpoint 這個中間態
 * 反而不 probe、直接注入，三態細節見 app.js gate 段註解）＝整族不渲染，普通
 * 訊息 DOM 與本功能上線前 byte-identical——同玫瑰鈕的「先 probe 再回填」精神
 * （差別在 probe 是否條件式，見 app.js 該處）。不受「語音朗讀」自動唸開關
 * 限制：那個開關管「回覆時要不要自動出聲」，播放鍵是使用者主動點名要聽這一句。 */
function _buildSynthReplayBtn(text, ctx) {
  const hooks = (ctx && ctx.replayHooks) || {};
  if (typeof hooks.synth !== "function") return null;
  if (typeof text !== "string" || !text.trim()) return null;
  const btn = _makePlayBtnShell();
  // 供應器契約＝「URL 陣列」（與存檔重播同款）；synth 回的是單一 URL 字串
  // （TtsSynthCache.get 的形狀，null＝失敗）——這裡負責包裝，兩邊契約各自單純。
  btn.addEventListener("click", () => _startReplay(btn, hooks, () =>
    Promise.resolve(hooks.synth(text)).then((u) => (u ? [u] : [])),
  ));
  return btn;
}

// ── 玫瑰愛心鈕 ───────────────────────────────────
// 讀到喜歡的一句、按下泡泡旁的愛心＝那則話存進玫瑰相簿；F5 重載後亮過的還亮。
// hooks 未注入（ctx.roseHooks 缺席）＝這顆鈕整族不渲染——app.js 開機先 probe
// 過 /api/v4/rose-flags 才決定要不要注入（見 app.js 該處註解），探不到＝視同
// 後端 flag 關／開源殼，不是本檔要處理的分支，這裡只認 ctx.roseHooks 存不存在。
// ctx.roseHooks = { add(text)→Promise<{saved,id?}>, remove(id)→Promise<bool> }。
//
// canonical 正文＝stripMarkers 剝除後的 text（reply 分支已有現成變數，見下方
// _renderReplyBubble 呼叫處，不二次剝除）。用 WeakMap 存「這顆鈕對應哪句正文」
// 而不是寫進 DOM 屬性——正文可能很長、可能含特殊字元，不必為了一個內部查找鍵
// 汙染 dataset／製造 attribute escaping 的心智負擔；按鈕被回收（GC）時這筆記錄
// 自然一起消失，不必手動清理。
const _roseKeyOf = new WeakMap();

const ROSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>';

/** 點亮／熄滅共用小工具：class／dataset／aria-label 三處狀態一次同步，避免點擊
 * handler 與 markRoseFlags 兩處各自維護一份、將來漂移。aria-label 隨態切換
 * （鏡照 _buildReplayBtn／_stopReplay 對 .msg-play-btn「播放語音」↔「停止播放」
 * 的既有慣例）。 */
function _setRosed(btn, id) {
  btn.classList.add("is-rosed");
  btn.dataset.roseId = String(id);
  tAttr(btn, "aria-label", "chat.roseRemove");
}
function _setUnrosed(btn) {
  btn.classList.remove("is-rosed");
  delete btn.dataset.roseId;
  tAttr(btn, "aria-label", "chat.roseAdd");
}

/** 點擊分派：已亮＝樂觀熄滅＋hooks.remove(id)，resolve false／reject 都回滾點亮
 * （false＝業務性未成功，靜默；reject＝技術性失敗，logWarn）；未亮＝樂觀
 * 點亮＋hooks.add(text)，resolve {saved:true,id} 落 dataset.roseId、
 * {saved:false}（親密模式攔截，非錯誤）靜默回滾、reject 回滾＋logWarn。
 * hooks.add/remove **同步**呼叫（鏡照 _buildReplayBtn 對 hooks.before/attach 的
 * 既有慣例——點下去當下就該觸發，不能因為防禦包裝多等一個 microtask 才真的打
 * 出去）；外面包 try/catch 轉成 rejected promise 餵同一條 `.catch()` rollback／
 * logWarn 路徑——hook 若同步 throw（呼叫端寫壞），例外一樣不會裸奔逃出
 * 事件處理器、把鈕卡死在樂觀態。
 * btn.disabled 包住整段飛行中請求：防連點在 add 還沒 resolve、dataset.roseId
 * 還是 undefined 時就被當「已亮」誤點第二下（Number(undefined) = NaN 會送壞
 * id 給後端）。 */
function _onRoseClick(btn, ctx) {
  const hooks = ctx && ctx.roseHooks;
  if (!hooks || btn.disabled) return;
  btn.disabled = true;
  const done = () => { btn.disabled = false; };
  if (btn.classList.contains("is-rosed")) {
    const id = Number(btn.dataset.roseId);
    _setUnrosed(btn);
    let result;
    try {
      result = typeof hooks.remove === "function" ? hooks.remove(id) : false;
    } catch (e) {
      result = Promise.reject(e);
    }
    Promise.resolve(result)
      .then((ok) => { if (!ok) _setRosed(btn, id); })
      .catch((e) => {
        logWarn("[chat] removing from favorites failed; rolling back to favorited:", e);
        _setRosed(btn, id);
      })
      .finally(done);
  } else {
    const text = _roseKeyOf.get(btn) || "";
    btn.classList.add("is-rosed"); // 樂觀點亮；id 待 resolve 才落，未落前 disabled 擋二次點擊
    tAttr(btn, "aria-label", "chat.roseRemove");
    let result;
    try {
      result = typeof hooks.add === "function" ? hooks.add(text) : { saved: false };
    } catch (e) {
      result = Promise.reject(e);
    }
    Promise.resolve(result)
      .then((res) => {
        if (res && res.saved) _setRosed(btn, res.id);
        else _setUnrosed(btn); // saved:false（親密模式攔截）＝靜默回滾，不是錯誤
      })
      .catch((e) => {
        logWarn("[chat] adding to favorites failed; rolling back:", e);
        _setUnrosed(btn);
      })
      .finally(done);
  }
}

function _buildRoseBtn(text, ctx) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-rose-btn";
  tAttr(btn, "aria-label", "chat.roseAdd");
  btn.innerHTML = ROSE_SVG;
  _roseKeyOf.set(btn, text);
  btn.addEventListener("click", () => _onRoseClick(btn, ctx));
  return btn;
}

/**
 * 玫瑰比對用正規化 key：後端逐句分段時對每段做
 * `.strip()`——句界緊鄰分隔符的空白（半形／全形皆算
 * `\s`）在切句當下就從沒送回前端的 WS frame，資訊在 server 端送出**之前**
 * 就已遺失，前端單側修不掉（跟另一個 bug「內嵌 `\n`」是同一個 bug
 * class 的第二個真觸發條件：真實輸出實測樣本
 * `"...怎麼樣。 工作..."`／`"真的假的！ 我聽到..."`／`"...好久了。　工作
 * 辛苦了。"` 皆證實純串接後跟原文差一個空白，逐字元比對必然失配、亮態假掉；
 * 對照組——句子**中間**、不緊鄰分隔符的連續空格——純串接還原正確，問題
 * 精確限定在「緊鄰分隔符」這個位置，不是泛用的內部空白問題）。
 *
 * 修法：**匹配時正規化、存文不動**——`_roseMatchKey` 只用在 `markRoseFlags`
 * 的比對這一步，`POST /api/v4/rose-flag` 送出的 `text`（`_onRoseClick`／
 * `_buildRoseBtn` 存的 `_roseKeyOf`）與相簿實際存文完全不受影響，維持
 * 逐字元原文——相簿是要進他日記引用的可讀原文，不該存壓扁版。兩條路徑
 * （即時累積 vs F5 回填）的**存文**仍可能有這種空白級外觀差異，這是無害的
 * cosmetic 落差，不是本函式要解決的問題；本函式只解決「點不點得亮」。
 */
function _roseMatchKey(s) {
  return String(s).replace(/\s+/g, "");
}

/**
 * 開機回填：flags＝GET /api/v4/rose-flags 的 `[{id,text}]`（app.js 探測成功後
 * 呼叫，時機＝loadHistory 畫完歷史泡泡之後，見 app.js 該處註解）。掃頁面上每
 * 一顆 `.msg-rose-btn`，用 `_roseKeyOf` 取它的 canonical 正文，跟 flags[].text
 * **正規化後**（`_roseMatchKey`，見上——去除所有空白字元再比對）
 * 相等者點亮＋補 dataset.roseId。用 `document.querySelectorAll`（刻意不吃
 * listEl 參數）——production 只有一個 Chat Log 容器，呼叫端也沒有把容器傳進來
 * 的理由。只加不減（一次性回填語意，不是雙向同步）：`classList.add`／賦值
 * `dataset` 本身是冪等操作，同一批 flags 被呼叫兩次不會疊 class 或壞掉（可
 * 重入）。正規化只放寬「哪些字元不列入比對」，不做子字串／模糊比對——內容
 * 有實質差異（不只是空白）的兩則話，正規化後仍然是不同字串，不會誤點亮。
 * @param {Array<{id:number,text:string}>} flags
 */
export function markRoseFlags(flags) {
  if (!Array.isArray(flags) || !flags.length) return;
  const idByKey = new Map();
  for (const f of flags) {
    if (f && typeof f.text === "string" && typeof f.id !== "undefined") {
      const key = _roseMatchKey(f.text);
      if (key) idByKey.set(key, f.id);
    }
  }
  document.querySelectorAll(".msg-rose-btn").forEach((btn) => {
    const key = _roseKeyOf.get(btn);
    if (typeof key !== "string") return;
    const normalized = _roseMatchKey(key);
    if (normalized && idByKey.has(normalized)) {
      _setRosed(btn, idByKey.get(normalized));
    }
  });
}

export function renderFrame(frame, listEl, ctx = {}) {
  if (!frame || typeof frame !== "object" || !listEl) return;

  // 任何帶 room 鍵的 frame（群組／其他房間）都是本引擎私聊限定
  // 首版故意不渲染的房間系內容——role 本身可能合法，必須在分派 role 之前就先
  // 排除，否則會把房間訊息誤畫進私聊面板。
  if (frame.room) return;

  // 任何非 status
  // 的 frame 抵達，代表「這一輪的沉默結束了」——不管接下來要渲染的是完整回覆、
  // 使用者自己送出的訊息、還是 system 提示，一律先把還留著的思考中指示器收掉，
  // 不需要額外訊號判斷「該不該收」。
  if (frame.role !== "status") _clearStatusLine(listEl);

  switch (frame.role) {
    case "assistant": // protocol literal, not branding —— 後端真的送這個字面值，非本檔命名
      _renderReplyBubble(frame, listEl, ctx);
      break;
    case "sent":
      _renderSentBubble(frame, listEl);
      break;
    case "system":
      _renderSystemLine(frame, listEl, ctx);
      break;
    case "status": // protocol literal, not branding —— per-turn engine 思考中指示器，
      // 只有 role/text 兩個鍵（無 timestamp/thoughts）
      _renderStatusLine(frame, listEl);
      break;
    default:
      // 未知，或已知但故意不處理的 role（call/incoming_call/incoming_call_end，
      // 也涵蓋未來任何新 role）——靜默略過，設計如此。
      // "partial"（邊寫邊送）也落在這裡：partial frame 的分流
      // 責任在 app.js（讀 streamArmed guard、決定要不要進 upsertPartialBubble），
      // 不是 renderFrame 的語意——這裡不加 case，維持「未知 role 靜默略過」不變。
      break;
  }
}

/**
 * 半成品泡泡（邊寫邊送）：partial frame 抵達時，把這一輪
 * 目前累積的完整文字（不是增量）畫成一顆持續更新的泡泡，讓使用者在最終回覆定案前就
 * 看得到他在打字——首次呼叫建立單例 `.row.reply.partial-row`（同 `_renderReplyBubble`
 * 的 `.row.reply` 骨架，多一個 `partial-row` class 供本函式與 `clearPartialBubble`
 * 辨識），之後每次呼叫只更新同一顆泡泡的文字，不疊出第二顆 row。半成品開始＝
 * 「思考中」指示器的使命結束，比照 `renderFrame` 頂部的既有規則呼叫
 * `_clearStatusLine`——**每次呼叫都清**，不只首次建 row 那一下（真實發生過
 * 的時序：使用者雙送訊息，佇列中第二句的 pre-lock status frame
 * 會在第一句的 partial 已經在跑之後才抵達，若只在首次建 row 時清一次，這顆
 * 遲到的「思考中」指示器會卡在半成品泡泡下方，一路留到 final frame 才消失。
 * `_clearStatusLine` 本身冪等（找不到 `.status-line` 就是安全 no-op），每次
 * upsert 多呼叫一次的成本可忽略不計。
 *
 * 顯示層空行壓縮同 `_renderReplyBubble`（連續空行摺成單一換行，只動這裡怎麼演，
 * 資料層不歸它管）；文字走 `.textContent =` 賦值（DOM 規範上等同
 * `createTextNode`＋`appendChild`，同樣不解析 HTML，XSS 紀律不例外）。
 *
 * near-bottom 跟捲同 `_revealLines` 既有慣例（距底 <120px 才跟捲，若往上捲看
 * 舊訊息不搶捲軸）——每次文字更新都可能讓內容變長，因此跟 `_revealLines`
 * 一樣每次呼叫都重新算一次，不是只在建立時算一次。
 *
 * 泡泡的最終命運：final frame 抵達時 app.js 呼叫 `clearPartialBubble` 移除它，
 * 換上 `_renderReplyBubble` 畫的正式泡泡——半成品泡泡從未被寫進帳本／history，
 * 純顯示層的臨時過場。
 *
 * @param {HTMLElement} listEl 訊息串容器（如 #msgs）
 * @param {string} text 這一輪目前累積的完整文字（app.js 已用 stripMarkers 剝除
 *   [react:]/[sticker:] 標記後才傳進來，同 final frame 的剝除邏輯）
 */
export function upsertPartialBubble(listEl, text) {
  if (!listEl) return;
  const displayText = (typeof text === "string" ? text : "").replace(/\n{2,}/g, "\n");
  _clearStatusLine(listEl);                // 半成品開始＝「思考中」結束（每次 upsert 都清，見上方函式說明 M-1）
  let row = listEl.querySelector(".partial-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "row reply partial-row";
    const bubble = document.createElement("div");
    bubble.className = "bubble reply";
    row.appendChild(bubble);
    // 開頭錨定（跟左邊 ADV 一樣「停在一開始等使用者往下捲」）：只在
    // 泡泡誕生這一下近底跟捲一次——此刻泡泡才一行高，捲到底＝使用者看到這則回覆的
    // 開頭。之後每次 upsert 內容變長一律不再追捲，文字往下長、使用者自己捲。
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
    listEl.appendChild(row);
    if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
  }
  const bubble = row.querySelector(".bubble");
  bubble.textContent = displayText;
}

/** 移除半成品泡泡（若有）。冪等——本來就沒有／重複呼叫都是安全的 no-op，呼叫端
 * （app.js 的每個「這輪結束」分支：assistant／system／call 家族）不需要先確認存不存在
 * 就能無腦呼叫，同 `_clearStatusLine` 的既有慣例。 */
export function clearPartialBubble(listEl) {
  if (!listEl) return;
  listEl.querySelectorAll(".partial-row").forEach((el) => el.remove());
}

function _renderReplyBubble(frame, listEl, ctx) {
  const row = document.createElement("div");
  row.className = "row reply";

  const rawText = typeof frame.text === "string" ? frame.text : "";
  const { text, reactEmoji, stickerLabel } = stripMarkers(rawText);

  if (frame.thoughts) {
    row.appendChild(_buildThought(frame.thoughts));
  }

  if (reactEmoji) {
    _attachReact(listEl, reactEmoji);
  }

  // 貼圖渲染已退役（畫面上有完整的全身立繪，不需要表情貼圖）——
  // [sticker:] 標記照剝（stripMarkers）、標籤靜默丟棄，永不畫圖也不佔位提及貼圖。

  let revealing = false;
  if (text) {
    const bubble = document.createElement("div");
    bubble.className = "bubble reply";
    // 顯示層空行壓縮（桌機手機同款）：對方訊息裡的連續空行
    // 摺成單一換行——句與句緊鄰、不再隔一整行。只動泡泡怎麼畫，資料層（帳本／
    // history）一字不動；使用者自己那側（sent）保持原樣。
    const displayText = text.replace(/\n{2,}/g, "\n");
    // 逐行顯現：即時到達的多行回覆一行一行浮出。歷史回填
    // （frame.instant，renderHistory 標）／單行／reduced-motion 整包直貼。
    const lines = displayText.split("\n");
    revealing = !frame.instant && lines.length > 1 && !_prefersReducedMotion();
    if (revealing) {
      _revealLines(bubble, lines, listEl);
    } else {
      bubble.appendChild(document.createTextNode(displayText));
    }
    // 這句有語音（通話台詞的逐句 mp3）→
    // play 鍵放**泡泡外右側**（.bubble-line 橫排：泡泡＋鈕底對齊；
    // 之前掛在泡泡內文字尾）。玫瑰層沿用同一個 .bubble-line
    // 家：play 鈕與玫瑰鈕都是「泡泡外面、跟泡泡同排」的附加物，沒理由分兩套
    // wrapper。只在真的有東西要掛時才建這層（hasAudio || hasRose 任一為真）——
    // 兩者都沒有的最基本情況維持不建 .bubble-line 的舊行為，普通訊息 DOM 與
    // 玫瑰層上線前一字不差（ctx.roseHooks 未注入＝開源殼／後端 flag 關＝零成本，
    // 這裡是那份承諾在 DOM 結構層的體現，不只是「鈕不出現」而已）。
    const hasAudio = Array.isArray(frame.audio) && frame.audio.length;
    // 合成重播：沒存檔的普通聊天句也掛播放鍵——hooks.synth 有注入才成立
    // （依 config 三態閘門判定要不要注入，見 app.js gate 段註解；沒注入＝維持
    // 舊 DOM）。text.trim() 這道檢查與 _buildSynthReplayBtn 自己的同款 guard
    // 對齊（見該函式）：text 是 stripMarkers 的回傳值、已保證非空白即非空
    // 字串，這裡目前可達路徑上加不加都不影響結果，純粹讓兩處判準顯式一致，
    // 避免只有泡泡、沒有鈕可掛的 .bubble-line 空殼（未來 stripMarkers 改動時
    // 兩處判準才不會悄悄分歧）。
    const canSynth = !hasAudio
      && !!(ctx.replayHooks && typeof ctx.replayHooks.synth === "function")
      && !!text.trim();
    const hasRose = !!ctx.roseHooks;
    if (hasAudio || canSynth || hasRose) {
      const line = document.createElement("div");
      line.className = "bubble-line";
      line.appendChild(bubble);
      if (hasAudio) {
        const play = _buildReplayBtn(frame.audio, ctx);
        if (play) line.appendChild(play);
      } else if (canSynth) {
        const play = _buildSynthReplayBtn(text, ctx);
        if (play) line.appendChild(play);
      }
      if (hasRose) {
        line.appendChild(_buildRoseBtn(text, ctx));
      }
      row.appendChild(line);
    } else {
      row.appendChild(bubble);
    }
  } else if (rawText.trim() && row.children.length === 0) {
    // 整輪回覆被標記吃光時（純標記、沒有跟隨文字），原本會因為 row
    // 沒有任何子節點而整列不上屏，等於「對方回了話，畫面卻什麼都沒發生」——TTS
    // 那邊也會因為後端把這些標記淨化成空字串而 204 靜音，兩邊同時無聲，等於整輪
    // 回覆消失。這裡改成淡化的占位泡泡，至少讓看的人知道「發生了什麼」，絕不讓
    // 一輪已送達的回覆整個消失。（貼圖退役後純 [sticker:] 輪也落這裡，佔位字樣
    // 不再提及貼圖——功能已取消，不留概念殘影。）
    const placeholder = document.createElement("div");
    placeholder.className = "bubble reply bubble-placeholder";
    const label = reactEmoji
      ? t("chat.reaction", { emoji: reactEmoji })
      : t("chat.emptyReply");
    placeholder.appendChild(document.createTextNode(label));
    row.appendChild(placeholder);
  }

  if (row.children.length === 0) return; // 原始文字本來就是空字串——真的什麼都沒有，略過
  // 開頭錨定：近底才捲、且此刻多行泡泡只有首行在屏（reveal 中）
  // ＝捲到底剛好停在回覆開頭。若停在半成品泡泡開頭讀到一半（距底已遠），
  // final 替換上屏不搶捲軸——nearBottom 天然為 false。歷史回填不受影響
  // （renderHistory 尾有自己的整批捲底）。
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  listEl.appendChild(row);
  if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

/**
 * 逐行顯現引擎：第一行立即上屏，其餘行以固定節拍鏈式浮現——
 * 聊天軟體慣例：新內容從底部進來、逐行上移，從第一行開始讀（舊行為＝整包
 * 瞬間出現、第一句直接被推出視野頂）。節拍＝REVEAL_LINE_MS，總展開時間以
 * REVEAL_TOTAL_CAP_MS 封頂（長信自動加速、最快 REVEAL_MIN_MS）。
 * 每行浮現後「近底才跟捲」（距底 <120px）——若往上捲回讀舊訊息，浮現中的
 * 行不搶捲軸。清畫面／重新整理把泡泡拆離 DOM → isConnected 短路停拍，
 * 不對 detached 節點空轉。文字一律 textNode（XSS 紀律不例外）。
 */
function _revealLines(bubble, lines, listEl) {
  const stepMs = Math.max(
    REVEAL_MIN_MS,
    Math.min(REVEAL_LINE_MS, Math.floor(REVEAL_TOTAL_CAP_MS / lines.length)),
  );
  bubble.appendChild(document.createTextNode(lines[0]));
  let i = 1;
  const tick = () => {
    if (!bubble.isConnected || i >= lines.length) return;
    // 開頭錨定：浮現中的行一律不追捲——首行上屏那一下的跟捲由
    // 呼叫端（_renderReplyBubble 尾）負責，之後畫面停在回覆開頭，跟左邊 ADV
    // 同一個節奏：文字逐漸出現也等使用者自己往下捲。
    bubble.appendChild(document.createTextNode("\n" + lines[i]));
    i += 1;
    if (i < lines.length) setTimeout(tick, stepMs);
  };
  setTimeout(tick, stepMs);
}

/**
 * 使用者自己送出的訊息（本地偽 role「sent」）。三個可選附加欄位（皆非協定欄位，
 * 是 app.js／renderHistory 自建本地 frame 時才會用到的本檔約定，見各自呼叫點）：
 *   - `photoUrl`：本次即時傳送的照片（`URL.createObjectURL(file)` 產生的本地
 *     blob URL——私聊沒有下行「照片回顯」frame，這是寄件人自己
 *     的樂觀渲染，只活這個分頁的 session，不進 XSS 疑慮清單（瀏覽器生成的
 *     `blob:` URL，不是從任何文字欄位拼出來的字串）。
 *   - `photoUrls`（多圖貼上案）：一次傳 N 張的多圖版——陣列逐張畫照片泡泡，
 *     直向堆疊（順序＝上傳序＝貼上的順序）。單張沿用 `photoUrl` 舊欄位也通
 *     （內部統一成清單處理），兩欄同給時 `photoUrls` 優先。
 *   - `photoNote`：歷史回填專用（見 `renderHistory` 的 `_stripPhotoMarker`）——
 *     帳本裡的 `[照片×N]` 標記剝除後只剩下「這裡曾經有 N 張照片」這個數字，原圖
 *     早已被伺服器 `burn_photos` 銷毀，沒有 URL 可畫，只能顯示淡化的文字占位。
 *   - 照片欄位與 photoNote 最多同時出現一個（即時送出 vs 歷史回填是兩條不同的
 *     呼叫路徑）；`text` 可以跟兩者之一並存（照片配文字說明），也可以全都沒有
 *     （→ 不渲染，同舊行為）。
 */
function _renderSentBubble(frame, listEl) {
  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  const photoUrl = typeof frame.photoUrl === "string" && frame.photoUrl ? frame.photoUrl : null;
  const photoUrls = Array.isArray(frame.photoUrls)
    ? frame.photoUrls.filter((u) => typeof u === "string" && u)
    : photoUrl
      ? [photoUrl]
      : [];
  const photoNote = typeof frame.photoNote === "number" && frame.photoNote > 0 ? frame.photoNote : null;
  if (!text && !photoUrls.length && !photoNote) return;

  const row = document.createElement("div");
  row.className = "row sent";
  // 圖＋文同送＝垂直排列（圖上、文下），不並排——row-stack 讓
  // flex 轉直向（chat.css）。多張照片（無論有沒有配文字）同樣直向堆疊——
  // .row.sent 本體是橫排 flex，N 顆 220px 泡泡橫排必爆寬。單圖單泡泡輪不加＝零波及。
  if (((photoUrls.length || photoNote) && text) || photoUrls.length > 1) row.classList.add("row-stack");

  if (photoUrls.length) {
    for (const u of photoUrls) row.appendChild(_buildPhotoBubble(u));
  } else if (photoNote) {
    const note = document.createElement("div");
    note.className = "bubble sent bubble-photo-note";
    note.appendChild(document.createTextNode(t("chat.photoCount", { n: photoNote })));
    row.appendChild(note);
  }

  if (text) {
    const bubble = document.createElement("div");
    bubble.className = "bubble sent";
    bubble.appendChild(document.createTextNode(text));
    row.appendChild(bubble);
  }

  listEl.appendChild(row);
  listEl.scrollTop = listEl.scrollHeight;
}

/**
 * 照片泡泡：`<a target="_blank">` 包 `<img>`——點縮圖用瀏覽器原生方式開新分頁看
 * 原圖，不必自己再刻一個燈箱／全螢幕檢視器。`src`／`href` 都是呼叫端傳入的
 * `URL.createObjectURL()` 產物（瀏覽器生成的 `blob:` URL，不是拼接自由文字），
 * `alt` 是寫死的靜態字串（不是任何使用者輸入），兩者都不經過 innerHTML。
 */
function _buildPhotoBubble(url) {
  const link = document.createElement("a");
  link.className = "bubble bubble-photo";
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.className = "bubble-photo-img";
  img.src = url;
  tAttr(img, "alt", "chat.photoAlt");
  link.appendChild(img);
  return link;
}

function _renderSystemLine(frame, listEl, ctx = {}) {
  const text = typeof frame.text === "string" ? frame.text : "";
  if (!text) return;
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.appendChild(document.createTextNode(text));
  // 語音留言的 System 行（帳本帶 audio）→ 行尾紫圓 play
  // （懸浮留言卡退場後的內嵌重播入口；URL 帶 ?cid= 供 played 回報）
  if (Array.isArray(frame.audio) && frame.audio.length) {
    const play = _buildReplayBtn(frame.audio, ctx);
    if (play) el.appendChild(play);
  }
  // 開頭錨定補洞：改 near-bottom 條件捲（同 _renderReplyBubble
  // 判準）。intimate/CG 輪 reply 之後必跟場景行（system frame）——舊的無條件捲底
  // 會把剛錨定在回覆開頭的畫面直接拉到底＝「顯示完跳到最尾巴」的根因；
  // 日常輪無場景行跟隨，所以不易察覺。使用者自己剛送出訊息的情境（sent
  // 無條件捲底）距底＝0＝nearBottom 恆真，留言/系統行照捲，行為不變。
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  listEl.appendChild(el);
  if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

/**
 * 思考中指示器：畫面上永遠只有一條——
 * 新的 status frame 取代舊的（先清掉再畫，不是疊加），附加在 listEl 尾端（跟其他
 * 訊息一樣自然排在對話串最下面）。找既有元素靠 DOM query（同 `_attachReact` 的
 * 既有手法），不維護額外的模組層級狀態——`renderFrame` 是純函式，狀態全部活在 DOM
 * 本身。「任何非 status 的後續 frame 移除它」的另一半邏輯在 `renderFrame` 的
 * dispatch 前（見上），這裡只負責「status 接 status」這一種取代。
 */
function _renderStatusLine(frame, listEl) {
  _clearStatusLine(listEl);
  const text = typeof frame.text === "string" ? frame.text : "";
  if (!text) return;
  const el = document.createElement("div");
  el.className = "status-line";
  el.appendChild(document.createTextNode(text)); // XSS 紀律：textContent 路徑，不例外
  // 同上：status 行也改 near-bottom 條件捲——送出後等回覆的
  // 情境（人在底部）照捲；reply 錨定開頭後晚到的通話思考點等不再搶捲軸。
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  listEl.appendChild(el);
  if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

/** 移除目前顯示中的思考中指示器（若有）。沒有就是 no-op——呼叫端（`renderFrame`
 * 頂部與 `_renderStatusLine` 自己）不需要先確認存不存在。 */
function _clearStatusLine(listEl) {
  const el = listEl.querySelector(".status-line");
  if (el) el.remove();
}

/**
 * 本地「他在打字」三點（手機無 ADV，send 後到 reply 前 Chat Log
 * 空白像沒反應——尤其點 CG 卡／MENU 部分指令輪，server 不送「思考中…」
 * status）。呼叫端＝app.js 的 send 出口（send 回 true 才呼叫）。
 * 走 .status-line 家族＝同一條取代制（_clearStatusLine）＋ renderFrame「任何
 * 非 status frame 先清 status 行」的既有機制：server 的「思考中…」status 到達
 * 會換掉它、reply／partial 到達自動消失，永不殘留。三顆 span 的跳動在 CSS
 * （.status-dots；reduced-motion 靜態）。near-bottom 條件捲同 _renderStatusLine
 * ——剛送出訊息＝人在底部＝照捲。
 */
export function showThinkingDots(listEl) {
  _clearStatusLine(listEl);
  const el = document.createElement("div");
  el.className = "status-line status-dots";
  for (let i = 0; i < 3; i++) el.appendChild(document.createElement("span"));
  const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  listEl.appendChild(el);
  if (nearBottom) listEl.scrollTop = listEl.scrollHeight;
}

/**
 * CG 場景行：場景行是 system frame——renderFrame 的
 * 「非 status frame 先清 status 行」通用機制會把等待指示吃掉（本地 dots 與
 * server 補發的「思考中…」都中招：點卡 → 指示出現 → cg_state 推送 → 場景行
 * 上屏 → 指示被清 → 他構思開場的 10-25s 全空白）。修＝渲染前記住「等待指示
 * 在不在」，在＝使用者還在等他開口，渲染後重掛 dots——他的 reply 到達照樣走既有
 * 機制自動清，語意零變化。app.js 的 CgPresenter renderLine 用這支。
 */
export function renderSceneLine(listEl, ctx, name) {
  const waiting = !!listEl.querySelector(".status-line");
  renderFrame(
    { role: "system", text: t("chat.scene", { name }), timestamp: new Date().toISOString() },
    listEl, ctx,
  );
  if (waiting) showThinkingDots(listEl);
}

function _buildThought(thoughtText) {
  const el = document.createElement("div");
  el.className = "thought";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-expanded", "false");
  el.appendChild(document.createTextNode(thoughtText));
  return el;
}

/**
 * THINKING 頁思緒條目（手機雙頁籤）：每輪思緒 append 一條進
 * #thoughts-pane。資料源＝完整回覆 frame 的 `thoughts` 欄（app.js 分發），與
 * ADV Thinking 鈕同源同現實——transient、不落帳本、F5 即空（設計）。條目為
 * 純顯示文字（XSS 紀律：textNode），非互動元素（頁籤裡空間專屬、不需摺疊）。
 * 空白／非字串 no-op；append 後捲底（若停在 THINKING 頁、新思緒直接入視野）。
 */
export function appendThought(paneEl, thoughtText) {
  if (!paneEl || typeof thoughtText !== "string" || !thoughtText.trim()) return;
  const el = document.createElement("div");
  el.className = "thought-entry";
  el.appendChild(document.createTextNode(thoughtText));
  paneEl.appendChild(el);
  paneEl.scrollTop = paneEl.scrollHeight;
}

/**
 * 剝除開頭（最多連續 4 個，同既有 guard）的 [react:X]／[sticker:Y] 標記，sticker
 * 另外容錯句尾＋全文任意位置（保底）。[intimate:*]／[cg:X]（他的換景暗號）
 * 兩族引擎狀態標記全文靜默剝除（先於行首掃描——
 * [intimate:open][sticker:x] 的連續標記串剝掉 intimate 後 sticker 回到行首，
 * 行首邏輯照舊接手）。回傳剝乾淨的正文＋抓到的 react emoji／
 * sticker 標籤（皆可能為 null；sticker 標籤僅供佔位判斷，不渲染貼圖），
 * 外加 [blush]／[expr:ID] 抽出的 blushLevel／exprId（僅 final reply 呼叫端拿去觸發表情層）。
 * export：adv.js 的 ADV 對話框需要同一套剝除邏輯拿正文
 * 打字機上屏——單一真相，不寫第二套 regex。
 */
export function stripMarkers(rawText) {
  // 臉紅級別：剝除前先抽——null｜"mid"｜"deep"，多顆取最深（先 [blush] 後
  // [blush:deep]＝更紅）。只有 final reply 呼叫端拿它觸發暈層。
  let blushLevel = null;
  BLUSH_LEVEL_RE.lastIndex = 0; // 全域 RE 的 exec 迴圈狀態歸零（重入安全）
  let bm;
  while ((bm = BLUSH_LEVEL_RE.exec(rawText)) !== null) {
    if (bm[1] && /^deep$/i.test(bm[1])) blushLevel = "deep";
    else if (blushLevel !== "deep") blushLevel = "mid";
  }
  // 表情 id：多顆取最後一顆、小寫化；只有 final reply 呼叫端拿它觸發。
  let exprId = null;
  EXPR_ID_RE.lastIndex = 0;
  let em;
  while ((em = EXPR_ID_RE.exec(rawText)) !== null) exprId = em[1].toLowerCase();
  let text = rawText
    .trim()
    .replace(INTIMATE_RE, " ")
    .replace(CG_ANY_RE, " ")
    .replace(ROOM_MARKER_RE, " ")
    .replace(BLUSH_ANY_RE, " ")
    .replace(EXPR_ANY_RE, " ")
    .trim();
  let reactEmoji = null;
  let stickerLabel = null;
  let guard = 0;
  while (guard < 4) {
    guard += 1;
    const rm = text.match(REACT_RE);
    if (rm) {
      text = text.slice(rm[0].length);
      if (!reactEmoji) reactEmoji = rm[1];
      continue;
    }
    const sm = text.match(STICKER_HEAD_RE);
    if (sm) {
      text = text.slice(sm[0].length);
      if (!stickerLabel) stickerLabel = sm[1];
      continue;
    }
    break;
  }
  if (!stickerLabel) {
    const tm = text.match(STICKER_TAIL_RE);
    if (tm) {
      text = text.slice(0, text.length - tm[0].length);
      stickerLabel = tm[1];
    }
  }
  // 全文保底：行首／行尾都錨不到的 [sticker:]（正文中段、或被其他標記推離錨點）
  // 也剝乾淨——一次一顆、guard 同上限，永不裸奔上屏。
  let anyGuard = 0;
  while (anyGuard < 4) {
    anyGuard += 1;
    const am = text.match(STICKER_ANY_RE);
    if (!am) break;
    text = (text.slice(0, am.index) + " " + text.slice(am.index + am[0].length)).trim();
    if (!stickerLabel) stickerLabel = am[1];
  }
  return { text: text.trim(), reactEmoji, stickerLabel, blushLevel, exprId };
}

/** 貼到最後一個 .bubble.sent 角落；找不到（開場第一句就 react）靜默略過（既有實作同款容錯）。 */
function _attachReact(listEl, emoji) {
  const bubbles = listEl.querySelectorAll(".bubble.sent");
  if (!bubbles.length) return;
  const bubble = bubbles[bubbles.length - 1];
  let badge = bubble.querySelector(".bubble-react");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "bubble-react";
    tAttr(badge, "aria-label", "chat.replyBadge");
    bubble.appendChild(badge);
  }
  badge.textContent = emoji;
}

/**
 * 把 `/api/history` 回傳的 entries 陣列依序渲染進 listEl（純函式，不 fetch、不發任何
 * 網路請求）。逐筆依 `speaker` 轉成 `renderFrame` 認得的本地 frame 物件再交給它畫——
 * 單一渲染入口，markers 剝除／XSS 紀律照舊，不寫第二套。
 *
 * `speaker` 是帳本欄位的 wire literal（protocol literal, not branding，不是
 * 本檔取的角色名字）：`"User"` → 本地偽 role `{role:"sent"}`（同即時送出訊息）；
 * `"Assistant"` → `{role:"assistant", thoughts:null}`（帳本沒有
 * thoughts 欄位，一律 null；文字仍可能帶 `[react:]`／`[sticker:]` 標記，交給
 * `renderFrame` 既有剝除管線處理，不會裸奔上屏）；`"System"` → `{role:"system"}`
 * （電話事件旁白，如「（電話接通）」／「（通話結束⋯）」／「（他的語音留言）」
 * ——已上線的電話功能真的會把這些寫進帳本；重用既有的 `.sys-msg` 灰字置中
 * 渲染，不落聊天泡泡外觀，跟即時 WS 的 `role:"system"` frame 走同一條既有
 * 渲染路徑）。**`"System"` 這條分支不可省**——曾經誤信「私聊帳本從不寫
 * System」而把它一併歸進「理論上不會出現」靜默略過，會讓真實存在的電話事件
 * 旁白在歷史回填時無聲消失。其餘／缺漏 `speaker` 值（1:1 私聊不會有第三方
 * 參與者）靜默略過，跟 `renderFrame` 對未知 role 的既有容錯一致，不拋錯。
 *
 * 不重排、不裁切——`/api/history` 已是時間正序，且後端已經做過裁切（單一真相，
 * 前端不加第二層裁切）；這裡只依陣列原始順序逐一 append。
 * 渲染完（含空陣列，動作等冪）捲到底。
 *
 * @param {Array<{ts?: string, speaker?: string, text?: string}>} entries
 * @param {HTMLElement} listEl
 * @param {{characterName?: string, assetsBase?: string}} [ctx]
 */
export function renderHistory(entries, listEl, ctx = {}) {
  if (!Array.isArray(entries) || !listEl) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const text = typeof entry.text === "string" ? entry.text : "";
    if (entry.speaker === "User") {
      // protocol literal, not branding —— 帳本欄位真的會寫這個字面值，非本檔命名。
      // [照片×N] 存檔標記（見上方 PHOTO_MARKER_RE 說明）→ 剝除後轉成淡化占位
      // 「（照片 ×N）」，不讓帳本原始的方括號標記文字裸奔上屏（先前漏掉的一項，這裡補上）。
      const pm = _stripPhotoMarker(text);
      if (pm) {
        renderFrame({ role: "sent", text: pm.rest.trim(), photoNote: pm.count }, listEl, ctx);
      } else {
        renderFrame({ role: "sent", text }, listEl, ctx);
      }
    } else if (entry.speaker === "Assistant") {
      // protocol literal, not branding —— 同上。audio：通話台詞的
      // 逐句 mp3 URL 清單，history 端點透傳、這裡再透傳給 renderFrame 掛 play 鍵。
      renderFrame(
        // instant（逐行顯現輪）：歷史回填整包直貼——逐行浮現只給「即時到達
        // 的新回覆」，F5 回填五十則逐行會是災難。本地約定欄位（同 photoNote 模式）。
        { role: "assistant", text, timestamp: entry.ts, thoughts: null, audio: entry.audio, instant: true },
        listEl, ctx,
      );
    } else if (entry.speaker === "System") {
      // protocol literal, not branding —— 同上；電話事件旁白真的會用這個值落
      // 帳本（見上方函式說明），不是理論上不會出現的值——誤歸進下面的靜默
      // 略過會讓這些旁白消失。audio＝語音留言行。
      renderFrame({ role: "system", text, audio: entry.audio }, listEl, ctx);
    }
    // 其他／缺漏 speaker（第三方名字——私聊真的不會出現）——靜默略過，不拋錯。
  }
  listEl.scrollTop = listEl.scrollHeight;
}

/**
 * 回填 `/api/history`：fetch → 解析 → 交給 `renderHistory` 畫上屏。任何一步失敗
 * （網路錯誤／逾時／4xx／5xx／body 不是合法 JSON／`entries` 缺失或不是陣列）一律
 * `logWarn` 後直接返回——絕不把例外丟給呼叫端，呼叫端不需要、也不應該再包一層
 * try/catch；聊天永遠不會因為歷史回填失敗而被擋住（失敗＝空清單，
 * 聊天照常可用）。
 *
 * `credentials: "same-origin"` 明確帶上——同源請求瀏覽器本來就會自動帶 cookie，這裡
 * 寫明是呼應後端 cookie 門機制，不是畫蛇添足。
 *
 * 15s AbortController：鏡照 `tts.js`
 * `speak()` 既有的逾時模式——這是同一個 bug class 第三次現身（`tts.js` 的 fetch、
 * `phone.js` 的 `/api/call/start` 都已經修過），這裡是第三處：`main()`
 * （`app.js`）是 `await loadHistory(...)` 完才接 `chat.connect()`，一個卡住不
 * resolve 的 fetch 會讓整個開機流程卡在「連線中⋯⋯」之前，連聊天輸入框都進不去。
 * timer 蓋住 `fetch()` 到 `res.json()` 兩步（不是只到 headers 到手就
 * clearTimeout）——理由同 tts.js：body／JSON 解析卡住一樣要被同一顆 abort 打斷，
 * 否則卡在「headers 到手、body 還沒讀完」這個縫隙一樣會無限期卡住。逾時／中止都
 * 走既有的外層 catch（logWarn＋空清單，行為不變，見上）。
 *
 * TTS 隔離：本函式（連同它呼叫的 `renderHistory`／`renderFrame`）全程不 import、不
 * 接觸 `tts.js`／`TtsSpeaker` 任何一行——歷史回填在架構上就摸不到 `speak`，這是路徑
 * 分離，不是旗標擋。即時回覆的 TTS 掛點在 `app.js` 的 `chat.onFrame` 處理器裡，跟
 * 這裡是兩條互不相交的呼叫鏈。
 *
 * 清除線（「清畫面後又回來」的修法）：`opts.clearedAt`（ISO ts 字串）
 * 有值時只渲染清除線之後的 entries——位置語意：找到第一筆 `ts > clearedAt` 的
 * entry，該筆起全收（含其後偶發無 ts 的行；帳本時間正序是後端既有保證）。
 * 全在線內＝空清單。帳本資料零觸碰，濾的只是顯示層。
 *
 * @param {string} url  `/api/history` 端點（實際 query string 由後端實作決定）
 * @param {HTMLElement} listEl
 * @param {{characterName?: string, assetsBase?: string}} [ctx]
 * @param {{clearedAt?: string|null}} [opts]
 */
export async function loadHistory(url, listEl, ctx = {}, opts = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let data;
    try {
      const res = await fetch(url, { credentials: "same-origin", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    let entries = Array.isArray(data && data.entries) ? data.entries : [];
    const clearedAt = opts && typeof opts.clearedAt === "string" ? opts.clearedAt : null;
    if (clearedAt) {
      const idx = entries.findIndex((e) => e && typeof e.ts === "string" && e.ts > clearedAt);
      entries = idx === -1 ? [] : entries.slice(idx);
    }
    renderHistory(entries, listEl, ctx);
    // 回傳 entries：app.js 需要拿「最後一句對方的話」放上
    // ADV 對話框當開場（回填仍全數進 Chat Log，這裡只是多回傳資料、渲染行為零改變）。
    // 清除線生效時回傳的是濾後清單——ADV 開場自然不會撿回線內的舊句。
    return entries;
  } catch (e) {
    logWarn("[chat] history backfill failed; keeping the chat empty:", e);
    return [];
  }
}

/**
 * 抓帳本尾巴的 ts（清畫面寫清除線用）：fetch `/api/history` → 回最後一筆帶 ts
 * entry 的 ts；空帳本／全無 ts／fetch 失敗（網路錯、非 ok、逾時）一律回 null——
 * 呼叫端拿到 null 就不寫線，清畫面退化成「只清當下畫面」（現行行為），誠實降級、
 * 絕不用 client 時鐘充數（client 與 server 時鐘偏差會誤吞清畫面後的新訊息）。
 * 15s AbortController 同 loadHistory（同一個「卡住的 fetch」bug class）。
 */
export async function fetchLastEntryTs(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let data;
    try {
      const res = await fetch(url, { credentials: "same-origin", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const entries = Array.isArray(data && data.entries) ? data.entries : [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && typeof e.ts === "string" && e.ts) return e.ts;
    }
    return null;
  } catch (e) {
    logWarn("[chat] fetching the clear-line timestamp failed (this clear will not be persisted):", e);
    return null;
  }
}

/**
 * 跨裝置清除線（「一邊清、兩邊都清」）：線存 server
 * （POST/GET /api/v4/chat-clear，flag ENABLE_V4_CLEAR_SYNC）＝所有裝置回填一致。
 *
 * postServerClearLine：按清畫面 → POST（server 端自取帳本尾 ts 落線）→ 回
 * cleared_at。404（flag 未開）／網路錯／逾時＝null——呼叫端退回單機
 * localStorage 線（上一版行為），永遠有得清、只是差在跨不跨裝置。
 * fetchServerClearLine：載入時 GET 現行線；404／失敗＝null＝呼叫端用 local 線。
 * 兩支同 15s abort 慣例（同 loadHistory 的「卡住的 fetch」bug class）。
 */
export async function postServerClearLine(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let data;
    try {
      const res = await fetch(url, { method: "POST", credentials: "same-origin", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const ts = data && typeof data.cleared_at === "string" ? data.cleared_at : null;
    return ts || null;
  } catch (e) {
    logWarn("[chat] writing the clear line to the server failed (falling back to the local line):", e);
    return null;
  }
}

export async function fetchServerClearLine(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let data;
    try {
      const res = await fetch(url, { credentials: "same-origin", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const ts = data && typeof data.cleared_at === "string" ? data.cleared_at : null;
    return ts || null;
  } catch (e) {
    return null; // flag 未開（404）是常態路徑，不 warn 洗版
  }
}

/**
 * CallLogRenderer——通話內容的 Chat Log 渲染器。
 *
 * 設計原則：通話的文字直接顯示在 CHAT LOG 裡，自然接續下去，跟一般訊息同一
 * 個視窗、同一種呈現。phone.js 不再維護面板
 * 內字幕流（那層疊在 Chat Log 上的半透明黑遮罩會在截圖時留下重影），改經
 * onCallContent 把通話內容交給本類渲進真正的 #msgs：
 *
 *   - 角色的台詞（characterSentence）：**同一輪長在同一顆 reply 泡泡**——第一句開泡泡、
 *     後續句子換行接下去（對齊掛斷後 F5 歷史回填的樣子：帳本一輪一筆、整輪一顆
 *     泡泡），final 收輪。句 audio URL 逐句累積，泡泡尾掛既有的紫圓 play 鍵
 *     （_buildReplayBtn 同一套；每來一句音檔重建鈕＝清單永遠最新）——講完當下
 *     就有播放鍵，不必等 F5。通話中點播由 replayHooks.before 既有
 *     規則擋（他正在講電話）；掛斷後立即可重播。玫瑰愛心鈕（通話台詞泡泡也在
 *     範圍內——「同一顆 reply 泡泡元件」）
 *     final 收輪時掛（累積中不放，見 characterSentence 文件）；通話中按＝允許（跟
 *     play 鍵的 replayHooks.before 通話禁播規則無關，愛心不出聲）。
 *   - 使用者的話（userLine）：STT 轉寫成功＝正常 sent 泡泡（打字路徑不經這裡——
 *     app.js submit 已畫 sent 泡泡）。
 *   - 旁白（sysLine）：（沒聽清楚）／熔斷提示等＝既有 .sys-msg 灰字置中。
 *
 * 渲染紀律沿用本檔既有規範：textContent 路徑零 innerHTML（XSS 紀律）、appendChild
 * 後捲到底、_clearStatusLine 收思考中指示器。本類只管畫，不碰 WS／TTS／driver
 * （分層同 loadHistory 慣例——動嘴／讓位走 ctx.replayHooks，由 app.js 注入）。
 */
export class CallLogRenderer {
  constructor(listEl, ctx = {}) {
    this._listEl = listEl;
    this._ctx = ctx;
    this._turn = null; // { line, textNode, urls, btn, keyText }——進行中的「他的這一輪」
  }

  /** 角色方的一句台詞：首句開泡泡、後續換行接續；audioUrl 逐句累積重建 play 鍵
   * （鍵在**泡泡外右側**——統一位置，.bubble-line 橫排結構與
   * 歷史回填 _renderReplyBubble 同款）；isFinal 收輪（下一輪開新泡泡）。
   * text 空而 audio 有值的畸形幀：無泡泡可掛就丟棄（協定上 text 恆與 audio
   * 同幀，這是保守防禦不是路徑）。
   *
   * 玫瑰鈕：**final 收輪時才掛**，累積中途不放——文字
   * 還沒定型，此刻按了存的是 partial text，F5 後歷史回填是整輪一筆完整正文
   * （帳本存的是後端切句前的原始 `reply`），partial 永遠配不上、亮態會假掉。
   *
   * key 的組法（`keyText`）刻意跟顯示用的 `textNode`（"\n" 接句、給人看）分開
   * 兩條累積——`keyText` 逐句**純串接、不加分隔符**。這不是隨意選擇：已用
   * 真實輸出實測驗證——通話模式的系統提示明文要求「口語短句、一句一句說⋯
   * 不寫長信，不列點」，這種輸出風格不含內嵌
   * `\n`；在這個前提下，逐句文字純串接後會逐字元等於原始 reply（多組實測樣本
   * 含刪節號／驚嘆號／問號皆驗證通過），但用換行符號串接就不成立（會多插入
   * 原文沒有的換行）。帳本存的正是這個未切句的原始 reply 文字——F5 後
   * `renderHistory`→`renderFrame`→`_renderReplyBubble` 對同一則 ledger 條目
   * 算出的 canonical＝`stripMarkers(reply).text`，跟這裡 `stripMarkers(keyText)
   * .text`（keyText 已驗證＝reply 逐字元相同）算出來的是同一個字串——這正是
   * 兩條路徑（即時累積 vs F5 回填）canonical 相等的來源，不是巧合。
   *
   * 另一個真觸發條件：後端逐句分段時對每段做
   * `.strip()`——句界緊鄰分隔符的空白（半形／全形皆算）
   * 一樣在切句當下遺失、純串接也還原不出來（跟內嵌 `\n` 同一個 bug class，
   * 已用真實輸出實測三組樣本證實逐字元差一個空白）。這個
   * 觸發條件**不是**靠這裡的累積邏輯修的——`markRoseFlags`（見該函式與
   * `_roseMatchKey` 文件）改成比對前先去除所有空白字元再比較，兩個真觸發
   * 條件（內嵌 `\n`／句界空白）現在對「點不點得亮」都已免疫。殘餘風險收斂
   * 為單純的**存文外觀差異**（cosmetic——即時累積存的 `keyText` 與 F5 側
   * ledger 原文可能差幾個空白字元，兩者都是可讀原文、只是空白排版不同，
   * 不影響任何功能），不再是「配不上」的功能性風險。 */
  characterSentence(text, audioUrl, isFinal) {
    if (!this._listEl) return;
    const t = typeof text === "string" ? text : "";
    if (t) {
      _clearStatusLine(this._listEl);
      // 通話字幕顯示層淨化：他這句話可能夾
      // [cg:X]／[intimate:*]／[sticker:]——通話字幕是具名顯示站點，跟非通話
      // 回覆泡泡（_renderReplyBubble）一樣一律不可裸奔上屏，同一顆 stripMarkers
      // 全文剝乾淨。只淨化「這一顆泡泡實際顯示的字」（displayT）——`keyText`
      // （玫瑰鍵累積）刻意繼續吃原始 `t`：上方大段文件已證明 keyText 必須
      // 逐字元等於 reply 原文才能跟 F5 回填的 ledger 對上，剝除只在下方
      // isFinal 那一下對整段累積結果做一次；這裡剝的是顯示專用副本，不倒灌
      // 回 keyText 鏈，dedup key 的算法與語意完全不變。
      const displayT = stripMarkers(t).text;
      if (!this._turn) {
        const row = document.createElement("div");
        row.className = "row reply";
        const line = document.createElement("div");
        line.className = "bubble-line";
        const bubble = document.createElement("div");
        bubble.className = "bubble reply";
        const textNode = document.createTextNode(displayT);
        bubble.appendChild(textNode);
        line.appendChild(bubble);
        row.appendChild(line);
        this._listEl.appendChild(row);
        this._turn = { line, textNode, urls: [], btn: null, keyText: t };
      } else {
        this._turn.textNode.textContent += "\n" + displayT;
        this._turn.keyText += t; // 玫瑰鍵累積：純串接無分隔符，見上方文件
      }
    }
    if (this._turn && typeof audioUrl === "string" && audioUrl) {
      this._turn.urls.push(audioUrl);
      if (this._turn.btn) this._turn.btn.remove();
      const btn = _buildReplayBtn(this._turn.urls.slice(), this._ctx);
      if (btn) {
        this._turn.btn = btn;
        this._turn.line.appendChild(btn); // 泡泡在前、鈕恆為 line 末子＝泡泡外右側
      }
    }
    // 玫瑰鈕：final 收輪時掛，恆為 line 末子（play 鈕若同一句也重建，上面那段
    // 先跑，這裡接在它後面 append＝順序永遠「泡泡→play→玫瑰」，同非通話 reply
    // 分支的既有排法一致）。canonical 沿用本檔既有 stripMarkers（見上方文件），
    // 不是二次發明剝除邏輯。
    if (isFinal && this._turn && this._ctx && this._ctx.roseHooks) {
      const canonical = stripMarkers(this._turn.keyText).text;
      if (canonical) this._turn.line.appendChild(_buildRoseBtn(canonical, this._ctx));
    }
    this._listEl.scrollTop = this._listEl.scrollHeight;
    if (isFinal) this._turn = null;
  }

  /** 使用者的話（userLine，STT 轉寫）：正常 sent 泡泡；同時視為他上一輪已結束（保險收輪）。 */
  userLine(text) {
    this._turn = null;
    renderFrame({ role: "sent", text }, this._listEl, this._ctx);
  }

  /** 旁白：既有 system 行渲染（灰字置中）。刻意**不**收輪——熔斷提示是在他
   * 這一輪講到一半時插進來的，收輪會讓剩下的句子另開第二顆泡泡。 */
  sysLine(text) {
    renderFrame({ role: "system", text }, this._listEl, this._ctx);
  }
}
