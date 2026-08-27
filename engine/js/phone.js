/**
 * phone.js —— 電話搬遷：撥出／來電浮層／留言卡＋通話動嘴。
 *
 * 三個對本檔設計影響最大的結論：
 *   ① VAD 校準／斷句／播放世代計數等數值與流程沿用既有實作；本版面沒有
 *      那套多 tab 系統，電話面板改疊在聊天欄內、來電浮層才是全頁級。
 *   ② 通話回覆與留言音檔共用同一顆持久 `<audio>` 元件——**招牌場景**：兩者都經
 *      `driver.attach(el)`，讓共用的立繪 `MouthDriver` 驅動嘴型，他在畫面上跟妳
 *      說話，立繪欄從頭到尾不被電話面板遮住（面板疊在 `#chat-col` 內）。
 *   ③ 通話輪的回覆走**既有聊天 WS**（`chatClient.send(JSON.stringify({call:true,
 *      text}))`），不是另開連線也不是 REST——這是全部搬遷裡最容易搞混的一點。
 *
 * 單一聲源鐵則（刻意的設計決策，非協定要求）：撥號中／通話中／留言播放中
 * 這三種狀態下 `isActive()` 恆真，app.js 把它接進 `TtsSpeaker.getEnabled`——他
 * 永遠不會同時用兩張嘴說話。
 *
 * 命名鐵則：本檔零角色專屬字樣。`"call"`／`"incoming_call"`／`"incoming_call_end"`／
 * `"system"` 是後端真的會送過來的 wire literal（protocol literal, not branding），
 * 每處引用都會標註。
 */

import { envelopeForUrl } from "./envelope.js";
import { t, tAttr } from "./i18n.js";

// iOS 手勢解鎖用的 44-byte 靜音 wav data URI（沿用既有實作：純 HTMLMediaElement
// 技巧，跟 Web Audio API／AudioContext 無關，不是「第二顆 AudioContext」）。
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

const PHONE_SVG = {
  // 通用電話聽筒（Feather 風格 stroke 路徑，純幾何圖示，零角色內容）。全站 icon
  // 統一 stroke 家族：fill=none、stroke-width=2、round caps/joins（與
  // index.html 齒輪／迴紋針、settings.js 關閉鈕同家族）。
  phone:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  // 掛斷＝**打電話同一支話筒幾何真旋轉 135°＋縮 0.8 塞回框**（把打電話的
  // icon 旋轉就是掛電話；135° 是杯口朝下的角度——270° 會變左右鏡像的打電話）。
  // 話筒原圖佔滿 24 框對角線（斜跨 ~26），轉橫後長軸 > 框寬、兩端杯頭超界被裁。修＝
  // 旋轉後繞中心縮 0.8（26×0.8+線帽 ≈ 22.5 < 24），path stroke-width 2.5 補償
  // （縮後視覺 ≈ 2＝全站家族同粗）。index.html 的 .icon-hangup ×2 同款，改動必同步）。
  hangup:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="rotate(135 12 12) translate(12 12) scale(0.8) translate(-12 -12)"><path stroke-width="2.5" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></g></svg>',
  play:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>',
};

