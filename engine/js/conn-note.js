// 對話框待機提示要選哪一句：由連線狀態序列決定，不是單看當下狀態。
//
// 沒有後端時 ChatClient 永遠在 connecting → reconnecting → connecting… 打轉，
// 永遠不會走到 closed／error——所以「尚未連線」那句（conn.idleOffline）以前
// 一句都顯示不到，框裡只會一直寫「（連線中）」。這裡記住「有沒有真的連上過」
// 與「失敗了幾次」：從沒連上過、又已經失敗至少一次＝該講「還沒接上後端」；
// 真的連上過又掉線＝繼續講「連線中」（背景重連沒變）。純函式物件，方便測。
export class ConnNoteTracker {
  constructor() {
    this.everOpened = false;
    this.failedAttempts = 0;
  }

  /** 餵 ChatClient.onStatusChange 的每個 status；回傳待機提示的 i18n 鍵，"" ＝ 不顯示。 */
  keyFor(status) {
    if (status === "open") {
      this.everOpened = true;
      this.failedAttempts = 0;
      return "";
    }
    if (status === "reconnecting") this.failedAttempts += 1;
    if (status === "connecting" || status === "reconnecting") {
      return !this.everOpened && this.failedAttempts >= 1 ? "conn.idleOffline" : "conn.idleConnecting";
    }
    return "conn.idleOffline"; // closed / error
  }
}
