/** MouthDriver——語音播放 → 乙遊 pakupaku 口型（SpritePlayer.setMouth(0|1|2)）。
 *
 * 替換史（兩次架構替換，照順序讀）：
 *
 * ① **音量驅動**（已退役）＝WebAudio 分析鏈（AudioContext → MediaElementSource
 *    → AnalyserNode → rAF 迴圈逐幀讀 RMS）。歷經三輪加固（playing 雙保險、同
 *    元素 attach 短路＋整通單次掛載、iOS interrupted 自癒）實驗室恆正常，仍在
 *    某些機器上重現「有聲、嘴不動」——「有聲＋嘴不動」這個組合本身就是證詞：
 *    createMediaElementSource 一旦接管，聲音必須經過 WebAudio 圖才出得來；聲音
 *    出得來、嘴卻不動，代表死掉的是分析鏈自己（rAF 迴圈／analyser／ctx 狀態任
 *    一環），而那條鏈唯一的用途就是驅嘴。
 * ② **播放事件直驅**＝拋開整條 WebAudio 依賴，直接聽播放元件的事實：
 *    play/playing＝在說話＝嘴開合；pause/ended/emptied＝說完＝閉嘴。開合＝定速
 *    節拍、開口 1/2 隨機。零 AudioContext、零 rAF、零逐幀分析＝殺掉那個抓不到
 *    的殺手能寄生的整層。
 * ③ **樂譜制**（現行）＝離線掃譜對時、flap 為退路。②只知道「音檔在播」，不知
 *    道「這一瞬間有沒有聲音」——句中的換氣與逗號停頓嘴照拍，看起來不自然。
 *    envelope.js 把音檔一次性**離線**解碼成 0/1/2 嘴型譜（50ms 一幀）送進來，
 *    本檔 33ms 一 tick 拿播放元件的 currentTime 查表——有聲開嘴、**停頓閉嘴**、
 *    大聲開大口（②當時擱置的「音量開大口」在這一階段接上了）。currentTime 與
 *    聲音出自同一個時鐘＝天生同步，不會越播越歪。
 *    ②的架構前提不變：**本檔零 AudioContext、零 rAF、零逐幀音訊分析**——樂譜
 *    是 envelope.js 算好「送進來」的純資料，播放管線自始至終無人寄生，①那條
 *    分析鏈沒有復活。
 *
 * 雙模式驅動——**譜面查表優先、有機拍嘴保底**：
 *   - score 模式：呼叫端隨句子送進 envelope.js 產的嘴型譜，節拍器（33ms≈30fps）
 *     逐 tick 查表（見上 ③）。
 *   - flap 模式（無譜／譜還在算／算失敗）：有機拍嘴——拍距抖動（0.8~1.3×）、
 *     開口 60% 微張 40% 張開、15% 換氣拍（該開不開＝喘口氣）。內建成安全網：
 *     **任何一環死掉都不會比②的均勻拍嘴差，只會更自然**。
 *   - 譜遲到熱切換：句子先響（flap 先跑）→ 譜算好（毫秒級）→ 無縫切 score；
 *     切換不觸發仲裁鉤子（還在講同一句話，只是換驅動）。
 *
 * 拍速沿革：反饋「開合太快」，85ms（每秒 ~5.9 循環）調為 105ms（~4.8 循環／秒）
 * ——85 與打字 pakupaku 的 130 之間取中偏快側；之後改自助制，設定頁「嘴型速度」
 * 拉桿（range 60-180、localStorage v4.mouthFlapMs）使用者自己調，這裡只剩預設
 * 值；setFlapMs() 即時生效（拍在跑中也換速）。export＝測試直接引用。
 */

export const FLAP_MS = 105;
export const FLAP_MS_MIN = 60;
export const FLAP_MS_MAX = 180;
export const SCORE_TICK_MS = 33;    // 譜面查表節拍（≈30fps；譜本身 50ms/幀）
export const BREATH_CHANCE = 0.15;  // flap 模式：閉→開拍抽到「換氣」的機率
export const SMALL_OPEN_CHANCE = 0.6; // flap 模式：開口抽 1（微張）的機率，餘 2