export class PhoneController {
  constructor({ driver, chatClient, container, config = {}, tts = null, onStatusNote = null, onCallContent = null, onCallState = null, getTypingActive = null }) {
    /** 電話的狀態／失敗訊息不再顯示在面板裡——
     * 透過這個回呼交給呼叫端（app.js 把它渲成 Chat Log 的 system 行）。 */
    this.onStatusNote = typeof onStatusNote === "function" ? onStatusNote : null;
    /** 通話內容不再走面板自己的字幕流（那層疊在
     * Chat Log 上會造成截圖重影＋黑遮罩），改透過這個回呼交給呼叫端渲進
     * **真正的 Chat Log**（app.js 接 chat.js 的 CallLogRenderer）——「語音的
     * 文字直接顯示在 Chat Log、自然接下去」。事件形狀：
     *   {type:"character", text, audio, final} —— 角色方的一句台詞（audio＝該句 mp3 URL
     *     或 null；final＝本輪最後一句）
     *   {type:"user", text} —— 使用者的話（STT 轉寫成功；打字走 app.js 既有 sent
     *     泡泡，不經這裡）
     *   {type:"sys", text} —— 旁白（（沒聽清楚）等）
     *   {type:"thinking"} —— 說完話（語音或打字）輪到他想——app.js 渲
     *     Chat Log 思考中指示器（頂條退場後的替代訊號） */
    this.onCallContent = typeof onCallContent === "function" ? onCallContent : null;
    /** 通話狀態／計時不再長在 Chat Log 頂條（頂條退場）——改由
     * 這個回呼交給呼叫端（app.js 把左側欄電話鈕切成掛斷樣＋鈕旁小計時 pill）。
     * 事件形狀：{phase:"idle"|"dialing"|"in-call", seconds}——dialing 起、接通後
     * 每秒、以及任何回到 idle 的出口（掛斷／撥號失敗／接聽失敗）都會通知。 */
    this.onCallState = typeof onCallState === "function" ? onCallState : null;
    /** 「打字時不要顯示（沒聽清楚）」——通話中打字，鍵盤聲／
     * 環境音會誤觸 VAD 開錄→STT 轉不出字→（沒聽清楚）洗版。呼叫端注入
     * 「正在打字嗎」的判準（app.js＝輸入框 focus 或有內容），VAD 迴圈據此
     * 不開錄、進行中的誤錄段作廢丟棄。null＝不判（既有行為）。 */
    this.getTypingActive = typeof getTypingActive === "function" ? getTypingActive : null;
    this.driver = driver;
    this.chatClient = chatClient;
    this.container = container;
    this.config = config;
    // 單一聲源鐵則的另一半：`isActive()` 只擋
    // 「之後」新的 `TtsSpeaker.speak()` 呼叫（見 app.js 的 `getEnabled`），擋不住
    // 「已經在飛」的那一句聊天 TTS——撥號／接聽這兩個「電話開始」的動作本身要主動
    // 收掉它，見下方 `_stopChatTts()`。選用注入：app.js 建構順序上 `tts` 晚於
    // `phone` 才誕生（`tts` 的 `getEnabled` 閉包需要引用已存在的 `phone`），app.js
    // 用 `phone.tts = tts;` 事後補上這條連結；未接線時（含本檔既有測試）安全 no-op。
    this.tts = tts;

    /** idle | dialing | in-call | ended（四態；接聽來電也落 in-call，
     * 不是第五態——接聽跟撥出走同一個「已接通」語意）。 */
    this.state = "idle";
    this._callId = null;
    this._incomingCallId = null;
    // 撥出／接聽共用的「目前這次連線嘗試」身分 token：state 只能回答
    // 「現在畫面顯示什麼」，答不出「這個非同步回呼還算不算數」——連續兩次撥出、或撥出/
    // 接聽中途掛斷又立刻再次嘗試，state 都會被下一次嘗試蓋回同一個值，讓上一次遲到的
    // 回呼誤以為自己還是當前這次，去覆蓋新嘗試的畫面甚至誤判新嘗試的成功為過期）。
    // 撥出時是一顆 AbortController（順便拿來在逃生時真的中止那個 fetch，見 dialOut()）；
    // 接聽時是一個空物件（純粹拿來比對身分——接聽路徑不需要逾時，只需要
    // 堵住「舊回呼誤判自己還算數」這個洞）。掛斷（不論從撥號中或通話中哪個分支）一律把
    // 這個欄位設回 null——「我離開了，剛才那次嘗試不再代表現在」，讓任何遲到的回呼比對
    // 身分失敗、安全略過。跟檔案裡既有的播放世代計數（`_playGen`）是同一手法，這裡明確
    // 共用「非同步回呼必須自證身分才能改動狀態」這個原則，不重新發明一套。
    this._connectAttempt = null;

    // 麥克風身分 token：每次 _enterCallScreen 重鑄；getUserMedia 的
    // 成功／失敗回呼都要比對它——上一通遲到的回呼不得把舊 stream 掛上新通話、也
    // 不得用舊失敗掛斷新通話。獨立於 _connectAttempt（那顆在撥號 finally 會提早歸
    // null，拿來比對會失真）。
    this._micSession = null;

    // 通話回覆／留言播放共用同一顆持久 <audio> 元件。
    this._audioEl = null;
    this._queue = [];
    this._playing = false;
    this._playGen = 0;
    this._finalPending = false;
    this._voicemailPlaying = false;
    this._vmPlayedReported = {};
    this._autoplayUnlockShown = false;
    this._autoplayRecoveryArmed = false;
    this._retryPlayHandler = null;

    // 鈴聲（獨立元件，不跟通話播放共用——語意不同，時間軸本不重疊）。
    this._ringtoneEl = null;

    // VAD／錄音（數值與流程沿用既有實作）。
    this._analyser = null;
    this._stream = null;
    this._recorder = null;
    this._chunks = [];
    this._discardNext = false; // 打字期間誤錄段的作廢旗標
    // 這通電話用「打字」互動後（noteTypedUtterance），空轉寫
    // ＝十之八九是鍵盤／環境音誤觸（打字 gate 只擋「focus 在輸入框」的當下，
    // 滑鼠按送出／點面板的瞬間 focus 離開＝VAD 開門）——靜默丟棄不上
    // （沒聽清楚）。真的開口且轉寫成功會把模式翻回語音，提示恢復。
    this._typedSttMode = false;

    this._vadRaf = null;
    this._threshold = 0.01;
    this._calibrating = true;
    this._calibSamples = [];
    this._calibStart = 0;
    this._speaking = false;
    this._silenceStart = null;
    this._silenceMs = 3000;
    this._turnActive = false;

    this._timerHandle = null;
    this._seconds = 0;

    this._dom = {};
    this._buildDom();
  }

  // ── 對 app.js 開放的狀態查詢（單一聲源鐵則掛點）───────────────────────────
  /** 撥號中／通話中／留言播放中——這三種狀態下聊天 TTS 必須靜默（他不會同時用兩張嘴說話）。 */
  isActive() {
    return this.state === "dialing" || this.state === "in-call" || this._voicemailPlaying;
  }

  /** 嚴格「正在通話中」（不含撥號中／留言播放）——用來判斷 role:"system" 熔斗提示該去通話字幕區還是主聊天。 */
  isInCall() {
    return this.state === "in-call";
  }

  // ── 對 app.js 開放的入口 ──────────────────────────────────────────────────
  /** 開啟電話面板（非主流程——通話控制搬左側欄鈕，主入口＝dialOut/
   * hangUp toggle；本方法留給「有留言卡要看」的殘餘語意與相容呼叫端）。 */
  open() {
    this._dom.panel.hidden = false;
    this._renderActiveView();
    if (this.state === "idle" || this.state === "ended") this._refreshLog();
  }

  /** 關閉面板——通話進行中不可用這條路徑逃走（誠實：不能假裝掛了電話）；
   * 撥號中則視同放棄這次撥號（卡住的撥號畫面必須有逃生路徑）。 */
  close() {
    if (this.state === "in-call") return;
    if (this.state === "dialing") this.hangUp(); // 逃生：中止請求＋回 idle，見 hangUp() 的撥號中分支
    this._dom.panel.hidden = true;
  }

