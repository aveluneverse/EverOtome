import { computeEnvelope } from "./envelope.js";
import { logWarn } from "./feedback.js";

// iOS 手勢解鎖用的 44-byte 靜音 wav data URI——與 phone.js／chat.js 的 SILENT_WAV
// 是同一個常數（同一套純 HTMLMediaElement 手勢優先播放規則的解法，跟 Web Audio API／
// AudioContext 無關）。三檔各自持有一份避免互相 import 造成耦合；改動需同步三處。
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

/** TtsSpeaker——文字→後端 TTS→播放＋嘴型。開關關閉零呼叫；失敗一律靜默回落。
 * 播放元件是持久的（`_ensureAudioEl()` lazy 建立、全程重用同一顆，鏡照 phone.js
 * 的既有設計）——iOS 的手勢優先播放規則只認「同一個
 * 元件」，`prime()` 讓 app.js 在首次使用者手勢內解鎖它。`stop()` 供電話
 * 開始時收掉正在飛的聊天 TTS。 */
export class TtsSpeaker {
  constructor(opts) {
    this.endpoint = opts.endpoint;
    this.driver = opts.driver;
    this.getEnabled = opts.getEnabled;
    // 429（每日語音上限）提示回呼——選用注入，未接線的呼叫端
    // （如既有測試）行為不變。同 session 只觸發一次，見 speak() 內 _dailyCapNotified。
    this.onDailyCap = typeof opts.onDailyCap === "function" ? opts.onDailyCap : null;
    // onNoVoice（空窗期閉嘴）：TTS 開著、但「這一句確定不會出聲」的信號——
    // 合成失敗（!ok／204 純符號句／429 日帽／網路炸）或播放層失敗（onerror／
    // play() reject）時各發一次。app.js 拿它做打字口型補位：語音開著＝打字先
    // 閉嘴等聲音，等到的是「不會來了」＝打字口型接手，「合成失敗時嘴整句死
    // 掉」的舊坑不重演。開關關著的早退不發（本來就不該出聲，不是失敗）；
    // stop()（電話接管）被斬的那句不發（電話語音接管嘴）。
    this.onNoVoice = typeof opts.onNoVoice === "function" ? opts.onNoVoice : null;
    this._dailyCapNotified = false;
    this._busy = false;
    this._queue = [];
    this._maxQueue = 3;
    this._audioEl = null; // 持久播放元件（item 5）：_ensureAudioEl() lazy 建立，全程重用
    this._playDone = null; // 目前這句 _play() 的 Promise resolver——stop()（item 6）用它
                            // 讓 pending 的播放乾淨收尾，不留一個永遠不 resolve 的 promise。
  }

