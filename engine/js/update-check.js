// engine/js/update-check.js —— 共用「檢查更新」邏輯：GitHub 公開 releases API 查詢／
// 比對／小型可訂閱狀態。設定頁（settings.js）與首頁版本列（version-chip.js）共用
// 同一份查詢與結果，不各自兜一份判斷邏輯——這支模組原本整段活在 settings.js 的
// _checkUpdate／_updateState，搬出來給兩個呼叫端共用，行為一字不動。
//
// 資料源：GitHub 公開 releases API（列表第一顆＝最新，含 pre-release——
// `releases/latest` 端點刻意不回 pre-release，beta 期不能用）。只在使用者主動觸發
// 時 fetch；不上傳任何資料、無自動背景檢查（README 隱私段同句承諾）。
import { VERSION } from "./version.js";

export const UPDATE_FEED_URL = "https://api.github.com/repos/aveluneverse/EverOtome/releases?per_page=1";
export const RELEASES_URL = "https://github.com/aveluneverse/EverOtome/releases";

// 最後一次查到的結果——沒查過／正在查＝null。存狀態而非直接寫死 DOM 字串，換語系
// 或多個畫面（設定頁／首頁版本列）才能共用同一份結果，不必為了跟上新語系或另一個
// 畫面剛查過就再打一次 GitHub API。
let state = null;
const listeners = new Set();

export function getUpdateState() {
  return state;
}

export function setUpdateState(next) {
  state = next;
  for (const fn of listeners) {
    try { fn(state); } catch (e) { /* 訂閱者自己的錯不擋其他訂閱者、不擋查詢流程 */ }
  }
}

/** 訂閱狀態變化；回傳退訂函式（同 i18n.js 的 onLocaleChange 慣例）。 */
export function onUpdateState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 查一次 GitHub releases 列表第一顆，tag 去掉 v 前綴與本地 VERSION 比對——不同＝
 * 有新版（href 只信 github.com 網域，否則退回官方 releases 頁）、相同＝已最新、
 * 任何失敗（斷網／非 2xx／無 tag）＝失敗態。全程不丟例外，呼叫端不必包 try/catch。
 * 查詢一開始先把共用狀態清成 null 並通知一次（讓所有訂閱畫面同步進入「查詢中」的
 * 清空態），查完再寫入結果並再通知一次——這是設定頁與首頁版本列即使分屬不同
 * 元件，也能顯示同一份結果的唯一機制。 */
export async function checkForUpdate() {
  setUpdateState(null);
  try {
    const res = await fetch(UPDATE_FEED_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const rel = Array.isArray(data) ? data[0] : null;
    const tag = rel && typeof rel.tag_name === "string" ? rel.tag_name : "";
    const latest = tag.replace(/^v/, "");
    if (!latest) throw new Error("no tag");
    if (latest === VERSION) {
      setUpdateState({ kind: "latest" });
    } else {
      const href = (rel.html_url && /^https:\/\/github\.com\//.test(rel.html_url))
        ? rel.html_url
        : RELEASES_URL;
      setUpdateState({ kind: "found", tag, href });
    }
  } catch (e) {
    setUpdateState({ kind: "failed" });
  }
  return getUpdateState();
}
