/**
 * photo-upload.js —— 照片上傳狀態機（sending 防重入＋大小防呆＋誠實失敗訊息）。
 *
 * 協定依據（後端契約，讀不改，僅供對照）：
 *   ① `POST /api/photo`：multipart，欄位名固定 `photo`（檔案）；`target` 欄位
 *      （後端用來分流不同收件對象的 staging 子目錄）可以省略，伺服器端
 *      會用它自己的預設收件對象——1:1 私聊場景唯一的收件對象正好就是那個預設值，
 *      不需要額外指定。成功回 200 `{"photo_id": "..."}`；404＝功能未開；
 *      400＝格式或大小不符（伺服器端上限可由部署方 env 設定，預設 8MB）。
 *   ② 私聊沒有「照片回顯」下行 frame——使用者自己傳的照片是
 *      **寄件人本地樂觀渲染**（blob URL），從不等伺服器的下行確認。這裡只負責
 *      「挑到檔案 → 上傳 → 拿 photo_id 或誠實的失敗原因」，本地樂觀渲染與 WS
 *      `{text, photos}` frame 組裝都留給呼叫端（app.js）——本檔不碰 DOM、不碰
 *      ChatClient，維持單一職責、好單獨測試（同 tts.js／chat.js 一貫風格：失敗
 *      一律轉成正常回傳值，不 throw，呼叫端不需要 try/catch）。
 *
 * 10MB 前端防呆 vs 伺服器 8MB 預設上限：兩個數字刻意不綁死相等——前端這道只是
 *「明顯過大就別浪費一趟上傳」的快速防呆，伺服器端的實際上限本來就可能因部署環境
 * 的 env 設定而不同，engine/ 是開源給任何人接任何後端的，不應該假設一個寫死的
 * 後端數字。介於兩者之間（8-10MB）的檔案會通過前端這關、被伺服器誠實地 400 拒絕，
 * 走的正是下面 upload() 的一般失敗分支——這是預期內的正常路徑，不是 bug。
 */
import { t } from "./i18n.js";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export class PhotoUploader {
  constructor({ endpoint = "/api/photo" } = {}) {
    this.endpoint = endpoint;
    this.sending = false;
    this.batching = false; // uploadMany 整批期間 true（蓋住張與張之間 sending 的短暫 false 縫隙）
  }

  /** 呼叫端防重入該看這顆：單張上傳中或多張批次中都算忙。 */
  get busy() {
    return this.sending || this.batching;
  }

  /** 檔案過大 → 回中文錯誤訊息（不打後端，快速失敗）；沒問題回 null。 */
  static checkSize(file) {
    if (file && typeof file.size === "number" && file.size > MAX_PHOTO_BYTES) {
      const mb = Math.floor(MAX_PHOTO_BYTES / 1024 / 1024);
      return t("photo.tooLarge", { mb });
    }
    return null;
  }

  /**
   * 上傳單張照片。回傳 `{ok:true, photoId}` 或 `{ok:false, message}`——絕不 throw。
   * `this.sending` 在整個上傳期間為 true（呼叫端應該同步用它停用附加按鈕，這裡
   * 額外守一道防止重入，不完全依賴呼叫端自律）。
   */
  async upload(file) {
    if (this.sending) return { ok: false, message: t("photo.oneStillUploading") };
    const sizeErr = PhotoUploader.checkSize(file);
    if (sizeErr) return { ok: false, message: sizeErr };

    this.sending = true;
    try {
      const fd = new FormData();
      fd.append("photo", file, (file && file.name) || "photo.jpg");
      let res;
      try {
        res = await fetch(this.endpoint, { method: "POST", body: fd });
      } catch (e) {
        return { ok: false, message: t("photo.networkFail") };
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 404) return { ok: false, message: t("photo.featureOff") };
        return { ok: false, message: (body && body.detail) || t("photo.uploadFail") };
      }
      const photoId = body && body.photo_id;
      if (!photoId) return { ok: false, message: t("photo.uploadFail") };
      return { ok: true, photoId };
    } finally {
      this.sending = false;
    }
  }

  /**
   * 序列上傳多張照片。回 `{ok:true, photoIds}`（順序＝files 序
   * ＝後端 `resolve_photos`-類端點的「順序＝上傳序」契約）或 `{ok:false, message,
   * uploadedCount}`——絕不 throw，與 upload() 同款契約。
   *
   * 設計錨點：
   * - **先全量檢大小再開傳**：任何一張超過前端防呆上限，整批一張都不傳（零浪費、
   *   零殘檔），訊息點名第幾張——絕不默默丟掉超大的那張、只傳其餘（誤以為 N 張
   *   全送了實際少一張＝比失敗更糟的無聲失真）。
   * - **序列不並發**：一張傳完才傳下一張（upload() 的 sending 防重入本來就擋並發；
   *   序列＝photoIds 順序天然穩定，也不給後端瞬間 N 條連線）。
   * - **中途失敗即中止**：第 i 張失敗，其後不再傳，且**不送出半批**——已上傳成功
   *   的 staging 檔留給伺服器既有的 startup sweep 清（uploadedCount 供呼叫端誠實
   *   告知）。多張時失敗訊息帶「第 i 張：」前綴；單張批（files.length===1）訊息
   *   與 upload() 逐字相同（迴紋針既有體驗零變化）。
   * - `onProgress(i, n)`：開始傳第 i 張（1-based）時回呼，供呼叫端顯示「傳送中
   *   （i/n）」。回呼丟例外不影響上傳（呼叫端顯示層的事故不該弄丟使用者的照片）。
   */
  async uploadMany(files, { onProgress } = {}) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return { ok: false, message: t("photo.none"), uploadedCount: 0 };
    if (this.busy) return { ok: false, message: t("photo.stillUploading"), uploadedCount: 0 };

    const many = list.length > 1;
    for (let i = 0; i < list.length; i++) {
      const sizeErr = PhotoUploader.checkSize(list[i]);
      if (sizeErr) {
        return {
          ok: false,
          message: many ? t("photo.nth", { i: i + 1, msg: sizeErr }) : sizeErr,
          uploadedCount: 0,
        };
      }
    }

    this.batching = true;
    try {
      const photoIds = [];
      for (let i = 0; i < list.length; i++) {
        if (typeof onProgress === "function") {
          try {
            onProgress(i + 1, list.length);
          } catch (e) {
            /* 顯示層回呼的例外不絆上傳 */
          }
        }
        const result = await this.upload(list[i]);
        if (!result.ok) {
          return {
            ok: false,
            message: many ? t("photo.nth", { i: i + 1, msg: result.message }) : result.message,
            uploadedCount: i,
          };
        }
        photoIds.push(result.photoId);
      }
      return { ok: true, photoIds };
    } finally {
      this.batching = false;
    }
  }
}
