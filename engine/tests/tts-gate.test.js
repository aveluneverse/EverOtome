import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TtsSynthCache } from "../js/tts.js";

// 句尾合成播放鍵的 R2 三態閘門（app.js「句尾播放鍵擴到每一句普通聊天句」gate
// 段，約 app.js 1234-1267 行）：決定要不要把 hooks.synth 注入 ctx.replayHooks，
// 進而決定 chat.js 的合成播放鍵（canSynth，見 chat.js `_renderReplyBubble`）
// 要不要出現。三態：
//   ① 沒配 ttsEndpoint＝整段略過，零 fetch、不注入。
//   ② 配了 ttsEndpoint 但沒配 ttsUsageEndpoint＝視為後端明確開了語音，直接
//      注入，不 probe（探測 GET 打在 POST-only 的 TTS 端點上只會拿到 405，
//      分不出「沒開」與「不支援 GET」，見 app.js 該處說明）。
//   ③ 兩鍵都配＝先 probe ttsUsageEndpoint（GET、唯讀零記帳），2xx 才注入；
//      非 2xx／網路錯／逾時一律靜默不注入。
//
// app.js 本身自執行 main()、無 export，這裡比照 sandbox.test.js 的既有做法
// （見該檔檔頭說明）：組一個逐行對齊 app.js gate 段判斷邏輯的本地 harness，
// 餵真正的 TtsSynthCache（tts.js 的真實 export，不是替身）——驗證「閘門接對
// 積木」的行為，TtsSynthCache 自己的合成／快取正確性已有 tts.test.js 的
// 「TtsSynthCache — 句尾播放鍵的合成快取」整組專門覆蓋，這裡不重複測。
//
// 簡化（相對 app.js 真實碼）：拿掉 probe fetch 外層的 15s AbortController／
// setTimeout／clearTimeout 骨架——那段只影響「卡住的 fetch 最終會不會被主動
// 打斷」，跟這裡要釘的四種閘門結果（要不要注入）沒有可觀察的行為差異；真要
// 驗 15s abort 本身屬另一個關注點，這份「同一個 bug class 已在 chat.js
// loadHistory／tts.js speak 等處測過」的邏輯本檔不重複驗證。onDailyCap 用
// no-op 占位（429 提示渲染是 app.js 的 UI 關注點，不屬於本檔要釘的「注不注入」
// 判準）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_URL = "/api/v4/tts";
const TTS_USAGE_URL = "/api/v4/tts-usage";

