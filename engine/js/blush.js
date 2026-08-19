/**
 * blush.js —— 臉紅暈層控制器（manifest 宣告制的貼片暈，濃度由角色自己選）。
 *
 * 機制：立繪容器內疊一層透明底紅暈貼片（.sprite-blush、z-index 恆在疊圖幀之上），
 * 角色回覆夾 [blush]（mid＝濃度 0.75）／[blush:deep]（deep＝1.0＝貼片原濃度）
 * → show(level) 淡入 → 保持 holdMs（預設 90 秒）→ 自然緩退（生理感：臉紅一陣一陣，
 * 角色繼續害羞會再發、也會從 mid 升 deep——show() 重入＝重置計時）。
 *
 * 素材契約＝「manifest 宣告非引擎猜測」哲學（eyeStates／static 同款）：manifest.json
 * 有 `"blush": "<檔名>"` 鍵＝此造型可臉紅；沒有鍵＝syncFrom 收層＋show() 靜默 no-op
 * （臉被面罩遮住的造型天然不上妝；示範角色同理零素材零報錯）。
 *
 * 純呈現層：不碰 WS／帳本／引擎狀態；F5 不還原（transient＝一陣的，重整臉就恢復
 * 平靜——與 CG 場景的 server state 持久化刻意不同，臉紅屬於一陣心跳，不做持久化）。
 */

const LEVEL_OPACITY = { mid: 0.75, deep: 1 };
const FADE_IN_S = "0.9s";
const FADE_OUT_S = "2.8s";

export class BlushController {
  constructor(container, { holdMs = 90_000 } = {}) {
    this.container = container;
    this.holdMs = holdMs;
    this._img = null; // 無 blush 素材＝null＝show no-op
    this._layer = document.createElement("div");
    this._layer.className = "sprite-blush";
    this._layer.setAttribute("aria-hidden", "true");
    this._fadeTimer = null;
    container.appendChild(this._layer);
  }

  /** 換造型（初載＋switchTo 後呼叫）：manifest 有 blush 鍵＝掛貼片；沒有＝收層。
   * 換造型瞬間臉紅歸零（新造型從平靜開始——換裝本來就是新畫面）。 */
  syncFrom(manifest, assetsPath) {
    this.clear(true);
    // 單張 static 立繪沒有堆疊幀容器可定位、也沒有幀可跟，blush 鍵在 static 造型視同未宣告
    // （照掛的話暈層會定位到整個舞台＝一張立繪尺寸的紅暈飄在錯的地方）。
    const isStatic = !!(manifest && manifest.static === true);
    const file = !isStatic && manifest && typeof manifest.blush === "string" && manifest.blush
      ? manifest.blush : null;
    if (!file) {
      if (this._img) {
        this._img.remove();
        this._img = null;
      }
      return;
    }
    if (!this._img) {
      this._img = document.createElement("img");
      this._img.alt = "";
      this._layer.appendChild(this._img);
    }
    this._img.src = String(assetsPath || "") + file;
  }

  /** 亮起（level："mid"｜"deep"；其他值當 mid 容錯）。重入＝更新濃度＋重置消退計時。 */
  show(level) {
    if (!this._img) return; // 此造型無臉紅素材（manifest 未宣告）＝靜默
    const opacity = LEVEL_OPACITY[level] || LEVEL_OPACITY.mid;
    this._cancelTimer();
    this._layer.style.transitionDuration = FADE_IN_S;
    this._layer.style.opacity = String(opacity);
    this._fadeTimer = setTimeout(() => {
      this._fadeTimer = null;
      this._layer.style.transitionDuration = FADE_OUT_S;
      this._layer.style.opacity = "0";
    }, this.holdMs);
  }

  /** 立即退（instant=true＝零動畫、換裝用；否則走緩退動畫）。 */
  clear(instant) {
    this._cancelTimer();
    this._layer.style.transitionDuration = instant ? "0s" : FADE_OUT_S;
    this._layer.style.opacity = "0";
  }

  _cancelTimer() {
    if (this._fadeTimer) {
      clearTimeout(this._fadeTimer);
      this._fadeTimer = null;
    }
  }
}