  async speak(text) {
    if (!this.getEnabled() || !text || !text.trim()) return;
    if (this._busy) {
      this._queue.push({ text });
      if (this._queue.length > this._maxQueue) this._queue.shift();
      return;
    }
    this._busy = true;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let blob;
      // 15s 預算要蓋到「body 真的下載完」，不能只蓋到 headers 到手就 clearTimeout——不然
      // body 卡住會讓 _busy 卡 true 到天長地久，佇列從此只進不出（先前修過的問題）。同一顆
      // ctrl/timer 蓋住 fetch() 到 res.blob() 兩步，abort() 會讓卡住的 res.blob() 以
      // AbortError 拒絕，交給下面既有的 catch 走靜默回落，行為不變。
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (!res || !res.ok || res.status === 204) {
          // 429＝每日語音上限：早就
          // 規劃過這句提示（「今天的嗓子休息了」），但這條線從沒真的接上——429 之前
          // 落進跟一般錯誤（如 500）沒有區別的靜默回落，只會覺得「他今天突然不出聲
          // 了」，不知道是額度問題。這裡同 session 只通知一次（不需要每句話都被
          // 提醒一次），實際的提示文字渲染交給呼叫端（app.js）決定，本檔只負責觸發。
          if (res && res.status === 429 && !this._dailyCapNotified) {
            this._dailyCapNotified = true;
            if (typeof this.onDailyCap === "function") this.onDailyCap();
          }
          if (res && !res.ok) logWarn("tts fallback:", res.status);
          this._noteNoVoice(); // 這句不會出聲（500/204/429 皆然）——打字口型可補位
          return;
        }
        blob = await res.blob();
      } finally { clearTimeout(timer); }
      const url = URL.createObjectURL(blob);
      // 樂譜制：blob 在手順路起算嘴型譜（離線、毫秒級、不擋播放）——
      // 不 await：先照舊開播（譜沒到＝有機拍嘴），譜好了 driver 熱切換查表。
      const envPromise = computeEnvelope(blob);
      try { await this._play(url, envPromise); } finally { URL.revokeObjectURL(url); }
    } catch (e) {
      logWarn("tts fallback:", e.name || e);
      this._noteNoVoice(); // 網路炸／超時 abort——這句同樣不會出聲
    } finally {
      this._busy = false;
      const next = this._queue.shift();
      if (next) this.speak(next.text);
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

  /** 手勢窗口內呼叫（app.js 首次 pointerdown 解鎖處理器裡，跟 driver.unlock() 並列）：
   * 同步 play() 一段靜音片段解鎖這顆持久播放元件之後的所有播放——同步、不 await，
   * 手勢優先播放規則只認「呼叫堆疊仍在使用者手勢事件
   * 內」這件事，任何 await 都會跳出手勢窗口。play() 的 rejection 用 .catch() 吞掉：
   * 解鎖失敗也無妨，最壞情況只是回到「今天沒有語音」的既有靜默回落，不會拋出未
   * 處理例外。跟 speak() 佇列／忙碌狀態完全無關——這不是「在講話」，純粹解鎖。 */
  prime() {
    // 正在播話時不解鎖——共用同一顆持久元件，SILENT_WAV 會把
    // 飛行中的那句話從喇叭上擠掉（onended 也會被搶）。忙碌＝早就解鎖過了，
    // 這次 prime 沒有存在必要，直接讓路。
    if (this._busy) return;
    try {
      const el = this._ensureAudioEl();
      if (!el) return;
      el.src = SILENT_WAV;
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {
      /* 解鎖失敗也無妨，見上 */
    }
  }

  /** 播這一句：attach → 送這句的嘴型譜（`setEnvelope`，沒有＝null＝driver 走拍嘴）
   * → 播放 → ended／error 收嘴 detach 並 resolve（播放層失敗另發 onNoVoice，見上）。
   *
   * 播放元件是單一持久 `<audio>`（`_ensureAudioEl()` lazy 建立、全程重用），不再每句話
   * `new Audio(url)` 逐句新建——per-utterance 新建的元素每次都是「沒被摸過的新元素」，
   * 不會繼承 `prime()` 解鎖過的狀態，iOS 上很可能整個 session 靜音。
   * `MouthDriver.attach()` 對同一個元素重複呼叫是安全的：現行 driver 零 WebAudio
   * 節點，attach 只掛播放事件監聽，同元素進來直接短路（見 audio-mouth.js attach 的同
   * 元素短路段），換元素才真的重掛——電話／重播鍵／聊天 TTS 共用同一顆 driver 走的就
   * 是這條，這裡沿用同一份基礎設施。 */
  _play(url, envPromise) {
    return new Promise((done) => {
      const audio = this._ensureAudioEl();
      if (!audio) { done(); return; }
      this._playDone = done;
      this.driver.attach(audio);
      // 譜跟句走（樂譜制）：每句都送——沒算或沒有＝null＝driver 走有機拍嘴。
      // guard 防禦：driver 由呼叫端注入（殼魂分離），舊版／第三方 driver 沒這方法
      // 也不炸，行為退回拍嘴。
      if (typeof this.driver.setEnvelope === "function") {
        this.driver.setEnvelope(envPromise || null);
      }
      const finish = () => {
        this._playDone = null;
        this.driver.detach();
        done();
      };
      audio.onended = finish;
      // 播放層失敗＝合成成功但沒真出聲——一樣要發 onNoVoice（空窗期閉嘴：打字
      // 口型等的是「聲音」，聲音確定不來就要補位）。play() reject 的 guard：
      // stop()（電話接管）會先清 _playDone 再 pause，pause 打斷的 reject 不算
      // 「失敗」（那句是被電話斬的，嘴由電話語音接管）。onerror 不需 guard——
      // stop() 已先把它拔成 null。
      audio.onerror = () => { this._noteNoVoice(); finish(); };
      audio.src = url;
      audio.play().catch(() => {
        if (this._playDone) this._noteNoVoice();
        finish();
      });
    });
  }

  /** 有沒有語音在路上（飛行中＋佇列）——app.js 的 onFlapStop 判準：句間空隙
   * 下一句語音還在來的路上＝嘴繼續閉著等，不還給打字機（空窗期閉嘴）。 */
  isPending() {
    return this._busy || this._queue.length > 0;
  }

  _noteNoVoice() {
    if (this.onNoVoice) {
      try { this.onNoVoice(); } catch (e) { /* 補位回呼炸掉不拖累 TTS 本體 */ }
    }
  }

  /** 電話開始（撥出／接聽，見 phone.js `_stopChatTts`）呼叫：立刻收掉正在飛的聊天
   * TTS——單一聲源鐵則的另一半：
   * `isActive()`（app.js 的 `getEnabled`）只擋「之後」新的 `speak()` 呼叫，擋不住
   * 「已經在飛」的這一句，不擋的話會同時聽到聊天回覆的語音跟電話搶話。清空整條
   * 佇列（未播的也不用了，電話一開始，剛剛還沒說出口的聊天回覆已經沒有意義）、
   * 先拔掉 onended／onerror（避免稍後遲到的事件誤觸發已經不算數的收尾邏輯）再
   * pause()、立刻讓目前這句 `_play()` 的 promise 鏈乾淨收尾（不留一個永遠不會
   * resolve 的 pending speak——`speak()` 自己的 try/finally 接手把 `_busy` 復位，
   * `_queue` 已經清空所以不會誤觸發下一句播放）、driver 立刻收嘴。沒有正在播放時
   * 呼叫也安全（單純 no-op 收尾），之後（電話結束）聊天 TTS 要能正常再叫得動。 */
  stop() {
    this._queue = [];
    const audio = this._audioEl;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch (e) {
        /* 安全略過 */
      }
    }
    this.driver.detach();
    if (this._playDone) {
      const done = this._playDone;
      this._playDone = null;
      done();
    }
    this._busy = false;
  }
}