// engine/config.example.json 存在磁碟上可能帶 UTF-8 BOM——同 sandbox.test.js
// 既有的 readJsonFile 小工具，剝 BOM 讓契約測試驗的是「鍵存不存在」，不是撞到
// 跟本次改動無關的編碼技術性錯誤。
function readJsonFile(p) {
  let raw = readFileSync(p, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

/**
 * 逐行對齊 app.js gate 段的判斷邏輯（15s abort 骨架簡化掉，見檔頭說明）：回傳
 * 一個新的 ctx，若三態閘門判定該注入，ctx.replayHooks.synth 會是真的接到
 * TtsSynthCache.get 的可用函式；不該注入則 ctx.replayHooks.synth 維持
 * undefined。呼叫端自行把 global.fetch 換成 mock 再呼叫本函式。
 */
async function runGate(config) {
  const ctx = { replayHooks: {} };
  if (config.ttsEndpoint) {
    let ttsAlive = true;
    if (config.ttsUsageEndpoint) {
      ttsAlive = false;
      try {
        const res = await fetch(config.ttsUsageEndpoint, { credentials: "same-origin" });
        ttsAlive = !!res && res.ok;
      } catch (e) {
        // 探測失敗（網路錯／逾時）＝本 session 無合成鍵，靜默（同 app.js 既有慣例）
      }
    }
    if (ttsAlive) {
      const synthCache = new TtsSynthCache({ endpoint: config.ttsEndpoint, onDailyCap: () => {} });
      ctx.replayHooks.synth = (text) => synthCache.get(text);
    }
  }
  return ctx;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); // TtsSynthCache 失敗路徑會 console.warn，測試輸出不洗版
  URL.createObjectURL = vi.fn(() => "blob:mock-url"); // jsdom 未實作，見 tts.test.js 同款既有說明
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

// ─────────────────────────────────────────────────────────────────────────────
// config.example.json 契約：開源殼公開樹配有 ttsEndpoint（TTS 本身是示範功能）、
// 刻意沒有 ttsUsageEndpoint（用量計費端點屬選配，公開範例不預設接後端記帳）——
// 這正是「assertion 2：有 ttsEndpoint 無 ttsUsageEndpoint」的真實情境來源，比照
// sandbox.test.js 的 config.example 契約測試手法鎖死這個裁決。
// ─────────────────────────────────────────────────────────────────────────────
describe("config.example.json 契約 — ttsEndpoint／ttsUsageEndpoint 鍵", () => {
  it("config.example.json（開源殼公開樹）配有 ttsEndpoint、刻意沒有 ttsUsageEndpoint", () => {
    const cfg = readJsonFile(path.join(__dirname, "../config.example.json"));
    expect(typeof cfg.ttsEndpoint).toBe("string");
    expect(cfg.ttsEndpoint).toBeTruthy();
    expect(cfg.ttsUsageEndpoint).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 三態閘門本體。
// ─────────────────────────────────────────────────────────────────────────────
describe("句尾合成播放鍵 — R2 三態閘門（app.js gate 段鏡像）", () => {
  it("① config 無 ttsEndpoint → 零 fetch、hooks.synth 不注入", async () => {
    global.fetch = vi.fn();
    const ctx = await runGate({});
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.replayHooks.synth).toBeUndefined();
  });

  it("② 有 ttsEndpoint、無 ttsUsageEndpoint → 零 fetch（不 probe）、hooks.synth 注入", async () => {
    global.fetch = vi.fn();
    const ctx = await runGate({ ttsEndpoint: TTS_URL });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(typeof ctx.replayHooks.synth).toBe("function");
  });

  it("③a 兩鍵皆配、probe 回非 2xx → 不注入", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const ctx = await runGate({ ttsEndpoint: TTS_URL, ttsUsageEndpoint: TTS_USAGE_URL });
    expect(global.fetch).toHaveBeenCalledWith(TTS_USAGE_URL, expect.objectContaining({ credentials: "same-origin" }));
    expect(ctx.replayHooks.synth).toBeUndefined();
  });

  it("③b 兩鍵皆配、probe reject（網路錯／逾時）→ 不注入、不拋錯", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const ctx = await runGate({ ttsEndpoint: TTS_URL, ttsUsageEndpoint: TTS_USAGE_URL });
    expect(ctx.replayHooks.synth).toBeUndefined();
  });

  it("④ 兩鍵皆配、probe 2xx → 注入，且注入的 hooks.synth 真的接到能運作的 TtsSynthCache", async () => {
    global.fetch = vi.fn(async (url) => {
      if (url === TTS_USAGE_URL) return { ok: true, status: 200 };
      // TtsSynthCache.get 內部觸發的合成請求（打在 ttsEndpoint 上）
      return { ok: true, status: 200, blob: async () => new Blob(["x"], { type: "audio/mpeg" }) };
    });
    const ctx = await runGate({ ttsEndpoint: TTS_URL, ttsUsageEndpoint: TTS_USAGE_URL });
    expect(typeof ctx.replayHooks.synth).toBe("function");
    await expect(ctx.replayHooks.synth("哈囉")).resolves.toBe("blob:mock-url");
    expect(global.fetch).toHaveBeenCalledWith(TTS_USAGE_URL, expect.objectContaining({ credentials: "same-origin" }));
    expect(global.fetch).toHaveBeenCalledWith(TTS_URL, expect.objectContaining({ method: "POST" }));
  });
});
