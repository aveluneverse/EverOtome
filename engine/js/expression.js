/**
 * expression.js —— 表情貼片控制器（manifest 宣告制的整塊臉皮貼片）。
 *
 * 機制：立繪容器內疊一層 .sprite-expr（z-index 1＝疊圖幀之上、.sprite-blush z2 之下——
 * 貼片是「整塊臉皮」，紅暈要能疊在新表情上）。manifest `expressions` 鍵宣告每個表情
 * 的眉眼區／嘴區各態貼片（格式見 docs/sprite-guide.md）；角色回覆夾 [expr:ID] →
 * app 在 final reply show(ID)；沒帶 → release() 淡回平靜（每句由角色自己決定帶不帶）。
 *
 * 給幾態用幾態：眼區 states[eye]，half 缺→open（硬切眨眼），再缺→any，連 any 都沒＝
 * 該區不貼（底圖照動）；嘴區 states[mouth]，1 缺→2，再缺→any。跟 SpritePlayer.onFrame
 * 同步（bind），底圖翻到哪一態貼片就切哪一態——同表情內換態瞬切 0s（眨眼 180ms 內
 * 交叉淡會糊），只有進場 0.35s／退場 0.6s 有淡。
 *
 * mode：flash＝亮 flashHoldMs 自退（兩區都凍住＝不能講話＝只能一瞬）；sustain＝撐到
 * release() 或 sustainCapMs 保底。純呈現層：不碰 WS／帳本／引擎狀態；F5 不還原（transient，
 * 同臉紅）。素材宣告制：無 expressions 鍵／無該 id＝靜默 no-op（面罩造型／示範角色／
 * 未提供素材的造型）。
 *
 * static：常駐貼片，active 期間恆亮、先於眼嘴 append＝畫在下面；blush:"builtin"
 * 則於 active 期間為容器加 class expr-blush-builtin，CSS 壓下 .sprite-blush
 * （表情貼片自己就畫了紅暈時免疊第二層）。
 */

const FADE_IN_S = "0.35s";
const FADE_OUT_S = "0.6s";

export class ExpressionController {
  constructor(container, { flashHoldMs = 2500, sustainCapMs = 90_000 } = {}) {
    this.container = container;
    this.flashHoldMs = flashHoldMs;
    this.sustainCapMs = sustainCapMs;
    this._layer = document.createElement("div");
    this._layer.className = "sprite-expr";
    this._layer.setAttribute("aria-hidden", "true");
    container.appendChild(this._layer);
    this._defs = new Map();   // id → { mode, eyes: {state→img}, mouth: {state→img} }
    this._active = null;
    this._timer = null;
    this._eye = "open";
    this._mouth = 0;
    this._shown = new Set();  // 目前亮著的 <img>
  }

  get active() { return this._active; }
  has(id) { return this._defs.has(id); }

  /** 接 SpritePlayer 幀同步鉤子（player.onFrame）。 */
  bind(player) {
    if (!player) return;
    player.onFrame = (eye, mouth) => this._onFrame(eye, mouth);
  }

  /** 換造型（初載＋switchTo 後呼叫）：清空重建；表情瞬間歸零（新造型從平靜開始）。 */
  syncFrom(manifest, assetsPath) {
    this.clear(true);
    for (const img of [...this._layer.querySelectorAll("img")]) img.remove();
    this._defs = new Map();
    // 單張 static 立繪沒有堆疊幀容器可定位、也沒有幀可跟，expressions 鍵在 static 造型視同
    // 未宣告（照建的話貼片會定位到整個舞台＝錯位，而且 onFrame 永不觸發＝永遠停在初始態）。
    if (manifest && manifest.static === true) return;
    const table = manifest && manifest.expressions && typeof manifest.expressions === "object"
      ? manifest.expressions : null;
    if (!table) return;
    const base = String(assetsPath || "");
    for (const [id, def] of Object.entries(table)) {
      if (!def || typeof def !== "object") continue;
      const entry = {
        mode: def.mode === "flash" ? "flash" : "sustain",
        blushBuiltin: def.blush === "builtin",
        staticImg: null, eyes: {}, mouth: {},
      };
      // static 底色區：恆亮、先 append＝畫在眼嘴貼片之下
      if (typeof def.static === "string" && def.static) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = base + def.static;
        img.style.opacity = "0";
        this._layer.appendChild(img);
        entry.staticImg = img;
      }
      for (const zone of ["eyes", "mouth"]) {
        const states = def[zone] && typeof def[zone] === "object" ? def[zone] : {};
        for (const [state, file] of Object.entries(states)) {
          if (typeof file !== "string" || !file) continue;
          const img = document.createElement("img");
          img.alt = "";
          img.src = base + file;
          img.style.opacity = "0";
          this._layer.appendChild(img);
          entry[zone][state] = img;
        }
      }
      this._defs.set(id, entry);
    }
  }

  /** 亮表情。無此 id（此造型無素材）＝false 靜默；重入同 id＝重置計時。 */
  show(id) {
    const def = this._defs.get(id);
    if (!def) return false;
    this._cancelTimer();
    this._active = id;
    this._syncBlushClass(def);
    this._apply(FADE_IN_S);
    const ms = def.mode === "flash" ? this.flashHoldMs : this.sustainCapMs;
    this._timer = setTimeout(() => { this._timer = null; this.clear(false); }, ms);
    return true;
  }

  /** 這句沒帶暗號＝持續型淡回平靜。沒 active＝no-op。 */
  release() {
    if (this._active) this.clear(false);
  }

  /** 全滅（instant＝0s、換裝用；否則退場淡出）。 */
  clear(instant) {
    this._cancelTimer();
    this._active = null;
    this._syncBlushClass(null);
    const dur = instant ? "0s" : FADE_OUT_S;
    for (const img of this._shown) {
      img.style.transitionDuration = dur;
      img.style.opacity = "0";
    }
    this._shown = new Set();
  }

  _onFrame(eye, mouth) {
    this._eye = eye;
    this._mouth = mouth;
    if (this._active) this._apply(null);
  }

  _pickEye(states) {
    return states[this._eye] || (this._eye === "half" ? states.open : null) || states.any || null;
  }

  _pickMouth(states) {
    const k = String(this._mouth);
    return states[k] || (this._mouth === 1 ? states["2"] : null) || states.any || null;
  }

  /** enterS＝進場淡入秒數（show 用）；null＝換態瞬切。 */
  _apply(enterS) {
    const def = this._defs.get(this._active);
    if (!def) return;
    const want = new Set();
    if (def.staticImg) want.add(def.staticImg);
    const e = this._pickEye(def.eyes); if (e) want.add(e);
    const m = this._pickMouth(def.mouth); if (m) want.add(m);
    const entering = this._shown.size === 0 && enterS ? enterS : "0s";
    for (const img of this._shown) {
      if (!want.has(img)) { img.style.transitionDuration = "0s"; img.style.opacity = "0"; }
    }
    for (const img of want) {
      if (!this._shown.has(img)) { img.style.transitionDuration = entering; img.style.opacity = "1"; }
    }
    this._shown = want;
  }

  /** 自帶紅暈：active 表情宣告 blush:"builtin"＝容器加 class，CSS 壓下 .sprite-blush；
   * 換成非 builtin 表情／退場／換裝＝拿掉。BlushController 本身不動、計時照跑（表情退了若仍在
   * hold 內，紅暈自然回來——角色還在害羞）。 */
  _syncBlushClass(def) {
    const on = !!(def && def.blushBuiltin);
    this.container.classList.toggle("expr-blush-builtin", on);
  }

  _cancelTimer() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }
}