/** TtsSynthCache——「句尾播放鍵」的現場合成＋快取（沒有存檔語音的普通聊天句
 * 也要能重播）。普通聊天的語音是即生即播、後端不落檔（電話系才有 archive）——
 * 重聽＝重合成＝再記一次字數帳，所以**同一句在同個頁面裡只合成一次**：Map 以
 * 「句子原文」為鍵存 Promise<objectURL|null>——存 Promise 而非結果，同句併發
 * 呼叫天然去重；失敗（null）當場移出快取＝下次點擊可重試，不把「剛好那次網路
 * 錯」釘成永遠沒聲音。條目超過上限逐出最舊並 revoke 其 objectURL 釋放 blob
 * 記憶體（上限 × 每句幾十 KB＝穩態個位數 MB，iOS 安全；「逐出的那句剛好還在
 * 播」需要一次播放期間點 40+ 句不同的話才會發生，真發生也只是那次播放中斷、
 * 按鈕自行還原）。429（每日語音上限）→ onDailyCap 回呼——app.js 拿與
 * TtsSpeaker 共用的 once 包裝來接（提示只需要出現一次，不是兩套機制各一次）。 */
export class TtsSynthCache {
  constructor({ endpoint, maxEntries = 40, onDailyCap = null } = {}) {
    this.endpoint = endpoint;
    this.maxEntries = maxEntries;
    this.onDailyCap = typeof onDailyCap === "function" ? onDailyCap : null;
    this._map = new Map(); // text → Promise<objectURL|null>
  }

  /** 取這句話的可播 URL：快取命中立即回、未中現場合成。永不 reject（失敗＝
   * resolve null，呼叫端〔chat.js 播放鍵〕靜默還原按鈕）。 */
  get(text) {
    if (typeof text !== "string" || !text.trim()) return Promise.resolve(null);
    if (this._map.has(text)) {
      const hit = this._map.get(text);
      // 重新插入＝更新「最近用過」序（Map 插入序當 LRU 用），常重聽的句子不被逐出
      this._map.delete(text);
      this._map.set(text, hit);
      return hit;
    }
    const p = this._fetch(text).then((url) => {
      // 只在「自己還是快取裡的那筆」時才自我移除——避免誤刪同鍵的新一輪重試
      if (url === null && this._map.get(text) === p) this._map.delete(text);
      return url;
    });
    this._map.set(text, p);
    this._trim();
    return p;
  }

  async _fetch(text) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let blob;
      // 15s 預算同 TtsSpeaker.speak：蓋到「body 真的下載完」，不是 headers 到手就算
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ctrl.signal,
        });
        if (!res || !res.ok || res.status === 204) {
          if (res && res.status === 429 && this.onDailyCap) this.onDailyCap();
          if (res && !res.ok) logWarn("tts synth fallback:", res.status);
          return null;
        }
        blob = await res.blob();
      } finally { clearTimeout(timer); }
      return URL.createObjectURL(blob);
    } catch (e) {
      logWarn("tts synth fallback:", e.name || e);
      return null;
    }
  }

  _trim() {
    while (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next().value;
      const pending = this._map.get(oldest);
      this._map.delete(oldest);
      Promise.resolve(pending).then((url) => {
        if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* no-op */ } }
      });
    }
  }
}
