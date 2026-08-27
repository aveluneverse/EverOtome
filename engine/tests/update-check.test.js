// update-check.js —— 共用「檢查更新」查詢／比對／可訂閱狀態，設定頁與首頁版本列
// （version-chip.js）共用同一份，不各自兜一份判斷邏輯。三態結果＋never throws＋
// 小型 pub/sub（同 i18n.js 的 onLocaleChange 慣例：訂閱回傳退訂函式）。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  UPDATE_FEED_URL,
  RELEASES_URL,
  checkForUpdate,
  getUpdateState,
  setUpdateState,
  onUpdateState,
} from "../js/update-check.js";
import { VERSION } from "../js/version.js";

// 模組層級共用狀態跨同檔案的測試存活（vitest 同一測試檔共用同一份模組實例）——
// 每個測試後清回 null，不讓上一個測試查到的結果漏進下一個測試的初始狀態。
afterEach(() => {
  setUpdateState(null);
});

function okResponse(items) {
  return { ok: true, status: 200, json: async () => items };
}

describe("checkForUpdate()：查一次、比對、回傳三態之一", () => {
  it("tag 去掉 v 前綴後等於本地 VERSION → latest", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v" + VERSION,
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v" + VERSION,
    }]));
    const result = await checkForUpdate();
    expect(result).toEqual({ kind: "latest" });
    expect(getUpdateState()).toEqual({ kind: "latest" }); // 回傳值與共用狀態一致
  });

  it("tag 與本地版本不同、html_url 是 github.com → found，href 用回應原值", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const result = await checkForUpdate();
    expect(result).toEqual({
      kind: "found",
      tag: "v9.9.9-beta",
      href: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    });
  });

  it("tag 與本地版本不同、html_url 非 github.com 網域 → found，href 退回官方 releases 頁（白名單）", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v9.9.9-beta", html_url: "https://evil.example/x" }]));
    const result = await checkForUpdate();
    expect(result).toEqual({ kind: "found", tag: "v9.9.9-beta", href: RELEASES_URL });
  });

  it("回應非 ok（4xx/5xx）→ failed", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const result = await checkForUpdate();
    expect(result).toEqual({ kind: "failed" });
  });

  it("fetch 丟例外（斷網／逾時）→ failed，不外洩例外給呼叫端", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("network down"); });
    await expect(checkForUpdate()).resolves.toEqual({ kind: "failed" });
  });

  it("回應陣列第一筆沒有 tag_name → failed", async () => {
    global.fetch = vi.fn(async () => okResponse([{ html_url: "https://github.com/x" }]));
    const result = await checkForUpdate();
    expect(result).toEqual({ kind: "failed" });
  });

  it("回應不是陣列 → failed", async () => {
    global.fetch = vi.fn(async () => okResponse({ tag_name: "v9.9.9-beta" }));
    const result = await checkForUpdate();
    expect(result).toEqual({ kind: "failed" });
  });

  it("查詢打對 URL 與 Accept header", async () => {
    const fetchSpy = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    global.fetch = fetchSpy;
    await checkForUpdate();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(UPDATE_FEED_URL, { headers: { Accept: "application/vnd.github+json" } });
  });
});

describe("共用可訂閱狀態：getUpdateState／setUpdateState／onUpdateState", () => {
  it("尚未查過＝null", () => {
    expect(getUpdateState()).toBe(null);
  });

  it("checkForUpdate() 開始時先把狀態清成 null、查完寫入結果——訂閱者依序收到 null 再收到結果", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const seen = [];
    const unsub = onUpdateState((s) => seen.push(s));
    await checkForUpdate();
    unsub();
    expect(seen).toEqual([null, { kind: "latest" }]);
  });

  it("onUpdateState 回傳的退訂函式生效後，該訂閱者不再收到之後的通知", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const seen = [];
    const unsub = onUpdateState((s) => seen.push(s));
    unsub();
    await checkForUpdate();
    expect(seen).toEqual([]);
  });

  it("多個訂閱者都會收到同一次查詢的通知（設定頁與首頁版本列共用同一份狀態的基礎）", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const a = [];
    const b = [];
    const unsubA = onUpdateState((s) => a.push(s));
    const unsubB = onUpdateState((s) => b.push(s));
    await checkForUpdate();
    unsubA();
    unsubB();
    expect(a).toEqual([null, { kind: "latest" }]);
    expect(b).toEqual([null, { kind: "latest" }]);
  });

  it("一個訂閱者的回呼丟例外，不擋其他訂閱者、也不擋查詢本身完成", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const seen = [];
    const unsubBad = onUpdateState(() => { throw new Error("boom"); });
    const unsubGood = onUpdateState((s) => seen.push(s));
    await expect(checkForUpdate()).resolves.toEqual({ kind: "latest" });
    unsubBad();
    unsubGood();
    expect(seen).toEqual([null, { kind: "latest" }]);
  });
});
