import { describe, it, expect, vi, afterEach } from "vitest";
import { PhotoUploader, MAX_PHOTO_BYTES } from "../js/photo-upload.js";
import { setLocale } from "../js/i18n.js";

afterEach(() => {
  delete global.fetch;
});

// jsdom 有原生 FormData，但為了斷言「欄位名確實叫 photo」不必依賴 jsdom 內部實作
// 細節，這裡用 jsdom 原生 FormData 本身（vitest 的 jsdom 環境內建），只在斷言時
// 用 FormData.prototype 上的方法反查即可。

function fakeFile(size, name = "photo.jpg") {
  const file = new File([new Uint8Array(Math.min(size, 1024))], name, { type: "image/jpeg" });
  // File 的 size 由內容位元組數決定；用 defineProperty 蓋掉，避免測試真的要塞
  // 一個 10MB+ 的 buffer 進記憶體才能測到「超過上限」這個分支。
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("PhotoUploader.checkSize —— 前端快速防呆", () => {
  it("檔案 ≤ 上限 → 回 null（沒問題）", () => {
    expect(PhotoUploader.checkSize(fakeFile(MAX_PHOTO_BYTES))).toBeNull();
    expect(PhotoUploader.checkSize(fakeFile(1024))).toBeNull();
  });

  it("檔案 > 上限（10MB）→ 回誠實的中文錯誤訊息，不打後端", () => {
    const msg = PhotoUploader.checkSize(fakeFile(MAX_PHOTO_BYTES + 1));
    expect(msg).toContain("10MB");
  });

  it("file 為 null/undefined → 不炸，回 null（沒有東西可檢查）", () => {
    expect(PhotoUploader.checkSize(null)).toBeNull();
    expect(PhotoUploader.checkSize(undefined)).toBeNull();
  });

  it("locale=en 時超大檔訊息走英文字典（i18n）", () => {
    setLocale("en", { persist: false });
    const msg = PhotoUploader.checkSize(fakeFile(MAX_PHOTO_BYTES + 1));
    expect(msg).toContain("over 10MB");
  });
});

describe("PhotoUploader.upload —— 狀態機（sending 防重入）＋成功路徑", () => {
  it("上傳期間 this.sending === true，成功後恢復 false", async () => {
    let sendingDuringFetch = null;
    global.fetch = vi.fn(async () => {
      sendingDuringFetch = uploader.sending;
      return jsonResponse(200, { photo_id: "abc123" });
    });
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    expect(uploader.sending).toBe(false);
    const result = await uploader.upload(fakeFile(1024));
    expect(sendingDuringFetch).toBe(true);
    expect(uploader.sending).toBe(false);
    expect(result).toEqual({ ok: true, photoId: "abc123" });
  });

  it("成功時 POST 到指定 endpoint、multipart 欄位名固定叫 photo（後端契約）", async () => {
    let capturedBody;
    let capturedUrl;
    let capturedMethod;
    global.fetch = vi.fn(async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      capturedBody = opts.body;
      return jsonResponse(200, { photo_id: "xyz" });
    });
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    await uploader.upload(fakeFile(2048, "cat.png"));
    expect(capturedUrl).toBe("/api/photo");
    expect(capturedMethod).toBe("POST");
    expect(capturedBody).toBeInstanceOf(FormData);
    expect(capturedBody.has("photo")).toBe(true);
    expect(capturedBody.get("photo").name).toBe("cat.png");
  });

  it("重入防線：sending 中再呼叫 upload() → 立即回失敗，不會發第二個 fetch", async () => {
    let resolveFetch;
    global.fetch = vi.fn(
      () =>
        new Promise((r) => {
          resolveFetch = r;
        }),
    );
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const first = uploader.upload(fakeFile(1024));
    expect(uploader.sending).toBe(true);
    const second = await uploader.upload(fakeFile(1024));
    expect(second.ok).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(200, { photo_id: "ok" }));
    await first;
  });

  it("超過大小上限 → upload() 直接回失敗，完全不呼叫 fetch", async () => {
    global.fetch = vi.fn();
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.upload(fakeFile(MAX_PHOTO_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("10MB");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(uploader.sending).toBe(false);
  });
});

describe("PhotoUploader.upload —— 失敗路徑（誠實訊息，絕不 throw）", () => {
  it("404（flag off）→ 誠實顯示「功能還沒開」", async () => {
    global.fetch = vi.fn(async () => jsonResponse(404, {}));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.upload(fakeFile(1024));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("還沒開");
    expect(uploader.sending).toBe(false);
  });

  it("400（格式或大小不符，伺服器端拒絕）→ 帶出後端 detail 原文", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { detail: "照片格式或大小不符" }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.upload(fakeFile(1024));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("照片格式或大小不符");
  });

  it("成功狀態碼但 body 沒有 photo_id（壞掉的回應）→ 視為失敗", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, {}));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.upload(fakeFile(1024));
    expect(result.ok).toBe(false);
  });

  it("json() 本身丟例外（壞掉的 body）→ 一樣走失敗降級，不 throw", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    await expect(uploader.upload(fakeFile(1024))).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it("fetch 本身拋出（斷網）→ 誠實回落，不 throw，sending 恢復 false", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    await expect(uploader.upload(fakeFile(1024))).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(uploader.sending).toBe(false);
  });

  it("失敗後可以立刻重試（sending 沒有卡死）", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { detail: "先炸一次" }))
      .mockResolvedValueOnce(jsonResponse(200, { photo_id: "retry-ok" }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const first = await uploader.upload(fakeFile(1024));
    expect(first.ok).toBe(false);
    const second = await uploader.upload(fakeFile(1024));
    expect(second).toEqual({ ok: true, photoId: "retry-ok" });
  });
});