  /** 大撥出鍵：手勢窗口內先解鎖播放→ POST start（15s AbortController，逾時/中止
   * 一律誠實回 idle，鏡照 tts.js 15s 逾時的既有設計——沒有這層保護，
   * 卡住的請求會讓 isActive() 恆真、聊天 TTS 靜默一整個 session 直到重整頁面）→ 成功進通話畫面；
   * 409/404 誠實顯示後端原文。 */
  dialOut() {
    if (this.state === "dialing" || this.state === "in-call") return;
    this._clearStatusMsg();
    this._unlockAudioForIOS(); // 必須排最前——同步脈絡內，任何 fetch/await 之前
    this._stopChatTts(); // 撥號這個動作本身就該讓正在飛的聊天 TTS 立刻收嘴
    this.state = "dialing";
    this._notifyState("dialing"); // 左側欄鈕變掛斷樣＋pill「接通中」
    this._renderActiveView();
    const ctrl = new AbortController();
    this._connectAttempt = ctrl;
    this._runDialStart(ctrl);
    // silence_sec 配置同步（VAD 斷句秒數）——面板 open() 退出主流程後，撥號是
    // 唯一穩定入口；懶惰刷新的競態考量同 open() 舊註解，失敗有 3s 預設保底。
    // 排在 _runDialStart 之後＝/api/call/start 恆為本次動作的第一發請求。
    this._refreshLog();
  }

