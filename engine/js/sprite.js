/**
 * SpritePlayer——差分翻頁引擎。眼嘴獨立軸：顯示幀 = frameFor(eye, mouth)。
 *
 * 眼軸態數由 manifest 自己宣告（`manifest.eyeStates === 3`），不是引擎寫死、也不是
 * 呼叫端 opts 決定：manifest 給 3 走三態（open/half/closed，9 幀 A-I）查表＋柔滑眨眼
 * 序列；沒給這個鍵（或值不是 3）維持舊版兩態（open/closed，6 幀 A-F）查表＋既有硬切
 * 眨眼——向下相容：舊 manifest 不用改一個字，行為與改版前逐位元組相同（見
 * sprite.test.js「6 張向下相容」describe block）。用 manifest 自報而非「有沒有 G 這把
 * 鑰匙」之類的隱性偵測，是因為隱性偵測在 mood 只定義部分幀時會誤判；用 manifest 而非
 * opts，是因為同一份 manifest 不管誰載入、用什麼 opts 建構，行為都該一樣。
 */
const FRAME_TABLE_2 = { open: ["A", "B", "C"], closed: ["D", "E", "F"] };
const FRAME_TABLE_3 = { open: ["A", "B", "C"], half: ["D", "E", "F"], closed: ["G", "H", "I"] };

export class SpritePlayer {
  constructor(container, opts = {}) {
    this.container = container;
    this.assetsPath = opts.assetsPath || "assets/sample/";
    // 眨眼節奏（先調快更密、後回調「間隔再鬆一點」：
    // 1.2-3.2s 體感太頻繁）：間隔 1.8-4.2s 隨機（平均 ~3s——比最初 2-6s 勤、
    // 比 1.2-3.2s 鬆）；眨眼速度维持快版 45+90+45 ≈ 180ms（只嫌頻率、沒嫌速度）。
    this.blinkMinMs = opts.blinkMinMs ?? 1800;
    this.blinkMaxMs = opts.blinkMaxMs ?? 4200;
    this.blinkHoldMs = opts.blinkHoldMs ?? 90;
    // 半閉幀單邊停留（3 態眨眼序列 open→half→closed→half→open 的 half 段）。
    // 比 blinkHoldMs 短，讓序列讀起來是「路過」半閉、「停留」在閉，不是三段等長
    // 顯得呆板（原 60-80ms 手感區間被「要更快」的回饋取代）。
    // 2 態舊行為完全不用這個值。
    this.blinkHalfMs = opts.blinkHalfMs ?? 45;
    this._eye = "open";
    this._mouth = 0;
    this._mood = "neutral";
    this._frames = null;
    this._img = null;          // static／degraded 模式的單張圖（疊圖制下為 null）
    this._stack = null;        // 疊圖制：frameFile → 常駐 <img>
    this._shownFrame = null;   // 疊圖制當前亮著的幀檔名
    this._blinkTimer = null;
    this._blinkSeqTimers = [];  // _blinkNow() 排的多段 setTimeout，stopIdle 要能整串取消
    this._talkTimer = null;     // startTalking() 的口型循環
    this._degraded = false;
    this._static = false;       // static 造型：單張圖、動作全 no-op
    this._eyeStates = 2;        // load() 讀到 manifest 前的安全預設，讀到後才是真正值
    this._frameTable = FRAME_TABLE_2;
    // 幀同步鉤子：眼／嘴狀態每次改變通知一次 (eye, mouth)——表情層靠它挑「當下該亮
    // 哪一態的貼片」。去重 key＝eye|mouth；鉤子丟例外只 warn 不擋渲染。
    this.onFrame = null;
    this._lastFrameKey = null;
  }

  /** manifest 唯讀窗口（blush.js 讀 `blush` 鍵判此造型可否臉紅、expression.js 讀
   * `expressions` 表——「manifest 宣告非引擎猜測」同一份真相，不讓呼叫端二次 fetch）。
   * 載入前＝null。 */
  get manifest() {
    return this._manifest || null;
  }