// 播放元件的生死事件：前兩個＝開講，後三個＝收嘴（emptied＝src 被清空，
// phone._teardownMedia 掛斷收線會走到；多聽一個＝多一道保險）。
const START_EVENTS = ["play", "playing"];
const STOP_EVENTS = ["pause", "ended", "emptied"];

export class MouthDriver {
  constructor(sprite, opts = {}) {
    this.sprite = sprite;
    // 音量驅動制的 RMS 閾值參數位——樂譜制閾值自適應收在 envelope.js，
    // 這兩顆純粹保留讓既有呼叫端零改動。
    this.low = opts.low ?? 0.02;
    this.high = opts.high ?? 0.08;
    // 口型仲裁鉤子（「回訊息沒聲音嘴也要動」）：語音真的響起／收掉
    // 的「轉換那一刻」通知接線層（app.js）——開講＝打字口型讓位、收嘴＝打字機
    // 還在跑就把口型還給它。仲裁看「聲音的事實」（播放事件），不看開關的預測。
    this._onFlapStart = typeof opts.onFlapStart === "function" ? opts.onFlapStart : null;
    this._onFlapStop = typeof opts.onFlapStop === "function" ? opts.onFlapStop : null;
    this._flapMs = FLAP_MS; // 自助拉桿可調（setFlapMs）；預設＝檔頭常數
    this._el = null;        // 目前掛載的播放元件（phone／tts／replay 三顆單例輪流）
    this._timer = null;     // flap 模式的 setTimeout 自排鏈 handle
    this._scoreTimer = null; // score 模式的 setInterval handle
    this._flapOpen = false;
    this._env = null;       // 目前這句的嘴型譜（envelope.js 產）；null＝走 flap
    this._envGen = 0;       // 譜的世代 token：換句／換線後讓遲到的 promise 失效
    this._lastLevel = -1;   // score 模式上一次送出的嘴型（變化才 setMouth）
    this._ticks = 0;        // 節拍回呼實跑計數（mouthdebug v2：分辨「timer 在、回呼沒跑」）
    this._lastTickAt = 0;
    this._lastEvent = null;    // 最近一次收到的播放事件（mouthdebug 浮層用）
    this._lastEventAt = 0;
    // 一顆 handler 聽全部事件（解綁對稱、不會漏）——依事件種類分流開/停。
    this._onEvent = (ev) => {
      const type = ev && ev.type ? ev.type : "?";
      this._lastEvent = type;
      this._lastEventAt = this._now();
      if (START_EVENTS.indexOf(type) !== -1) this._start();
      else this._stop();
    };
  }

  _now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  /** 依元件「當下」的播放狀態立即對齊嘴型——attach 時呼叫，涵蓋「元件已經在播
   * 才掛上來」的時序（chat 重播路 attach 與 play 的先後不強求；phone 是 attach
   * 先於 play，靠事件）。 */
  _sync() {
    const playing = !!(this._el && this._el.paused === false && this._el.ended !== true);
    if (playing) this._start();
    else this._stop();
  }

  // ── 譜面（score 模式）───────────────────────────────────────────────────

  /** 送進這一句的嘴型譜：Envelope 物件、Promise<Envelope|null>、或 null（明示
   * 沒有譜）。呼叫端（tts／phone／chat 重播）**每句播放都要送一次**——譜跟句走，
   * 上一句的譜絕不殘留到下一句。Promise 遲到＝先 flap、resolve 後熱切換；
   * resolve 時已換句／換線（世代不符）＝靜默丟棄。 */
  setEnvelope(envOrPromise) {
    this._envGen += 1;
    const gen = this._envGen;
    if (envOrPromise && typeof envOrPromise.then === "function") {
      this._env = null;
      envOrPromise.then((env) => {
        if (gen !== this._envGen) return; // 已換句／換線：這份譜不算數
        this._applyEnv(env);
      }, () => { /* 譜算炸＝維持 flap，永不拖累播放 */ });
    } else {
      this._applyEnv(envOrPromise || null);
    }
  }

