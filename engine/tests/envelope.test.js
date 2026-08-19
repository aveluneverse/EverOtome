import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  levelsFromPcm,
  computeEnvelope,
  envelopeForUrl,
  _resetEnvelopeForTest,
  ENV_FRAME_MS,
  SILENCE_RATIO,
  BIG_RATIO,
  DECODE_TIMEOUT_MS,
  ENV_CACHE_MAX,
} from "../js/envelope.js";

// 樂譜制（語音播放期間嘴一直開合看起來不自然）：音檔先離線量出逐幀音量 →
// 0/1/2 嘴型譜，播放時查表。本檔測三層：
//   levelsFromPcm＝純數學（PCM → 譜），不碰任何瀏覽器 API，直接餵陣列驗。
//   computeEnvelope＝decode 包裝（AudioContext mock 注入 globalThis），驗超時／
//     無 AudioContext／decode 炸 → 一律 null（呼叫端退有機拍嘴＝永不比現在差）。
//   envelopeForUrl＝fetch＋快取（同 TtsSynthCache 哲學：失敗不釘死、可重試）。

const SR = 8000; // 測試用低採樣率：一幀（50ms）＝400 樣本，陣列小、數字好算

/** 造一段恆定振幅的 PCM：nFrames 幀、每幀 400 樣本、全填 amp（方波——RMS＝amp）。 */
function flat(nFrames, amp) {
  const n = Math.round((ENV_FRAME_MS / 1000) * SR) * nFrames;
  return new Float32Array(n).fill(amp);
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

describe("levelsFromPcm（純數學：PCM → 0/1/2 嘴型譜）", () => {
  it("空輸入／全靜音 → null（沒有譜可查，呼叫端退拍嘴）", () => {
    expect(levelsFromPcm(new Float32Array(0), SR)).toBeNull();
    expect(levelsFromPcm(null, SR)).toBeNull();
    // 全靜音（數位零）＝peak 低於絕對底線：這種「譜」全 0，查表會讓嘴整段死掉，
    // 不如誠實回 null 走拍嘴。
    expect(levelsFromPcm(flat(6, 0), SR)).toBeNull();
  });

  it("恆定大聲 → 全 2；恆定中聲（相對 peak 中段）→ 大聲段 2、中聲段 1", () => {
    const loud = levelsFromPcm(flat(4, 0.8), SR);
    expect(loud).not.toBeNull();
    expect(loud.frameMs).toBe(ENV_FRAME_MS);
    expect(Array.from(loud.levels)).toEqual([2, 2, 2, 2]);

    // 大聲 0.8 當 peak，中段 0.3＝0.375×peak（介於 SILENCE_RATIO 與 BIG_RATIO）→ 1
    const mixed = levelsFromPcm(concat(flat(2, 0.8), flat(2, 0.3)), SR);
    expect(Array.from(mixed.levels)).toEqual([2, 2, 1, 1]);
  });

  it("句中停頓 → 停頓段閉嘴（release 一幀緩衝後歸 0）——樂譜制的核心行為", () => {
    // 響 3 幀、停 4 幀、再響 3 幀：停頓首幀＝收嘴緩衝（≤1），其後全 0，回響即開
    const pcm = concat(flat(3, 0.7), flat(4, 0.001), flat(3, 0.7));
    const env = levelsFromPcm(pcm, SR);
    const L = Array.from(env.levels);
    expect(L.slice(0, 3)).toEqual([2, 2, 2]);
    expect(L[3]).toBeLessThanOrEqual(1); // release 緩衝幀：先縮口、不猛閉
    expect(L.slice(4, 7)).toEqual([0, 0, 0]); // 真正的停頓＝閉嘴（樂譜制的存在理由）
    expect(L.slice(7)).toEqual([2, 2, 2]);    // 回聲即開（attack 零延遲）
  });

  it("單幀低谷不閉死（嘴縮到 1 級緩衝，不出 0）——防逗號瞬谷高頻開閉閃爍", () => {
    const pcm = concat(flat(2, 0.7), flat(1, 0.001), flat(2, 0.7));
    const L = Array.from(levelsFromPcm(pcm, SR).levels);
    expect(L).toEqual([2, 2, 1, 2, 2]);
  });

  it("尾端不足一幀的樣本捨去；levels 是 Uint8Array（省記憶體）", () => {
    const frameLen = Math.round((ENV_FRAME_MS / 1000) * SR);
    const pcm = concat(flat(2, 0.6), new Float32Array(frameLen - 1).fill(0.6));
    const env = levelsFromPcm(pcm, SR);
    expect(env.levels.length).toBe(2);
    expect(env.levels).toBeInstanceOf(Uint8Array);
  });
});

// ── computeEnvelope：decode 包裝 ─────────────────────────────────────────────

/** 假 AudioContext：decodeAudioData 回 promise 形（現代瀏覽器路徑），
 * 內容＝恆定 0.7、6 幀 @ 8kHz。 */
class FakeAudioContext {
  decodeAudioData(buf) {
    const data = flat(6, 0.7);
    return Promise.resolve({
      sampleRate: SR,
      numberOfChannels: 1,
      getChannelData: () => data,
    });
  }
}

function fakeBlob() {
  // jsdom 的 Blob 有 arrayBuffer()；內容不重要（decode 是假的）
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" });
}

describe("computeEnvelope（decode 包裝：任何失敗一律 null）", () => {
  const hadAC = "AudioContext" in globalThis;
  const realAC = globalThis.AudioContext;
  beforeEach(() => _resetEnvelopeForTest()); // AudioContext 單例跨測試隔離
  afterEach(() => {
    if (hadAC) globalThis.AudioContext = realAC;
    else delete globalThis.AudioContext;
  });

  it("正常 decode → 譜（走 promise 形 decodeAudioData）", async () => {
    globalThis.AudioContext = FakeAudioContext;
    const env = await computeEnvelope(fakeBlob());
    expect(env).not.toBeNull();
    expect(Array.from(env.levels)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("無 AudioContext（jsdom 原生／老瀏覽器）→ null 不炸", async () => {
    delete globalThis.AudioContext;
    expect(await computeEnvelope(fakeBlob())).toBeNull();
  });

  it("decode 拒絕 → null（解碼層再出事＝退拍嘴，永不比現在差）", async () => {
    globalThis.AudioContext = class {
      decodeAudioData() { return Promise.reject(new Error("boom")); }
    };
    expect(await computeEnvelope(fakeBlob())).toBeNull();
  });

  it("decode 永不 settle → 超時 null（fake timers 推過 DECODE_TIMEOUT_MS）", async () => {
    vi.useFakeTimers();
    try {
      globalThis.AudioContext = class {
        decodeAudioData() { return new Promise(() => {}); }
      };
      const p = computeEnvelope(fakeBlob());
      // blob.arrayBuffer() 是真微任務——先讓它走完、掛進 decode，再推表
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 100);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("callback 形 decodeAudioData（老 Safari 簽名）也吃得動", async () => {
    globalThis.AudioContext = class {
      decodeAudioData(buf, ok) {
        const data = flat(4, 0.7);
        ok({ sampleRate: SR, numberOfChannels: 1, getChannelData: () => data });
        // 老簽名無回傳值
      }
    };
    const env = await computeEnvelope(fakeBlob());
    expect(env).not.toBeNull();
    expect(env.levels.length).toBe(4);
  });
});

// ── envelopeForUrl：fetch＋快取 ──────────────────────────────────────────────

describe("envelopeForUrl（fetch＋LRU 快取；失敗可重試不釘死）", () => {
  const realFetch = globalThis.fetch;
  const hadAC = "AudioContext" in globalThis;
  const realAC = globalThis.AudioContext;

  beforeEach(() => {
    _resetEnvelopeForTest();
    globalThis.AudioContext = FakeAudioContext;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (hadAC) globalThis.AudioContext = realAC;
    else delete globalThis.AudioContext;
  });

  function okFetch() {
    return vi.fn(async () => ({ ok: true, blob: async () => fakeBlob() }));
  }

  it("成功 → 譜；同 url 第二次命中快取（fetch 只打一次）", async () => {
    const f = okFetch();
    globalThis.fetch = f;
    const a = await envelopeForUrl("/audio/1.mp3");
    const b = await envelopeForUrl("/audio/1.mp3");
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fetch 炸／非 2xx → null 且不快取失敗（下次點播可重試）", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("net"); });
    expect(await envelopeForUrl("/audio/x.mp3")).toBeNull();
    const f2 = okFetch();
    globalThis.fetch = f2;
    expect(await envelopeForUrl("/audio/x.mp3")).not.toBeNull();
    expect(f2).toHaveBeenCalledTimes(1);

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    expect(await envelopeForUrl("/audio/404.mp3")).toBeNull();
  });

  it("無效 url → null；快取超過上限逐出最舊", async () => {
    expect(await envelopeForUrl("")).toBeNull();
    expect(await envelopeForUrl(null)).toBeNull();

    const f = okFetch();
    globalThis.fetch = f;
    for (let i = 0; i < ENV_CACHE_MAX + 1; i++) {
      await envelopeForUrl(`/audio/${i}.mp3`);
    }
    expect(f).toHaveBeenCalledTimes(ENV_CACHE_MAX + 1);
    // 最舊的 /audio/0.mp3 已被逐出 → 再要一次會重新 fetch
    await envelopeForUrl("/audio/0.mp3");
    expect(f).toHaveBeenCalledTimes(ENV_CACHE_MAX + 2);
  });
});