  /** 舊版用 `this.state !== "dialing"` 判斷「這次回呼還算不算數」
   * ——但 state 是單一共用欄位，連續兩次撥出（或撥出中途掛斷又立刻再撥）都會把它蓋回同一個
   * 值，讓上一次遲到的回呼誤判自己還是當前這次。改成身分比對（`this._connectAttempt !== ctrl`）
   * ——每個回呼只認自己出生時拿到的那顆 `ctrl`，被取代了就是被取代了，跟 state 現在顯示
   * 什麼無關。三個關卡（成功／4xx-5xx／例外）與收尾 `finally` 都要各自守這一道，缺一個都會
   * 讓那個分支變成漏網之魚。 */
  async _runDialStart(ctrl) {
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      let res, body;
      try {
        res = await fetch("/api/call/start", { method: "POST", signal: ctrl.signal });
        body = await res.json().catch(() => ({}));
      } finally {
        clearTimeout(timer); // 15s 預算蓋到 body 讀完，不只 headers 到手——同 tts.js 的既有教訓
      }
      if (this._connectAttempt !== ctrl) return; // 已被取代（新嘗試／使用者已逃生），這次回呼不算數
      if (!res.ok) {
        const detail = body && body.detail;
        if (res.status === 409 && detail) this._setStatusMsg(detail);
        else if (res.status === 404) this._setStatusMsg(t("phone.featureOff"));
        else this._setStatusMsg(detail || t("phone.unavailable"));
        this.state = "idle";
        this._notifyState("idle"); // 撥號失敗＝左側欄鈕與 pill 復位
        this._renderActiveView();
        return;
      }
      this._callId = (body && body.call_id) || null;
      this._enterCallScreen();
    } catch (err) {
      if (this._connectAttempt !== ctrl) return; // 同上
      console.warn("[phone] dial failed:", err);
      const timedOut = err && err.name === "AbortError";
      this._setStatusMsg(timedOut ? t("phone.dialFailedRetry") : t("phone.dialFailedLater"));
      this.state = "idle";
      this._notifyState("idle"); // 同上
      this._renderActiveView();
    } finally {
      // 只有「我還是目前這次嘗試」才清掉這個欄位——已經被新嘗試取代的話，欄位屬於新嘗試，
      // 不該被舊嘗試的收尾動作誤清掉（那樣新嘗試自己的成功/失敗回呼反而會找不到自己）。
      if (this._connectAttempt === ctrl) this._connectAttempt = null;
    }
  }

  /** 掛斷：停媒體資源＋POST end（fire-and-forget）→ ended → 回待撥視圖。等冪（不在通話中
   * 且不在撥號中則 no-op）。撥號中呼叫（逃生路徑）：從未確認過 call_id，
   * 沒有東西要跟伺服器收尾——中止請求、直接回 idle（不是 ended，這通從未真的成立過）；
   * `_teardownMedia()` 的每一步都對「mic 根本還沒取得」null-guard，這裡呼叫安全、純粹是保險。
   * 兩個分支都無條件把 `_connectAttempt` 設回 null：不論剛才在
   * 撥號中還是通話中（含接聽回應還沒落地的樂觀 in-call），掛斷這個動作本身就該讓任何還在飛
   * 的連線回呼（撥出或接聽）比對身分失敗、安全略過——不必等「下一次嘗試剛好蓋掉它」才生效。 */
  hangUp() {
    if (this.state !== "dialing" && this.state !== "in-call") return;
    if (this.state === "dialing") {
      if (this._connectAttempt) this._connectAttempt.abort();
      this._connectAttempt = null;
      this.state = "idle";
      this._teardownMedia();
      this._clearStatusMsg();
      this._renderActiveView();
      return;
    }
    this._connectAttempt = null; // 若這通是接聽來的、回應還沒落地，讓那顆回呼比對身分失敗
    const id = this._callId;
    this.state = "ended";
    this._callId = null;
    this._teardownMedia();
    if (id) {
      fetch("/api/call/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: id }),
      }).catch((err) => console.warn("[phone] end failed:", err));
    }
    this._renderActiveView();
    this._refreshLog();
  }

  /** 通話中用輸入框打字（不開麥）——app.js 送出 call frame
   * 後呼叫這裡進「他在想」。頂條退場後，「他在想」的訊號改交 Chat Log
   * 思考中指示器（onCallContent thinking 事件→app.js renderFrame status 行）。
   * 打的字不由這裡上屏——app.js submit 已畫 sent 泡泡，再畫＝重影。 */
  noteTypedUtterance(text) {
    if (this.state !== "in-call" || typeof text !== "string" || !text) return;
    this._typedSttMode = true; // 這通在用打字：環境音的空轉寫改靜默丟棄（見建構子）
    this._emitContent({ type: "thinking" });
  }

  /** call 家族 frame 的單一分派入口（app.js 的 chat.onFrame 呼叫這裡）。
   * role:"system" 不再需要「通話中改道字幕區」的特殊分派——
   * 通話內容本身已經渲在 Chat Log，system 行走 app.js 的 renderFrame 主路徑
   * 就是對的位置（該特殊分派與 _onSystemFrame 一併退場）。 */
  handleFrame(frame) {
    if (!frame) return;
    switch (frame.role) {
      case "call": // protocol literal, not branding —— 後端真的送這個字面值
        this._onCallFrame(frame);
        break;
      case "incoming_call": // protocol literal, not branding
        this._showIncomingCall(frame);
        break;
      case "incoming_call_end": // protocol literal, not branding
        this._dismissIncomingCall(frame.call_id, frame.status);
        break;
      default:
        break;
    }
  }

  /** 接聽：先進 in-call（收浮層停鈴＋取麥克風）再送 POST accept——讓並發抵達的 role:"call"
   * 幀被正常接住（時序考量）。失敗才回退，且
   * 回退絕不呼叫 /api/call/end（server 端從未替這通設下 active_call_id）。
   *
   * 這支同樣需要「這次回呼還算不算數」的守衛——一個普通的慢
   * 回應在已經掛斷（甚至已經開始下一次嘗試）之後才落地，會直接覆蓋現在的狀態。跟
   * `_runDialStart` 同一種病、同一帖藥：用 `this._connectAttempt`（見建構子欄位說明）身分比對，
   * 接聽沒有獨立的逾時/中止機制，token 只是一個空物件、純粹拿來比對
   * 身分，不需要 `.abort()` 能力。 */
  acceptIncomingCall() {
    if (this.state === "dialing" || this.state === "in-call") return;
    // 手勢解鎖播放也要走接聽這條路徑：「對方主動打來、使用者從沒撥過號」正是主要情境
    // 之一，接聽這個點擊本身就是絕佳的手勢窗口，沒理由白白浪費掉——必須排最前，
    // 同步脈絡內，任何 await 之前。
    this._unlockAudioForIOS();
    this._stopChatTts(); // 接聽同樣要立刻收掉正在飛的聊天 TTS
    const callId = this._incomingCallId;
    this._hideIncomingOverlay();
    if (!callId) return;
    this._callId = callId;
    this.open();
    this._enterCallScreen();
    const attempt = {}; // 這次接聽嘗試的身分 token——見建構子 `_connectAttempt` 欄位說明
    this._connectAttempt = attempt;
    fetch("/api/call/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callId }),
    })
      .then((r) =>
        r
          .json()
          .catch(() => ({}))
          .then((body) => ({ ok: r.ok, status: r.status, body }))
      )
      .then((res) => {
        if (this._connectAttempt !== attempt) return; // 已被取代（掛斷／再次嘗試），這次回呼不算數
        if (!res.ok) {
          const detail = res.body && res.body.detail;
          this._abortFailedAccept(); // 內含把 _connectAttempt 清回 null
          this._setStatusMsg(detail || t("phone.missed"));
          return;
        }
        this._callId = (res.body && res.body.call_id) || callId;
        this._connectAttempt = null; // 成功了，這次嘗試的任務結束
      })
      .catch((err) => {
        if (this._connectAttempt !== attempt) return; // 同上
        console.warn("[phone] accept failed:", err);
        this._abortFailedAccept();
        this._setStatusMsg(t("phone.answerFailed"));
      });
  }

  /** 拒接：立即收浮層停鈴（不等回應）→ POST decline（逐行對齊參考實作同款函式）。 */
  declineIncomingCall() {
    const callId = this._incomingCallId;
    this._hideIncomingOverlay();
    if (!callId) return;
    fetch("/api/call/decline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: callId }),
    }).catch((err) => console.warn("[phone] decline failed:", err));
  }

  // ── DOM 建構 ──────────────────────────────────────────────────────────────
  _buildDom() {
    const panel = document.createElement("div");
    panel.className = "phone-panel";
    panel.hidden = true;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "phone-close";
    tAttr(closeBtn, "aria-label", "phone.close");
    closeBtn.innerHTML = PHONE_SVG.close;
    closeBtn.addEventListener("click", () => this.close());
    panel.appendChild(closeBtn);

    // 待撥視圖：留言卡插槽＋狀態列＋大撥出鍵。
    const idleView = document.createElement("div");
    idleView.className = "phone-view phone-view-idle";

    const vmSlot = document.createElement("div");
    vmSlot.className = "phone-voicemail-slot";
    idleView.appendChild(vmSlot);

    const statusMsg = document.createElement("div");
    statusMsg.className = "phone-status-msg";
    statusMsg.setAttribute("aria-live", "polite");
    idleView.appendChild(statusMsg);

    const dialBtn = document.createElement("button");
    dialBtn.type = "button";
    dialBtn.className = "phone-dial-btn";
    tAttr(dialBtn, "aria-label", "phone.dial");
    dialBtn.innerHTML = PHONE_SVG.phone;
    dialBtn.addEventListener("click", () => this.dialOut());
    idleView.appendChild(dialBtn);
    panel.appendChild(idleView);

    // 通話視圖（計時／狀態／掛斷頂條）整組退場——掛斷入口搬到
    // 左側欄電話鈕（通話中原地變掛斷樣＋鈕旁計時 pill，onCallState 交呼叫端
    // 渲染）；通話內容早就進了真正的 Chat Log。面板剩下的存在
    // 理由只有留言卡插槽（現制恆空）與來電浮層。

    this.container.appendChild(panel);

    // 來電浮層（頁級：接通前沒有嘴型動畫可看，用全頁式較合理）。
    const incomingOverlay = document.createElement("div");
    incomingOverlay.className = "phone-incoming-overlay";
    incomingOverlay.hidden = true;

    const reason = document.createElement("div");
    reason.className = "phone-incoming-reason";
    incomingOverlay.appendChild(reason);

    const actions = document.createElement("div");
    actions.className = "phone-incoming-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "phone-accept-btn";
    tAttr(acceptBtn, "aria-label", "phone.answer");
    acceptBtn.innerHTML = PHONE_SVG.phone;
    acceptBtn.addEventListener("click", () => this.acceptIncomingCall());
    const declineBtn = document.createElement("button");
    declineBtn.type = "button";
    declineBtn.className = "phone-decline-btn";
    tAttr(declineBtn, "aria-label", "phone.decline");
    declineBtn.innerHTML = PHONE_SVG.hangup;
    declineBtn.addEventListener("click", () => this.declineIncomingCall());
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    incomingOverlay.appendChild(actions);

    this.container.appendChild(incomingOverlay);

    this._dom = {
      panel,
      idleView,
      vmSlot,
      statusMsg,
      incomingOverlay,
      incomingReason: reason,
    };
  }

  /** 通話內容單一出口：交給呼叫端渲進 Chat Log；未接線（測試等）
   * 安全 no-op，回呼自身出錯也不擋通話流程。 */
  _emitContent(ev) {
    if (!this.onCallContent) return;
    try {
      this.onCallContent(ev);
    } catch (e) {
      console.warn("[phone] onCallContent handler failed:", e);
    }
  }

  /** 通話狀態單一出口：左側欄鈕樣態＋計時 pill 的資料源。
   * 未接線安全 no-op；回呼出錯不擋通話流程。 */
  _notifyState(phase) {
    if (!this.onCallState) return;
    try {
      this.onCallState({ phase, seconds: this._seconds });
    } catch (e) {
      console.warn("[phone] onCallState handler failed:", e);
    }
  }

  _renderActiveView() {
    // 通話中面板不再現身（頂條退場，狀態走 onCallState）——面板
    // 唯一的存在理由剩「有留言卡要聽」（v7 語意，現制 vmSlot 恆空＝恆藏）。
    const inCall = this.state === "in-call" || this.state === "dialing";
    const hasVoicemail = this._dom.vmSlot && this._dom.vmSlot.childElementCount > 0;
    this._dom.idleView.hidden = inCall || !hasVoicemail;
    this._dom.panel.hidden = inCall || !hasVoicemail;
  }

  _setStatusMsg(text) {
    this._dom.statusMsg.textContent = text;
    // v7：訊息同步交給 Chat Log（面板的狀態行已由 CSS 隱藏——單一可見出口在聊天流）
    if (this.onStatusNote && text) this.onStatusNote(text);
  }

  _clearStatusMsg() {
    this._dom.statusMsg.textContent = "";
  }

  /** 單一聲源鐵則的另一半——`isActive()` 只擋
   * 「之後」新的 `TtsSpeaker.speak()` 呼叫，擋不住「已經在飛」的那一句，撥號／接聽
   * 這兩個「電話開始」的動作本身必須主動收掉它，不能留使用者同時聽到兩個聲音搶話。
   * `tts` 是選用注入（見建構子），沒接線的呼叫端（如既有測試）呼叫這裡安全 no-op。 */
  _stopChatTts() {
    if (this.tts && typeof this.tts.stop === "function") this.tts.stop();
  }

  // ── 撥出／接聽共用：進通話畫面 ──────────────────────────────────────────────
  _enterCallScreen() {
    this.state = "in-call";
    this._seconds = 0;
    this._notifyState("in-call"); // pill 從「接通中」轉 00:00（_connected 起每秒跳）
    this._renderActiveView();
    this._queue = [];
    this._finalPending = false;
    this._playing = false;
    this._typedSttMode = false; // 每通重新以語音假設開場（開口失敗的提示照常）
    // 每次進通話鑄一顆新的麥克風身分 token——上一通遲到的
    // getUserMedia 回呼（成功或失敗）比對不符就作廢，不會把舊 stream 掛上
    // 新通話、也不會用舊的權限失敗把新通話掛斷。刻意不重用 _connectAttempt
    // （撥號流程的 finally 會太早把它清成 null，比對會失真）。
    this._micSession = {};
    this._startMic();
  }

  _abortFailedAccept() {
    this._connectAttempt = null;
    this.state = "idle";
    this._callId = null;
    this._teardownMedia();
    this._renderActiveView();
  }

  // ── 麥克風／VAD（數值與流程沿用既有實作）───────────────────────────
  _micErrText(err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return t("phone.micDenied");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") return t("phone.micNotFound");
    if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
      return t("phone.micBusy");
    }
    return t("phone.micOpenFail", { reason: name || t("phone.unknown") });
  }

  _startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._setStatusMsg(t("phone.micUnsupported"));
      this.hangUp();
      return;
    }
    const session = this._micSession; // 本次身分——遲到回呼比對用（見 _enterCallScreen）
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true } })
      .then((stream) => {
        if (this.state !== "in-call" || this._micSession !== session) {
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch (e) {
            /* 已經沒有意義，安全略過 */
          }
          return;
        }
        this._stream = stream;
        this._setupVad(stream);
        this._connected();
      })
      .catch((err) => {
        if (this._micSession !== session) return; // 上一通遲到的失敗，不動這一通
        console.warn("[phone] mic denied:", err);
        this._setStatusMsg(t("phone.noCall", { msg: this._micErrText(err) }));
        this.hangUp();
      });
  }

  _connected() {
    this._seconds = 0;
    this._notifyState("in-call");
    if (this._timerHandle) clearInterval(this._timerHandle);
    this._timerHandle = setInterval(() => {
      this._seconds += 1;
      this._notifyState("in-call"); // 每秒交呼叫端更新 pill
    }, 1000);
  }

  _fmtTime(s) {
    const p = (n) => (n < 10 ? "0" + n : String(n));
    return p(Math.floor(s / 60)) + ":" + p(s % 60);
  }

  _now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  _rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / (buf.length || 1));
  }

  /** 自適應開口門檻：校準期 RMS 均值 × 1.6，floor 0.01（沿用既有實作同款函式）。 */
  _calibrateThreshold(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i];
    const mean = sum / (samples.length || 1);
    return Math.max(0.01, mean * 1.6);
  }

  _setupVad(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // jsdom／不支援 Web Audio 的環境：優雅無 VAD，通話仍可進行（只是不會自動錄音）
    let ctx;
    try {
      ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      this._analyser = ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      src.connect(this._analyser);
      this._audioCtx = ctx;
    } catch (e) {
      this._analyser = null;
      return;
    }
    this._calibrating = true;
    this._calibSamples = [];
    this._calibStart = this._now();
    this._threshold = 0.01;
    this._speaking = false;
    this._silenceStart = null;
    if (this._vadRaf) cancelAnimationFrame(this._vadRaf);
    this._vadRaf = requestAnimationFrame(() => this._vadLoop());
  }

  _vadLoop() {
    if (this.state !== "in-call" || !this._analyser) {
      this._vadRaf = null;
      return;
    }
    const buf = new Float32Array(this._analyser.fftSize || 2048);
    try {
      this._analyser.getFloatTimeDomainData(buf);
    } catch (e) {
      /* 忽略單幀讀取失敗，下一幀再試 */
    }
    const rms = this._rms(buf);
    const now = this._now();

    if (this._playing || this._turnActive) {
      // 半雙工：他在說話（含句間空窗）＝不開錄。
      this._vadRaf = requestAnimationFrame(() => this._vadLoop());
      return;
    }
    if (this.getTypingActive && this.getTypingActive()) {
      // 打字＝不當語音。鍵盤聲／環境音在打字期間誤觸 VAD
      // →STT 轉不出字→（沒聽清楚）洗版（體感像是系統壞掉）。打字
      // 判準由呼叫端注入（輸入框 focus 或有內容）；正在誤錄的段落當場作廢
      // 丟棄（不上傳＝不會產生任何提示）。真的用麥克風講話（手不在輸入框）
      // 時行為不變，（沒聽清楚）仍照常提示。
      if (this._recorder) this._abortSegment();
      this._speaking = false;
      this._silenceStart = null;
      this._vadRaf = requestAnimationFrame(() => this._vadLoop());
      return;
    }
    if (this._calibrating) {
      this._calibSamples.push(rms);
      if (now - this._calibStart >= 1000) {
        this._threshold = this._calibrateThreshold(this._calibSamples);
        this._calibrating = false;
      }
      this._vadRaf = requestAnimationFrame(() => this._vadLoop());
      return;
    }
    const loud = rms >= this._threshold;
    if (!this._speaking) {
      if (loud) {
        this._speaking = true;
        this._silenceStart = null;
        this._beginSegment();
      }
    } else if (loud) {
      this._silenceStart = null;
    } else if (this._silenceStart === null) {
      this._silenceStart = now;
    } else if (now - this._silenceStart >= this._silenceMs) {
      this._speaking = false;
      this._silenceStart = null;
      this._endSegment();
    }
    this._vadRaf = requestAnimationFrame(() => this._vadLoop());
  }

  _beginSegment() {
    if (this._recorder || !this._stream) return;
    let rec;
    try {
      rec = new MediaRecorder(this._stream);
    } catch (e) {
      return;
    }
    this._recorder = rec;
    this._chunks = [];
    rec.ondataavailable = (e) => {
      if (e && e.data && e.data.size) this._chunks.push(e.data);
    };
    rec.onstop = () => {
      const mime = rec.mimeType || "audio/webm";
      const blob = this._chunks.length ? new Blob(this._chunks, { type: mime }) : null;
      this._recorder = null;
      this._chunks = [];
      // 被 _abortSegment 作廢的段落（打字期間的誤錄）直接丟棄，
      // 不上傳＝不會冒出（沒聽清楚）。
      if (this._discardNext) {
        this._discardNext = false;
        return;
      }
      if (blob && blob.size > 0) this._upload(blob, mime);
    };
    try {
      rec.start();
    } catch (e) {
      this._recorder = null;
    }
  }

  _endSegment() {
    if (this._recorder && this._recorder.state !== "inactive") {
      try {
        this._recorder.stop();
      } catch (e) {
        /* 已經停了或不合法狀態，安全略過 */
      }
    }
  }

  /** 作廢當前錄音段（打字防錄用）：停下 recorder 但 onstop 丟棄結果不上傳。 */
  _abortSegment() {
    this._discardNext = true;
    this._endSegment();
  }

  /** POST utterance → 拿到 STT 文字 → 上 Chat Log（onCallContent）＋透過既有聊天
   * WS 送出通話輪訊息（這是 REST 之外唯一觸發回覆的路徑，走
   * chatClient.send，不是另開連線）。 */
  _upload(blob, mime) {
    const fd = new FormData();
    fd.append("audio", blob, "seg.webm");
    fd.append("mime", mime || (blob && blob.type) || "");
    fetch("/api/call/utterance", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((data) => {
        const text = data ? data.text : null;
        const textOk = !(text === null || text === undefined || text === "");
        if (!textOk) {
          // 打字模式中的空轉寫＝環境音誤觸，靜默丟棄（見建構子）。
          if (this._typedSttMode) return;
          this._emitContent({ type: "sys", text: t("phone.unclear") });
          return;
        }
        this._typedSttMode = false; // 真的開口了——回語音互動，（沒聽清楚）提示恢復
        this._emitContent({ type: "user", text });
        this._emitContent({ type: "thinking" });
        this.chatClient.send(JSON.stringify({ call: true, text }));
      })
      .catch((err) => {
        console.warn("[phone] utterance failed:", err);
        if (this._typedSttMode) return; // 打字模式：上傳失敗同樣不洗提示（console 留證）
        this._emitContent({ type: "sys", text: t("phone.unclear") });
      });
  }

  // ── 下行 call frame：台詞進 Chat Log（onCallContent）＋音檔佇列 ──
  _onCallFrame(data) {
    if (this.state !== "in-call") return; // 未在通話中＝忽略殘留幀
    this._turnActive = true;
    const text = data ? data.text : "";
    const audio = data && data.audio ? data.audio : null;
    const isFinal = !!(data && data.final === true);
    // 角色的台詞逐句交給 Chat Log 渲染（同一輪長在同一顆泡泡，
    // audio URL 一併帶去＝句尾 play 鍵**即時**出現，不必等 F5 歷史回填）。
    this._emitContent({ type: "character", text, audio, final: isFinal });
    if (audio) {
      envelopeForUrl(audio); // 樂譜制：句子進佇列即預熱嘴型譜（播放時大概率已就緒）
      this._queue.push({ audio });
      this._playNext();
    }
    if (isFinal) {
      this._finalPending = true;
      if (!this._playing && this._queue.length === 0) this._finishTurn();
    }
  }

  _ensureAudioEl() {
    if (!this._audioEl) {
      try {
        this._audioEl = new Audio();
      } catch (e) {
        this._audioEl = null;
      }
    }
    return this._audioEl;
  }

  /** 撥號按鈕同步脈絡內（任何 await 之前）解鎖持久播放元件——這不是新增
   * AudioContext，是純 HTMLMediaElement 手勢優先播放規則的另一道閘。 */
  _unlockAudioForIOS() {
    try {
      const el = this._ensureAudioEl();
      if (!el) return;
      el.src = SILENT_WAV;
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* 解鎖失敗也無妨——播放失敗仍有 _handlePlayRejection 的手勢恢復防線 */
    }
  }

  _playNext() {
    if (this._playing) return;
    if (this._queue.length === 0) {
      if (this._finalPending) this._finishTurn();
      return;
    }
    const item = this._queue.shift();
    this._playing = true;
    const el = this._ensureAudioEl();
    if (!el) {
      this._settlePlay(this._playGen);
      return;
    }
    this._playGen += 1;
    const gen = this._playGen;
    this.driver.attach(el); // 招牌場景：他正在說這句話，嘴巴要動
    // 樂譜制：這句的嘴型譜跟句走（預熱過＝快取同一份 promise；沒好＝先拍嘴、
    // 好了熱切換）。guard 防禦：driver 由呼叫端注入，舊版沒這方法也不炸。
    if (typeof this.driver.setEnvelope === "function") {
      this.driver.setEnvelope(envelopeForUrl(item.audio));
    }
    el.onended = () => this._settlePlay(gen);
    el.onerror = () => this._settlePlay(gen);
    try {
      el.src = item.audio;
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch((err) => this._handlePlayRejection(gen, err));
    } catch (e) {
      this._settlePlay(gen);
    }
  }

  _settlePlay(gen) {
    if (gen !== this._playGen) return; // stale 回呼，已被推進過
    this._playing = false;
    this._playNext();
  }

  _handlePlayRejection(gen, err) {
    console.warn("[phone] play() rejected:", err);
    if (err && err.name === "NotAllowedError" && !this._autoplayUnlockShown) {
      this._autoplayUnlockShown = true;
      this._setStatusMsg(t("phone.tapForSound"));
      this._armAutoplayRecovery();
    }
    this._settlePlay(gen);
  }

  _armAutoplayRecovery() {
    if (this._autoplayRecoveryArmed) return;
    this._autoplayRecoveryArmed = true;
    this._retryPlayHandler = () => this._retryPlayAfterGesture();
    document.addEventListener("click", this._retryPlayHandler, true);
    document.addEventListener("touchstart", this._retryPlayHandler, true);
  }

  _disarmAutoplayRecovery() {
    if (!this._autoplayRecoveryArmed) return;
    this._autoplayRecoveryArmed = false;
    document.removeEventListener("click", this._retryPlayHandler, true);
    document.removeEventListener("touchstart", this._retryPlayHandler, true);
    this._retryPlayHandler = null;
  }

  _retryPlayAfterGesture() {
    const el = this._audioEl;
    if (!el) {
      this._disarmAutoplayRecovery();
      return;
    }
    this._playGen += 1;
    const gen = this._playGen;
    el.onended = () => this._settlePlay(gen);
    el.onerror = () => this._settlePlay(gen);
    try {
      const p = el.play();
      if (p && typeof p.then === "function") {
        p.then(() => this._disarmAutoplayRecovery()).catch(() => {});
      } else {
        this._disarmAutoplayRecovery();
      }
    } catch (e) {
      /* 留著等使用者下次點 */
    }
  }

  _finishTurn() {
    this._finalPending = false;
    this._playing = false;
    this._turnActive = false;
    // 曾回報「第一段動、第二段起不動」的 bug：**段間不再 detach**——整通電話
    // 驅動器掛著不拆（audio-mouth 同元素 attach 已短路免重建），嘴的開合交給
    // 「元件在播才動」的門自然管（播完 paused → 殘響窗過 → 閉嘴），下一輪零
    // 重建零風險。真正的拆點只剩收線（_teardownMedia → driver.detach）。
    this._speaking = false;
    this._silenceStart = null;
  }

  // ── 收線 ──────────────────────────────────────────────────────────────────
  _teardownMedia() {
    if (this._vadRaf) {
      cancelAnimationFrame(this._vadRaf);
      this._vadRaf = null;
    }
    if (this._recorder) {
      try {
        if (this._recorder.state !== "inactive") this._recorder.stop();
      } catch (e) {
        /* 安全略過 */
      }
      this._recorder = null;
    }
    this._chunks = [];
    if (this._audioEl) {
      try {
        this._audioEl.pause();
      } catch (e) {
        /* 安全略過 */
      }
      try {
        this._audioEl.onended = null;
        this._audioEl.onerror = null;
      } catch (e) {
        /* 安全略過 */
      }
      try {
        this._audioEl.src = "";
      } catch (e) {
        /* 安全略過 */
      }
    }
    this.driver.detach(); // 通話中途掛斷也要讓嘴巴立刻合起來
    this._disarmAutoplayRecovery();
    this._autoplayUnlockShown = false;
    this._queue = [];
    this._playing = false;
    this._turnActive = false;
    this._finalPending = false;
    // 回歸修復：留言播放與通話回覆共用同一顆
    // `_audioEl`（見 `_ensureAudioEl`）——若留言播放中途被這裡強制打斷（上面的
    // `pause()` 會真的停掉共用元件），`onended`／`onerror`（`_playVoicemail` 的
    // `settle`）不會自然觸發，這個旗標若不在這裡一併重置就會卡 true 到天長地久，
    // 讓 `isActive()` 永遠回真、聊天 TTS 從此被永久壓制，即使電話早就掛斷回到 idle。
    this._voicemailPlaying = false;
    if (this._audioCtx) {
      try {
        this._audioCtx.close();
      } catch (e) {
        /* 安全略過 */
      }
      this._audioCtx = null;
    }
    this._analyser = null;
    if (this._stream) {
      try {
        this._stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        /* 安全略過 */
      }
      this._stream = null;
    }
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
    this._seconds = 0;
    this._speaking = false;
    this._silenceStart = null;
    this._calibrating = true;
    this._calibSamples = [];
    // 任何收線出口（掛斷／接聽失敗／mic 失敗）都在這裡復位
    // 左側欄鈕與計時 pill——單一收斂點，不必每個出口各自記得。
    this._notifyState("idle");
  }

  // ── 來電浮層 ────────────────────────────────────────────────────
  _showIncomingCall(data) {
    const callId = data && data.call_id;
    if (!callId) return; // 幀壞了（無 call_id）＝沒東西可顯示，安全略過
    this._incomingCallId = callId;
    this._dom.incomingReason.textContent = (data && data.reason) || "";
    this._dom.incomingOverlay.hidden = false;
    this._playRingtone();
  }

  _playRingtone() {
    try {
      const path = this.config && this.config.ringtonePath;
      if (!path) return;
      if (!this._ringtoneEl) this._ringtoneEl = new Audio(path);
      this._ringtoneEl.loop = true;
      try {
        this._ringtoneEl.currentTime = 0;
      } catch (e) {
        /* 尚未就緒，忽略；不連坐擋下面的 play() */
      }
      const p = this._ringtoneEl.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* 靜默——鈴聲播不出來不影響浮層顯示 */
    }
  }

  _stopRingtone() {
    if (!this._ringtoneEl) return;
    try {
      this._ringtoneEl.pause();
      this._ringtoneEl.currentTime = 0;
    } catch (e) {
      /* 安全略過 */
    }
  }

  _hideIncomingOverlay() {
    this._dom.incomingOverlay.hidden = true;
    this._stopRingtone();
    this._incomingCallId = null;
  }

  /** 任何 status 都收（missed/accepted/declined）——這個 frame 也用來通知「別的分頁已經處理過這通」。 */
  _dismissIncomingCall(callId, status) {
    if (!this._incomingCallId || callId !== this._incomingCallId) return;
    this._hideIncomingOverlay();
  }

  // ── 留言（懸浮留言卡退場）────────────────────────────────────────
  // 舊制＝面板浮一張 phone-voicemail 卡（_buildVoicemailCard／_playVoicemail，
  // 已移除）。新制＝留言以帳本 System 行進 Chat Log、行尾紫圓
  // play 鍵內嵌重播（chat.js 的 replay 機制；audio URL 帶 ?cid=，播放時由
  // app.js 的 replayHooks.onUrl 回報 /api/call/voicemail/played，listened 認知
  // 鏈不斷；動嘴同樣走 replayHooks.attach → driver）。_refreshLog 仍負責
  // silence_sec 配置同步（VAD 斷句秒數來源），只是不再渲染任何卡。
  async _refreshLog() {
    try {
      const res = await fetch("/api/call/log", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const sil = parseFloat(data && data.config && data.config.silence_sec);
      this._silenceMs = Math.round((isFinite(sil) && sil > 0 ? sil : 3) * 1000);
      // 留言卡退場：vmSlot 恆空（:empty CSS 藏、hasVoicemail 顯隱邏輯自然歸位）
      this._dom.vmSlot.innerHTML = "";
    } catch (err) {
      console.warn("[phone] call log failed to load:", err);
    }
  }
}