  _applyEnv(env) {
    this._env = env && env.levels && env.levels.length ? env : null;
    // 熱切換：正在講話中（任一模式活著）→ 依新譜況換驅動；沒在講＝存著等 _start。
    if (this._timer || this._scoreTimer) {
      if (this._env && !this._scoreTimer) {
        this._clearFlap();
        this._spinScore(); // flap → score（同一句話繼續講，不觸發仲裁鉤子）
      } else if (!this._env && this._scoreTimer) {
        this._clearScore();
        this._openFlap();
        this._spinFlap(); // score → flap（譜被明示清掉：退回拍嘴）
      }
    }
  }

  /** score 節拍：33ms 逐 tick 拿 currentTime 查譜——變化才 setMouth。超出譜長
   * （尾端不足一幀被捨去）→ 閉嘴。中途譜消失（防禦）→ 退 flap。 */
  _spinScore() {
    this._lastLevel = -1;
    const tick = () => {
      this._ticks += 1;
      this._lastTickAt = this._now();
      const el = this._el;
      const env = this._env;
      if (!el || !env) {
        this._clearScore();
        this._openFlap();
        this._spinFlap();
        return;
      }
      const ms = (el.currentTime || 0) * 1000;
      const idx = Math.floor(ms / env.frameMs);
      const level = idx >= 0 && idx < env.levels.length ? env.levels[idx] : 0;
      if (level !== this._lastLevel) {
        this._lastLevel = level;
        this.sprite.setMouth(level);
      }
    };
    tick(); // 開講零延遲：立即對齊當下譜面，不等第一個 interval
    this._scoreTimer = setInterval(tick, SCORE_TICK_MS);
  }

  _clearScore() {
    if (this._scoreTimer) {
      clearInterval(this._scoreTimer);
      this._scoreTimer = null;
    }
    this._lastLevel = -1;
  }

  // ── 有機拍嘴（flap 模式＝無譜保底）──────────────────────────────────────

  _openFlap() {
    this._flapOpen = true;
    // 開口大小：60% 微張（1）40% 張開（2）——比 50/50 多一點「說話大多是小口」
    // 的真實感。開講首拍不抽換氣（第一瞬必開）。
    this.sprite.setMouth(Math.random() < SMALL_OPEN_CHANCE ? 1 : 2);
  }

  /** flap 節拍本體：setTimeout 自排鏈（取代事件直驅制的均勻 setInterval）——每拍
   * 間隔＝基準拍速 × 0.8~1.3 隨機抖動（真人說話沒有節拍器）；閉→開時 15%
   * 機率「換氣」（該開不開、多閉一拍）。與「開講轉換」分離：_start 是轉換
   * （觸發仲裁鉤子＋先開一拍），這裡只管節拍，setFlapMs 換速重排只走這裡。 */
  _spinFlap() {
    const beat = () => {
      this._ticks += 1;
      this._lastTickAt = this._now();
      if (this._flapOpen) {
        this._flapOpen = false;
        this.sprite.setMouth(0);
      } else if (Math.random() < BREATH_CHANCE) {
        // 換氣拍：維持閉嘴一拍（嘴型 0 已在上一拍送過，不重複 setMouth）
      } else {
        this._openFlap();
      }
      this._timer = setTimeout(beat, this._nextBeatMs());
    };
    this._timer = setTimeout(beat, this._nextBeatMs());
  }

  _nextBeatMs() {
    return Math.round(this._flapMs * (0.8 + Math.random() * 0.5));
  }

