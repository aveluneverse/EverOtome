// engine/js/feedback.js —— 回饋管道單一真相（Mira 2026-08-27 規則：每一條使用者
// 會看到的錯誤路徑都要附上這個回饋盒）。FEEDBACK_URL 本身（Commit 2 起）＋
// console 小工具（本 commit）：把回饋附言黏到既有 console.error／console.warn
// 訊息尾巴，呼叫端不必自己記得串接、也不會漏掉某一條。
import { t } from "./i18n.js";

export const FEEDBACK_URL = "https://marshmallow-qa.com/a4u0myommjpyzup";

/** 回饋附言——跟目前介面語系走（不是寫死英文）：這段話是給「卡住的使用者」看的，
 * 讓他能看懂的語言比跟開發者訊息一致的語言更重要。`feedback.stuck` 字典值本身
 * 已含收尾的冒號＋空格（en）或全形冒號（zh-Hant），這裡只補最前面那個分隔用的
 * 半形空格，讓附言接在既有英文訊息句尾時不會黏在一起。 */
export function feedbackSuffix() {
  return " " + t("feedback.stuck") + FEEDBACK_URL;
}

/** console.error 的替身：訊息尾巴自動接上回饋附言，其餘參數原樣轉呼叫
 * （error 物件、額外除錯資料等）。呼叫端把既有的
 * `console.error("...:", e)` 換成 `logError("...:", e)` 就好，不必自己記得
 * 串接回饋附言。 */
export function logError(msg, ...rest) {
  console.error(msg + feedbackSuffix(), ...rest);
}

/** 同 logError，對應 console.warn。 */
export function logWarn(msg, ...rest) {
  console.warn(msg + feedbackSuffix(), ...rest);
}
