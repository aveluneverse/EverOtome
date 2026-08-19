// furniture.js —— 家具擺放系統：房間裡的陳設可以放置、也可以收起。
//
// 定位：純顯示層的房間陳設——config.furniture 驅動（config 無此節＝整族不長、
// DOM 與沒有這支模組時一模一樣），放置選擇記 localStorage `v4.furniture`
// （per-裝置，同 v4.appearance／v4.theme 慣例）。層插在房間背景之後、z-index
// 低於立繪與 UI——家具可以被視窗或按鈕遮住，人與對話恆在前。
//
// config 每件形狀：
//   { "id": "side-table", "label": "邊桌",
//     "file": "assets/furniture/side-table.webp",
//     "left": "3%", "height": "56dvh", "bottom": "-16dvh",   // CSS 原值直塞
//     "defaultOn": true }                                     // 未記錄時的預設
// left／height／bottom 是 CSS 字串原樣進 style（工程零解析＝擺位全靠 config
// 調）；「露一半」＝bottom 負值下沉，同立繪貼底放大的既有手法。
//
// 失敗紀律：壞 config 項（缺 id／file）跳過；圖載入失敗＝該件靜默缺席（onerror
// 收掉 img），聊天與立繪永不受影響。

const STORAGE_KEY = "v4.furniture";

export class FurnitureManager {
  /**
   * @param {HTMLElement} anchorEl  插入錨點（#stage-bg——家具層插它「之後」＝
   *   全畫面座標、疊在房間背景之上、CG／立繪／UI 之下；不掛 #stage 立繪框，
   *   否則會跟著立繪窄框走＋被 no-sprite 連坐藏起來）；null＝整族 no-op
   * @param {Array} items  config.furniture（缺／空＝no-op）
   */
  constructor(anchorEl, items) {
    this.items = Array.isArray(items)
      ? items.filter((it) => it && typeof it.id === "string" && it.id
          && typeof it.file === "string" && it.file)
      : [];
    this._layer = null;
    this._nodes = new Map(); // id → <img>
    this._state = this._load();
    if (anchorEl && this.items.length) {
      this._layer = document.createElement("div");
      this._layer.className = "furniture-layer";
      anchorEl.insertAdjacentElement("afterend", this._layer);
      this._render();
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (e) {
      return {}; // 無痕／壞 JSON＝全走 defaultOn
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state));
    } catch (e) { /* 無痕等——放置狀態這輪有效、重整回預設，不炸 */ }
  }

  /** 這件現在放著嗎？（localStorage 記錄優先、未記錄走 defaultOn） */
  isOn(id) {
    if (Object.prototype.hasOwnProperty.call(this._state, id)) {
      return !!this._state[id];
    }
    const item = this.items.find((it) => it.id === id);
    return !!(item && item.defaultOn);
  }

  /** 放置↔收起。回傳切換後狀態。未知 id＝no-op 回 false。 */
  toggle(id) {
    if (!this.items.some((it) => it.id === id)) return false;
    this._state[id] = !this.isOn(id);
    this._save();
    this._render();
    return this._state[id];
  }

  /** 外部指令出口：定向冪等版 toggle，給 room_state frame handler 用（後端推
   * 來的「這件現在該是 on／off」直接套，不用先讀 isOn 再自己判斷要不要
   * toggle）。未知 id＝no-op 回 false；現值已是目標值＝no-op 回 false（不動、
   * 不重渲染）；否則走既有 toggle（同一套 _save＋_render＋_syncBodyClass 路
   * 徑），回 true。 */
  setOn(id, on) {
    if (!this.items.some((it) => it.id === id)) return false;
    if (this.isOn(id) === !!on) return false;
    this.toggle(id);
    return true;
  }

  /** 全件現況快照（含從未記錄過、走 defaultOn 邏輯的項）。供上報／回讀用。 */
  snapshot() {
    const out = {};
    for (const it of this.items) out[it.id] = this.isOn(it.id);
    return out;
  }

  _render() {
    if (!this._layer) return;
    this.items.forEach((item) => {
      const on = this.isOn(item.id);
      let img = this._nodes.get(item.id);
      if (on && !img) {
        img = document.createElement("img");
        img.className = "furniture-item";
        img.alt = "";
        img.draggable = false;
        // 相對路徑以頁面 baseURI 解析成絕對（同 UI 皮素材注入的既有防禦：相對
        // URL 在不同解析基準下會 404，這裡一律先轉絕對）。
        try {
          img.src = new URL(item.file, document.baseURI).href;
        } catch (e) {
          return; // 壞 URL＝該件缺席
        }
        if (item.left) img.style.left = item.left;
        if (item.height) img.style.height = item.height;
        if (item.bottom) img.style.bottom = item.bottom;
        if (item.z) img.style.zIndex = String(item.z);
        img.onerror = () => {
          // 舊節點的遲到 onerror 不可以動到新節點：收起時只做 img.remove()、沒
          // 清掉 onerror，若在舊圖還沒載完就再放置一次，層裡已經是另一顆新 img
          // ——舊圖此刻才報錯，沒有這道判斷就會把新的那顆從 _nodes 刪掉（層裡留
          // 下沒人追蹤的節點、has-furniture 失準、下次 toggle 長出重複）。
          if (this._nodes.get(item.id) !== img) return;
          img.remove();
          this._nodes.delete(item.id);
          this._syncBodyClass(); // 圖壞缺席＝畫面沒家具＝不用讓位（誠實對畫面）
        };
        this._layer.appendChild(img);
        this._nodes.set(item.id, img);
      } else if (!on && img) {
        img.remove();
        this._nodes.delete(item.id);
      }
    });
    this._syncBodyClass();
  }

  /** 讓位訊號：畫面上真的有家具＝body.has-furniture＝立繪側站；全收（或全部
   * 載入失敗）＝class 移除＝回 C 位。跟「實際渲染出來的節點」走、不跟「config
   * 裡有幾件」走——圖壞了畫面是空的，立繪不該對著空氣讓位。 */
  _syncBodyClass() {
    document.body.classList.toggle("has-furniture", this._nodes.size > 0);
  }
}
