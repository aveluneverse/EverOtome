// engine/js/version-chip.js —— 首頁標題角版本列＋「檢查更新」（Mira 8/21 拍板設計
// A：貼標題波浪線正下方，手機貼標題同一行右側）。跟設定頁那顆檢查更新鈕共用同一份
// 查詢與狀態（update-check.js）——這裡查一次，設定頁也會跟著顯示同一份結果，反之
// 亦然。手動點擊才連線 GitHub、不自動檢查（README 隱私段同句承諾，同設定頁那顆）。
import { VERSION } from "./version.js";
import { checkForUpdate, getUpdateState, onUpdateState } from "./update-check.js";
import { t, tEl, onLocaleChange } from "./i18n.js";
import { FEEDBACK_URL } from "./feedback.js";

// 「已最新」停留多久才開始淡回鈕（批准設計：幾秒後淡回檢查更新）；淡出動畫秒數
// 同步 layout.css 的 .ver-chip-result { transition: opacity .3s ease; }——兩邊
// 數字若之後要改，記得一起改。
const LATEST_HOLD_MS = 6000;
const FADE_MS = 300;

/**
 * 掛上首頁版本列的互動：填版本號、接「檢查更新」點擊、訂閱共用狀態渲染結果。
 * `root` 預設 `document`（同 i18n.js 的 `applyDom(root)` 慣例），測試可以傳一個
 * 局部容器，不必碰整份 document。找不到 `#ver-chip`（或其必要子節點）＝安靜
 * no-op、回傳 null——理論上不該發生（markup 是 index.html 固定的一部分），防禦
 * 用而已，同專案內其它 init 函式的既有寫法。
 */
