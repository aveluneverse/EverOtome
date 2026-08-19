// appearance-labels.js —— 外觀面板卡名換語系即時重譯（造型／主題／家具共用）。
//
// 背景：app.js 建外觀面板時，三張卡表（造型／主題／家具）各自把 config 標籤
// （字串或 {locale: 字串} 物件）用 pickLabel() 算成「那一刻」的字串，直接寫
// cardName.textContent——不像其餘文案掛 data-i18n／data-i18n-attr，applyDom()
// 天生套不到（它只認三種 data-i18n* 標記，config 標籤是物件不是翻譯鍵）。使用
// 者切語系時，若沒人重新查一次 config 現值寫回同一個節點，卡名就停在切換當下
// 那一刻的語系，直到重整頁面。
//
// app.js 的 main() 是模組頂層自呼叫（見檔尾 main().catch(...)），import 就會
// 跑整套開機流程（fetch／DOM 全套），沒辦法在 jsdom 單測裡單獨匯入驗證——這支
// 重譯邏輯抽出來獨立成純函式模組，測試直接 import 這支，不碰 app.js；app.js
// 三張卡表各自 bindLocaleRelabel 一次、共用同一個 onLocaleChange 訂閱觸發。

/**
 * @param {Object} opts
 * @param {Map<string, HTMLElement>} opts.cards  id → 卡片根元素（呼叫端已建好、
 *   不重建 DOM；`.appearance-card-name` 是其後代）。
 * @param {(id: string) => string} opts.getLabel  給 id，回傳「現在」該顯示的字串
 *   （呼叫端自己決定怎麼查現值：pickLabel(config 標籤物件) 或 t(i18nKey)）。
 * @returns {() => void} relabel()：對 cards 裡每一張卡重跑 getLabel() 寫回卡名
 *   textContent（不存查過的結果——每次呼叫都是新鮮值，語系切幾次都跟得上）。
 */
export function bindLocaleRelabel({ cards, getLabel }) {
  return function relabel() {
    if (!cards || typeof cards.forEach !== "function") return;
    cards.forEach((cardEl, id) => {
      const nameEl = cardEl && cardEl.querySelector(".appearance-card-name");
      if (!nameEl) return;
      nameEl.textContent = getLabel(id);
    });
  };
}