  async load() {
    const res = await fetch(this.assetsPath + "manifest.json");
    if (!res.ok) throw new Error("manifest load failed");
    this._manifest = await res.json();
    // 畫布比例／中心對齊（新造型可能為免邊緣裁切、同高加寬成
    // 1300×1536——顯示端原本寫死 aspect-ratio 1024/1536，寬畫布塞進窄框＝整隻
    // 被縮小）。manifest.size 自報比例進 CSS 變數（layout.css 的 #stage 吃）；
    // 寬於 1024 基準的畫布另給「中心對齊位移」：生成人物通常都在畫布中心，
    // 桌機 stage 錨左緣＝寬畫布會把人推右——用自身寬度百分比左移半個差值＝
    // 畫布中心對齊 1024 版中心＝人物視覺位置不漂（百分比制免 resize 重算；
    // 手機 stage 本就置中、layout.css 該處 transform:none 歸零）。無 size 的
    // manifest（如 static 造型）＝清變數走 1024/1536 fallback。
    const sz = Array.isArray(this._manifest.size) ? this._manifest.size : null;
    if (sz && sz[0] > 0 && sz[1] > 0) {
      this.container.style.setProperty("--sprite-aspect", `${sz[0]} / ${sz[1]}`);
      const shift = sz[0] > 1024 ? -(((sz[0] - 1024) / (2 * sz[0])) * 100) : 0;
      this.container.style.setProperty("--sprite-canvas-shift", `${shift.toFixed(3)}%`);
    } else {
      this.container.style.removeProperty("--sprite-aspect");
      this.container.style.removeProperty("--sprite-canvas-shift");
    }
    // 底部透明帶補償（手機邊緣要貼底）：各套畫布底部透明帶
    // 0-11% 不等（生成畫布留白），manifest 自報 bottomGap（0-1 分數、建置管線
    // PIL 量測寫入）→ 手機 CSS 以自身高度百分比往下推＝人物真實下緣貼底。
    // 無鍵＝0%（1024 老 fallback 與 static 造型不動）。
    const gap = typeof this._manifest.bottomGap === "number" ? this._manifest.bottomGap : 0;
    if (gap > 0 && gap < 0.5) {
      this.container.style.setProperty("--sprite-bottom-push", `${(gap * 100).toFixed(2)}%`);
    } else {
      this.container.style.removeProperty("--sprite-bottom-push");
    }
    // static 造型（單張立繪、或臉被面罩遮住的角色：不眨眼、嘴也不動）：
    // manifest 自報 static:true＋image 單鍵（同 eyeStates 的「manifest 宣告、非引擎
    // 猜測」哲學）。載一張圖直接上屏；setMouth／眨眼／口型全走 _static guard
    // 靜默 no-op——呼叫端（MouthDriver 的譜面查表與拍嘴、ADV pakupaku、startIdle）一行
    // 都不用改，語音照播、只是這張臉不動。
    if (this._manifest.static === true) {
      this._static = true;
      const imageFile = this._manifest.image;
      try {
        const im = new Image();
        im.src = this.assetsPath + imageFile;
        if (typeof im.decode === "function") await im.decode();
      } catch (err) {
        // 預載失敗照樣上屏（單張圖沒有差分可壞；瀏覽器 img 自身的載入容錯接手）
        console.warn("static sprite preload failed (showing anyway):", err);
      }
      this._img = document.createElement("img");
      this._img.className = "sprite-frame";
      this._img.alt = "";
      this._img.src = this.assetsPath + imageFile;
      this.container.appendChild(this._img);
      return;
    }
    this._eyeStates = this._manifest.eyeStates === 3 ? 3 : 2;
    this._frameTable = this._eyeStates === 3 ? FRAME_TABLE_3 : FRAME_TABLE_2;
    this._frames = this._manifest.moods[this._mood];
    // 幀清單取「全部 mood 的聯集」：疊圖制一次把所有會用到的幀掛進 DOM，
    // setMood 切心情也永遠找得到已掛的幀（舊制 setMood 本就不重載、切過去
    // 遇到沒預載的幀要現抓——聯集把這個缺口一起補掉）。
    const allFiles = [...new Set(
      Object.values(this._manifest.moods).flatMap((m) => Object.values(m))
    )];
    try {
      await Promise.all(allFiles.map((f) => {
        const im = new Image();
        im.src = this.assetsPath + f;
        // decode() 是標準預載法：真正解碼完成才 resolve（比 onload 更嚴格，onload 只保證
        // response 到手、不保證已解碼可畫）。沒有 decode() 的環境（如 jsdom——本來就不會
        // 真的載圖，見下方測試檔註解）退化成不等待；測試只驗狀態機邏輯不驗「真的等到圖
        // 載完」，這裡沒有其他訊號可等。
        return typeof im.decode === "function" ? im.decode() : Promise.resolve();
      }));
    } catch (err) {
      // 載入失敗 fallback＝靜態 A 圖＋console 警告，聊天不受影響。
      // 降級後 setMouth／_blinkNow／startIdle 全靜默 no-op，畫面永遠停在初始 A
      // （this._eye/_mouth 從未被動過，_render() 自然算出 A）。
      console.warn("sprite preload failed, degraded to static frame:", err);
      this._degraded = true;
    }
    if (this._degraded) {
      // 降級＝維持舊制單張圖（不會翻頁，疊不疊沒有意義）
      this._img = document.createElement("img");
      this._img.className = "sprite-frame";
      this._img.alt = "";
      this._img.src = this.assetsPath + this._currentFrame();
      this.container.appendChild(this._img);
      return;
    }
    // 疊圖制：所有差分幀「常駐 DOM、疊在同一位置」，
    // 翻頁＝只切透明度——與換 src 重光柵化不同，opacity 是合成器層操作，跟
    // 已驗證存活的呼吸動畫（transform）同一類。實測命中的鐵證＝狀態機
    // 全跑（mouth=2）、換 src 的畫面不動（臉閉嘴、零眨眼、CSS 呼吸照動）——
    // 把「換圖」這步從光柵化路徑整個搬走，是對整族渲染殺手的架構性根治。
    this.container.classList.add("sprite-stack-host");
    this._stack = new Map();
    let anchorPlaced = false;
    for (const f of allFiles) {
      const im = document.createElement("img");
      // 第一張留在文流當「尺寸錨」（沒給自己高度的宿主靠它撐高＝舊制單張圖的
      // 佈局行為）；其餘 absolute 疊在錨上。全部幀同比例，疊起來像素對位。
      im.className = anchorPlaced ? "sprite-frame sprite-frame-stacked" : "sprite-frame";
      anchorPlaced = true;
      im.alt = "";
      im.src = this.assetsPath + f;
      im.style.opacity = "0";
      this._stack.set(f, im);
      this.container.appendChild(im);
    }
    this._render();
  }