export function initVersionChip(root = document) {
  const scope = root && typeof root.querySelector === "function" ? root : document;
  const chip = scope.querySelector("#ver-chip");
  if (!chip) return null;
  const versionEl = chip.querySelector("#ver-chip-version");
  const btn = chip.querySelector(".ver-chip-check");
  const resultEl = chip.querySelector(".ver-chip-result");
  if (!versionEl || !btn || !resultEl) return null;

  versionEl.textContent = "v" + VERSION;
  // latest 態鈕先隱藏、結果行沒有連結可接手鍵盤焦點——給它 tabindex="-1"，
  // 讓它能被程式化 focus()（不進 Tab 序，滑鼠使用者完全無感），焦點才不會在
  // 鈕被 hidden 的瞬間被瀏覽器甩去 body（見下方 render() 的 latest 分支／
  // finishFadeBack()）。
  resultEl.tabIndex = -1;

  let fadeTimer = null; // 「已最新」的兩段計時器（停留→淡出）；下一次渲染／重查都要能清掉舊的
  // 查詢開始那一刻鈕是否有鍵盤焦點——一定要在 btn.disabled=true 之前這一刻讀，
  // 不能留到 render() 裡才讀：disabled 的表單控制項不可能持有焦點（focus fixup
  // rule），瀏覽器會在 btn.disabled=true 那一行同步把焦點甩到 body，render()
  // 是查詢完成（非同步、晚很多）才跑，那時候讀 document.activeElement===btn
  // 恆為 false，就算使用者原本真的用鍵盤聚焦在鈕上也一樣。render() 讀過一次
  // 就消費歸零，換語系等其它觸發 render() 的路徑不會誤讀到上一輪的舊值。
  let hadFocusBeforeQuery = false;

  function clearFadeTimer() {
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
  }

  /** 把一段帶 {tag} 佔位符的字典字串拆成「佔位符前」「佔位符後」兩段文字——不直接
   * 假設佔位符在字尾，未來語系把它擺在句中也一樣拆得對（塞一個不可能出現在真實
   * 譯文裡的字元當佔位符替身，再用它切字串；呼叫端另外把 tag 本身包成 <b>）。 */
  function splitOnTag(key) {
    const marker = "\u0000";
    const [prefix, suffix = ""] = t(key, { tag: marker }).split(marker);
    return { prefix, suffix };
  }

  /** found／latest 兩態共用：清空結果行、寫入前綴文字＋（可選）加粗的版號。 */
  function renderPrefixAndTag(key, tag) {
    resultEl.textContent = "";
    if (tag) {
      const { prefix, suffix } = splitOnTag(key);
      if (prefix) resultEl.appendChild(document.createTextNode(prefix));
      const b = document.createElement("b");
      b.textContent = tag;
      resultEl.appendChild(b);
      if (suffix) resultEl.appendChild(document.createTextNode(suffix));
    } else {
      resultEl.textContent = t(key);
    }
  }

  /** 加一顆連結到結果行；手機版把可見文字換成 › 符號（CSS 隱藏 .ver-chip-view-label、
   * 補 ::after），可及性名稱一律用 aria-label 保留完整句子，不受畫面文字影響。
   * `extraClass`（可選）：失敗態的「回報問題」連結傳 "feedback-link"，跟 Chat Log
   * 表頭／設定頁共用同一份顏色與底線樣式（見 layout.css）；found 態的「查看更新
   * 內容」不傳，維持既有配色，不是回饋連結。 */
  function appendLink(labelKey, href, extraClass) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    if (extraClass) a.className = extraClass;
    a.setAttribute("aria-label", t(labelKey));
    const label = document.createElement("span");
    label.className = "ver-chip-view-label";
    tEl(label, labelKey);
    a.appendChild(label);
    resultEl.appendChild(a);
    return a;
  }

  function scheduleFadeBackToButton() {
    fadeTimer = setTimeout(() => {
      const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        finishFadeBack();
        return;
      }
      resultEl.style.opacity = "0"; // layout.css 的 transition: opacity .3s 接手動畫
      fadeTimer = setTimeout(finishFadeBack, FADE_MS);
    }, LATEST_HOLD_MS);
  }

  function finishFadeBack() {
    // 焦點若還在這顆 chip 裡（多半是上面 latest 分支剛轉移過去的 resultEl），
    // 鈕重新出現時把焦點還給它，鍵盤使用者才不會停在一顆已經清空的結果行上；
    // 中途使用者自己 tab 去了別處（chip 外）就不搶，尊重當下的焦點所在。
    const hadFocusInChip = chip.contains(document.activeElement);
    fadeTimer = null;
    resultEl.hidden = true;
    resultEl.style.opacity = "";
    resultEl.textContent = "";
    btn.hidden = false;
    if (hadFocusInChip) btn.focus();
  }

  /** 唯一渲染入口：只讀 `getUpdateState()`，不重新 fetch——`checkForUpdate()` 查完
   * 會通知訂閱者（見下方 `onUpdateState`）；`onLocaleChange` 訂閱也呼叫一次，換
   * 語系時已經查到的結果跟著用新語系重新組字串。 */
  function render() {
    clearFadeTimer();
    resultEl.style.opacity = "";
    const state = getUpdateState();
    if (!state) {
      // 尚未查過，或查詢剛開始（checkForUpdate 一開頭就把狀態清成 null、通知一次）：
      // 結果行清空隱藏。鈕的 disabled／aria-busy 交給點擊處理常式自己管——這裡若也
      // 去動鈕的狀態，開機第一次呼叫 render()（此時 state 必為 null）會把鈕誤鎖住。
      // hadFocusBeforeQuery 這裡刻意不讀不清——這一次是查詢「剛開始」的清空通知，
      // 真正的結果（找到新版／已最新／失敗）要等下面第二次 setUpdateState() 才會
      // 觸發下一輪 render()，焦點旗標要留到那時候才消費，不然會被這次清空通知
      // 白白吃掉，害真正該搬焦點的那一刻讀到 false。
      resultEl.hidden = true;
      resultEl.textContent = "";
      return;
    }
    const hadFocus = hadFocusBeforeQuery; // 消費一次即歸零，見上方宣告處與本函式開頭註解
    hadFocusBeforeQuery = false;
    // 查詢已經有結果了：鈕先復原成可點（found／latest 接下來會再把它藏起來；
    // failed 讓它就留著，查詢失敗最需要能立刻再試一次）。
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    resultEl.hidden = false;
    resultEl.textContent = "";
    if (state.kind === "found") {
      // 鈕要被藏起來了——查詢開始那一刻若鍵盤焦點正在鈕上（hadFocus，見上方
      // click handler 那一刻就先記住的理由），藏完馬上把焦點接到新出現的連結，
      // 不讓它掉到 body（found 態有連結可接手，latest 態沒有，見下面分支改接
      // resultEl 本身）。滑鼠使用者（鈕從沒被 focus 過）完全不受影響——hadFocus
      // 恆為 false，這整段等於 no-op。
      btn.hidden = true;
      renderPrefixAndTag("settings.updateFound", state.tag);
      const link = appendLink("settings.updateView", state.href);
      if (hadFocus) link.focus();
    } else if (state.kind === "latest") {
      btn.hidden = true;
      renderPrefixAndTag("settings.updateLatest", "");
      if (hadFocus) resultEl.focus(); // 沒有連結可接手，焦點暫留在結果行本身（tabindex="-1"，見上）
      scheduleFadeBackToButton();
    } else if (state.kind === "failed") {
      btn.hidden = false; // 失敗最該讓人能馬上再按一次，跟 found／latest 不同、不藏鈕
      renderPrefixAndTag("settings.updateFailed", "");
      appendLink("feedback.report", FEEDBACK_URL, "feedback-link");
    }
  }

  btn.addEventListener("click", async () => {
    if (btn.disabled) return; // 查詢中忽略第二次點擊
    hadFocusBeforeQuery = document.activeElement === btn; // 一定要在下一行 disabled=true 之前讀
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    await checkForUpdate();
  });

  onUpdateState(() => render());
  onLocaleChange(() => render());
  render(); // 開機先畫一次——通常是「尚未查過」的空結果行，但若共用狀態在別處已經
            // 查過（例如設定頁先查了），這裡要立刻顯示同一份，不能等下一次事件。

  return chip;
}
