// engine/js/feedback.js —— 回饋管道單一真相（Mira 2026-08-27 規則：每一條使用者
// 會看到的錯誤路徑都要附上這個回饋盒）。FEEDBACK_URL 本身＋console 小工具
// （logError／logWarn）＋回饋連結建構式（buildFeedbackLink）：目前唯一呼叫端
// 是設定頁查詢失敗；其餘連結各自直接讀 FEEDBACK_URL 組字面值，只共用
// .feedback-link 這顆 CSS class。
import { tEl, tAttr } from "./i18n.js";

export const FEEDBACK_URL = "https://marshmallow-qa.com/a4u0myommjpyzup";

/** console 小工具固定接上的附言——恆英文，不跟介面語系走（Mira 2026-08-27
 * 早上追加規則：console 是給接後端的開發者看的，開發者看得懂英文；跟著使用者
 * 介面語系走反而會在 zh-Hant 下讓英文除錯訊息尾巴接一句中文，混淆兩種讀者）。 */
export const CONSOLE_FEEDBACK_SUFFIX = " Stuck? Tell us: " + FEEDBACK_URL;

/** console.error 的替身：訊息尾巴自動接上恆英文附言，其餘參數原樣轉呼叫
 * （error 物件、額外除錯資料等）。呼叫端把既有的 console.error 呼叫換成
 * logError 呼叫就好，不必自己記得串接回饋附言。 */
export function logError(msg, ...rest) {
  console.error(msg + CONSOLE_FEEDBACK_SUFFIX, ...rest);
}

/** 同 logError，對應 console.warn。 */
export function logWarn(msg, ...rest) {
  console.warn(msg + CONSOLE_FEEDBACK_SUFFIX, ...rest);
}

/** 建一顆標準化的「回饋回報」連結：href／target／rel／class（樣式見 layout.css
 * 的 .feedback-link）一次到位，可見文字與可及性名稱都跟目前介面語系走
 * （tEl／tAttr 各自掛 data-i18n／data-i18n-attr，換語系時 i18n.js 的
 * applyDom() 會一併重譯，不必額外訂閱 onLocaleChange）。Chat Log 表頭與設定頁
 * 查詢失敗共用這一份；版本列查詢失敗另有自己的 appendLink（連結內多包一層
 * 手機版文字／›符號切換用的 span），不套用本函式，只借同一個 class 讓顏色與
 * 底線風格一致。 */
export function buildFeedbackLink() {
  const a = document.createElement("a");
  a.href = FEEDBACK_URL;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "feedback-link";
  tEl(a, "feedback.report");
  tAttr(a, "aria-label", "feedback.report");
  return a;
}