  _frameFor(eye, mouth) { return this._frames[this._frameTable[eye][mouth]]; }
  _currentFrame() { return this._frameFor(this._eye, this._mouth); }

  _notifyFrame() {
    if (typeof this.onFrame !== "function") return;
    const key = this._eye + "|" + this._mouth;
    if (key === this._lastFrameKey) return;
    this._lastFrameKey = key;
    try { this.onFrame(this._eye, this._mouth); } catch (err) { console.warn("onFrame hook failed:", err); }
  }

  // static 造型 img.src 在 load() 設定後永不再動——_render 對 static／未載入態
  // 一律 no-op（外部仍可能呼 stopIdle 之類帶重繪的收尾函式，不能讓它們炸）。
  // 疊圖制＝亮新幀、熄舊幀（純 opacity，零 src 改動零重光柵化）；degraded 殘留
  // 的單張圖路徑維持舊制 src 寫入（不翻頁，寫的是同一張，無害）。
  _render() {
    if (this._static || !this._frames) return;
    this._notifyFrame();
    if (this._stack) {
      const f = this._currentFrame();
      if (!f || f === this._shownFrame) return;
      const next = this._stack.get(f);
      if (!next) return; // 防禦：不明幀不動畫面（狀態照走，下一幀合法再亮）
      if (this._shownFrame) {
        const prev = this._stack.get(this._shownFrame);
        if (prev) prev.style.opacity = "0";
      }
      next.style.opacity = "1";
      this._shownFrame = f;
      return;
    }
    if (this._img) this._img.src = this.assetsPath + this._currentFrame();
  }

  setMouth(level) {
    if (this._degraded || this._static) return;
    this._mouth = level; this._render();
  }

  setMood(mood) {
    if (this._static) return;
    this._mood = this._manifest.moods[mood] ? mood : "neutral";
    this._frames = this._manifest.moods[this._mood];
    this._render();
  }

  /** 換裝：同一實例重載另一套 assetsPath——外部接線（MouthDriver
   * ／ADV pakupaku／app 各處引用）全部不動。停掉所有動作 timer → 清舊圖 → 重置
   * 狀態 → 重跑 load()（新 manifest 自報 static/動態，同開機路徑）。失敗會
   * throw（同 load 契約），呼叫端自行 fallback。 */
  async switchTo(assetsPath) {
    this.stopTalking();
    this.stopIdle();
    this.assetsPath = assetsPath;
    this._degraded = false;
    this._static = false;
    this._eye = "open";
    this._mouth = 0;
    this._mood = "neutral";
    this._frames = null;
    this._manifest = null;
    if (this._img) {
      this._img.remove();
      this._img = null;
    }
    if (this._stack) {
      this._stack.forEach((im) => im.remove());
      this._stack = null;
    }
    this._shownFrame = null;
    this._lastFrameKey = null;
    await this.load();
  }

  _clearBlinkSeq() {
    this._blinkSeqTimers.forEach((t) => clearTimeout(t));
    this._blinkSeqTimers = [];
  }