describe("PhotoUploader.uploadMany —— 多張序列上傳", () => {
  it("全部成功 → photoIds 順序＝files 序（resolve_photos-類端點「順序＝上傳序」契約）", async () => {
    let n = 0;
    global.fetch = vi.fn(async () => jsonResponse(200, { photo_id: "id-" + ++n }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.uploadMany([fakeFile(100, "a.png"), fakeFile(200, "b.png"), fakeFile(300, "c.png")]);
    expect(result).toEqual({ ok: true, photoIds: ["id-1", "id-2", "id-3"] });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(uploader.busy).toBe(false);
  });

  it("序列不並發：一張傳完才傳下一張（fetch 進行中絕不出現第二個 fetch）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0)); // 讓「並發就會重疊」有機會被抓到
      inFlight -= 1;
      return jsonResponse(200, { photo_id: "x" });
    });
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.uploadMany([fakeFile(1), fakeFile(2), fakeFile(3)]);
    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("onProgress 依序回呼 (1,n)(2,n)(3,n)；回呼丟例外不影響上傳", async () => {
    global.fetch = vi.fn(async () => jsonResponse(200, { photo_id: "p" }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const calls = [];
    const result = await uploader.uploadMany([fakeFile(1), fakeFile(2), fakeFile(3)], {
      onProgress: (i, n) => {
        calls.push([i, n]);
        throw new Error("顯示層炸了"); // 不該絆倒上傳
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it("任一張超過大小上限 → 整批一張都不傳（零 fetch）、訊息點名第幾張", async () => {
    global.fetch = vi.fn();
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.uploadMany([fakeFile(1024), fakeFile(MAX_PHOTO_BYTES + 1), fakeFile(1024)]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("第 2 張");
    expect(result.message).toContain("10MB");
    expect(result.uploadedCount).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(uploader.busy).toBe(false);
  });

  it("中途第 2 張失敗 → 中止（第 3 張不傳）、訊息帶「第 2 張：」、uploadedCount=1", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { photo_id: "ok-1" }))
      .mockResolvedValueOnce(jsonResponse(500, { detail: "第二張炸了" }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.uploadMany([fakeFile(1), fakeFile(2), fakeFile(3)]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("第 2 張：第二張炸了");
    expect(result.uploadedCount).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2); // 第 3 張沒發
    expect(uploader.busy).toBe(false);
  });

  it("單張批（[file]）失敗訊息不帶「第 N 張」前綴＝與 upload() 逐字相同（迴紋針零變化）", async () => {
    global.fetch = vi.fn(async () => jsonResponse(400, { detail: "照片格式或大小不符" }));
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const result = await uploader.uploadMany([fakeFile(1024)]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("照片格式或大小不符");
  });

  it("batching 期間 busy===true（張與張之間 sending 的縫隙也蓋住）；重入直接回失敗零 fetch", async () => {
    let busyDuringFetch = null;
    global.fetch = vi.fn(async () => {
      busyDuringFetch = uploader.busy;
      return jsonResponse(200, { photo_id: "z" });
    });
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    const p = uploader.uploadMany([fakeFile(1), fakeFile(2)]);
    const reentry = await uploader.uploadMany([fakeFile(3)]);
    expect(reentry.ok).toBe(false);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(busyDuringFetch).toBe(true);
    expect(uploader.busy).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2); // 重入那次一發都沒發
  });

  it("空清單／全 falsy → 誠實失敗，不 throw、零 fetch", async () => {
    global.fetch = vi.fn();
    const uploader = new PhotoUploader({ endpoint: "/api/photo" });
    await expect(uploader.uploadMany([])).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(uploader.uploadMany([null, undefined])).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