  _clearFlap() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._flapOpen = false;
  }

  // ── 開講／收嘴轉換（兩模式共用）─────────────────────────────────────────

  _start() {
    if (this._timer || this._scoreTimer) return; // 重入安全（同 sprite.startTalking 哲學）
    if (this._onFlapStart) {
      try { this._onFlapStart(); } catch (e) { /* 仲裁回呼炸掉不拖累驅動本體 */ }
    }
    if (this._env) {
      this._spinScore();
    } else {
      this._openFlap(); // 立即先開一拍，不等第一個 timeout（開講零延遲）
      this._spinFlap();
    }
  }

  /** 嘴型速度（自助拉桿）：clamp 到合理區間；flap 拍在跑中＝取消下一拍、用新
   * 基準重排（拖拉桿當下就聽得出節奏變）。score 模式不受影響（譜面查表的節奏
   * 來自聲音本身）。只換節奏不動仲裁——換速≠重新開講，onFlapStart/Stop 都不
   * 觸發。 */
  setFlapMs(ms) {
    const v = Math.round(Number(ms));
    if (!Number.isFinite(v)) return;
    this._flapMs = Math.min(FLAP_MS_MAX, Math.max(FLAP_MS_MIN, v));
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
      this._spinFlap();
    }
  }

  /** 語音驅動是否在走（app.js 仲裁用：打字開場時語音在講就不搶嘴）。
   * score 與 flap 任一活著都算「角色正在說話」。 */
  isFlapping() {
    return !!(this._timer || this._scoreTimer);
  }

  _stop() {
    const wasTalking = !!(this._timer || this._scoreTimer);
    this._clearFlap();
    this._clearScore();
    this.sprite.setMouth(0);   // 收嘴（sprite 對 static/degraded 自帶 no-op guard）
    if (wasTalking && this._onFlapStop) {
      try { this._onFlapStop(); } catch (e) { /* 仲裁回呼炸掉不拖累驅動本體 */ }
    }
  }

  _unbind() {
    if (!this._el) return;
    for (const t of START_EVENTS) this._el.removeEventListener(t, this._onEvent);
    for (const t of STOP_EVENTS) this._el.removeEventListener(t, this._onEvent);
    this._el = null;
  }

  attach(audioEl) {
    if (!audioEl) return;
    // 同元素短路：電話每句、每輪都 attach 同一顆持久元件，
    // 監聽器不重掛（addEventListener 同 handler 本就冪等，這裡連跑都不跑）、
    // 只對齊當下狀態。譜不動——隨後呼叫端會為新句 setEnvelope。
    // 換元素（聊天 TTS↔電話↔重播）才真的換線：舊線的譜一併作廢。
    if (this._el === audioEl) {
      this._sync();
      return;
    }
    this._unbind();
    this._envGen += 1;
    this._env = null;
    this._el = audioEl;
    for (const t of START_EVENTS) audioEl.addEventListener(t, this._onEvent);
    for (const t of STOP_EVENTS) audioEl.addEventListener(t, this._onEvent);
    this._sync();
  }

  detach() {
    this._stop();
    this._unbind();
    this._envGen += 1; // 遲到的譜 promise 從此作廢
    this._env = null;
  }

  /** 事件直驅制零 AudioContext——接口保留（app.js 首次 pointerdown 解鎖仍呼叫；
   * HTMLMediaElement 的手勢解鎖由 phone._unlockAudioForIOS／tts.prime 各自負責，
   * 與嘴無關）。樂譜的離線解碼在 envelope.js，也不需要手勢解鎖（decode 不出聲）。 */
  async unlock() {}

  /** mouthdebug 浮層的 ground truth 出口——驅動鏈每一環的當下狀態，一眼分辨死
   * 在哪層。純唯讀。 */
  debugState() {
    const el = this._el;
    let srcKind = "none";
    if (el && el.src) {
      srcKind = el.src.indexOf("blob:") === 0 ? "blob"
        : el.src.indexOf("data:") === 0 ? "data" : "url";
    }
    return {
      mode: this._scoreTimer ? "score-drive" : "event-flap",
      attached: !!el,
      flapping: this.isFlapping(),
      envFrames: this._env ? this._env.levels.length : 0, // 0＝這句沒譜（走拍嘴）
      lastLevel: this._lastLevel,
      flapTicks: this._ticks,
      lastTickAgoMs: this._lastTickAt ? Math.round(this._now() - this._lastTickAt) : null,
      elPaused: el ? el.paused : null,
      elEnded: el ? el.ended : null,
      elReadyState: el ? el.readyState : null,
      elTime: el ? Math.round((el.currentTime || 0) * 10) / 10 : null,
      srcKind,
      lastEvent: this._lastEvent,
      lastEventAgoMs: this._lastEvent ? Math.round(this._now() - this._lastEventAt) : null,
    };
  }
}