  _blinkNow() {
    if (this._degraded || this._static) return;
    this._clearBlinkSeq();  // 防禦性：異常重入（例如連續手動呼叫）不疊出兩條平行序列
    if (this._eyeStates === 3) {
      // open→half→closed→half→open：half 兩段各 blinkHalfMs、closed 停留沿用既有
      // blinkHoldMs。眼軸唯一多出中間態，嘴軸完全不碰——setMouth 疊加在任一眼態上
      // 都走同一條 _frameFor(eye, mouth) 查表，不需要額外的「mid-blink 特殊處理」。
      this._eye = "half"; this._render();
      this._blinkSeqTimers.push(setTimeout(() => {
        this._eye = "closed"; this._render();
        this._blinkSeqTimers.push(setTimeout(() => {
          this._eye = "half"; this._render();
          this._blinkSeqTimers.push(setTimeout(() => {
            this._eye = "open"; this._render();
          }, this.blinkHalfMs));
        }, this.blinkHoldMs));
      }, this.blinkHalfMs));
    } else {
      // 舊版兩態：直接硬切 open→closed→open，逐位元組維持改版前行為。
      this._eye = "closed"; this._render();
      this._blinkSeqTimers.push(setTimeout(() => { this._eye = "open"; this._render(); }, this.blinkHoldMs));
    }
  }

  startIdle() {
    if (this._degraded || this._static) return;
    const loop = () => {
      const wait = this.blinkMinMs + Math.random() * (this.blinkMaxMs - this.blinkMinMs);
      this._blinkTimer = setTimeout(() => { this._blinkNow(); loop(); }, wait);
    };
    loop();
  }

  /** 說話口型循環（打字機吐字＝他在對妳講話，嘴要動——乙遊
   * pakupaku）。開合交替：閉（0）↔ 微張／張開（1/2 隨機）——與語音事件直驅
   * （audio-mouth setMouth）是兩條互斥的驅動源，互斥仲裁在 app.js 接線層
   * （語音真的響起才讓位、播完字還在跑就還回來——driver 的
   * onFlapStart/Stop 鉤子）。眼軸完全不碰，眨眼照常疊加。重入安全：已在講就
   * no-op。拍速預設 130ms；可由設定頁「嘴型速度」拉桿統一
   * 調（setTalkInterval，與 MouthDriver.setFlapMs 吃同一顆值＝打字與語音同拍）。 */
  startTalking() {
    if (this._degraded || this._static || this._talkTimer) return;
    this._talkTimer = setInterval(() => {
      this._mouth = this._mouth === 0 ? (Math.random() < 0.5 ? 1 : 2) : 0;
      this._render();
    }, this._talkMs || 130);
  }

  /** 打字口型拍速（自助拉桿）：clamp 60-180；口型在跑中＝重啟即時換速。 */
  setTalkInterval(ms) {
    const v = Math.round(Number(ms));
    if (!Number.isFinite(v)) return;
    this._talkMs = Math.min(180, Math.max(60, v));
    if (this._talkTimer) {
      clearInterval(this._talkTimer);
      this._talkTimer = null;
      this.startTalking();
    }
  }

  /** 眨眼頻率（自助拉桿）：基準間隔 ms → 實際每次間隔＝基準 ×0.6～×1.4 隨機
   * （維持現役 1800-4200／基準 3000 的區間形狀）。idle 迴圈在跑＝取消排定中的
   * 下一眨、立刻用新頻率重排（即時生效）；眨到一半的動作序列不打斷（只影響
   * 下次間隔）。clamp 1500-6000 與設定頁值域同步。 */
  setBlinkInterval(baseMs) {
    const v = Math.round(Number(baseMs));
    if (!Number.isFinite(v)) return;
    const base = Math.min(6000, Math.max(1500, v));
    this.blinkMinMs = Math.round(base * 0.6);
    this.blinkMaxMs = Math.round(base * 1.4);
    if (this._blinkTimer) {
      clearTimeout(this._blinkTimer);
      this._blinkTimer = null;
      this.startIdle();
    }
  }

  /** 停止說話口型：嘴歸閉（0）＋重繪——不停在半張嘴（同 stopIdle 的「乾淨收尾」
   * 立場）。沒在講時呼叫是安全 no-op（但嘴仍歸位，防外部驅動殘留）。 */
  stopTalking() {
    if (this._talkTimer) {
      clearInterval(this._talkTimer);
      this._talkTimer = null;
    }
    if (this._degraded || this._static) return;
    this._mouth = 0;
    this._render();
  }

  stopIdle() {
    clearTimeout(this._blinkTimer);
    this._blinkTimer = null;
    this._clearBlinkSeq();
    // 中途取消要「乾淨」：不只是不再繼續變，畫面也不該卡在 half/closed 半路——直接歸位
    // open 並重繪一次（既有 stale-timer 缺口：舊版 2 態的 reopen timer 本來就沒被
    // stopIdle 清掉，只是預設時長下不易察覺；這次連 3 態的多段序列一起補齊，見
    // sprite.test.js 兩個「stopIdle 中途取消乾淨」describe block）。degraded 模式下
    // _eye 恆為 open，這裡是 no-op 重繪，不影響既有降級行為。
    this._eye = "open";
    this._render();
  }
}
