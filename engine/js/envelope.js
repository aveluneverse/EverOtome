/** envelope.js——嘴型同步「樂譜制」的譜面工廠。
 *
 * 由來：語音播放期間嘴一直持續開合，看起來不自然。播放事件直驅制（見
 * audio-mouth.js 檔頭替換史②）只知道「音檔在播」，不知道「這一瞬間有沒有
 * 聲音」——句中的換氣、逗號停頓，嘴照拍。本模組把音檔**離線**掃一遍，產出
 * 逐幀（50ms）的 0/1/2 嘴型譜：0＝閉、1＝微張、2＝張開；播放時 MouthDriver 用
 * currentTime 查表——有聲開嘴、停頓閉嘴、大聲開大口。
 *
 * 與已退役的音量驅動分析鏈的本質區別（勿回頭重蹈）：舊制
 * createMediaElementSource **寄生在播放管線上**——聲音必須流過分析器才出得來，
 * 分析器一死整條卡住、還抓不到兇手。本模組只用 AudioContext 做一次性**離線
 * 解碼**（decodeAudioData），播放元件零觸碰、聲音路徑照舊；解碼失敗／超時／
 * 環境沒有 AudioContext → 一律回 null，呼叫端退回有機拍嘴（audio-mouth 的
 * flap 模式＝內建安全網）——**任何一環死掉都不會比事件直驅制差**。
 *
 * 三層 API：
 *   levelsFromPcm(pcm, sampleRate)  純數學：PCM → 譜（可測、零瀏覽器依賴）
 *   computeEnvelope(blob)           blob → decode → 譜｜null（聊天 TTS：blob 在手直接算）
 *   envelopeForUrl(url)             fetch → 譜｜null＋LRU 快取（電話句級 URL／重播鍵）
 *
 * 閾值自適應：以「該句自己的最大音量」為基準取相對比例——TTS 每句響度略有
 * 浮動，相對制讓任何一句都自動校準，不需要靈敏度拉桿（連拉桿的存在必要都省了）。
 */

export const ENV_FRAME_MS = 50;      // 一幀 50ms＝20fps 譜面解析度（人眼足夠、資料量小）
export const SILENCE_RATIO = 0.14;   // 低於 peak 的 14%＝靜音（閉嘴）
export const BIG_RATIO = 0.55;       // 高於 peak 的 55%＝大聲（張開）；中間＝微張
export const DECODE_TIMEOUT_MS = 2500; // 離線解碼超時保險：逾時放棄、退拍嘴
export const ENV_CACHE_MAX = 60;     // URL 譜快取上限（一份譜 KB 級，60 份＝百 KB 級）
const ABS_SILENCE_FLOOR = 1e-4;      // peak 絕對底線：整檔靜音＝沒有譜可言 → null
const FETCH_TIMEOUT_MS = 8000;       // 句級小檔的抓取保險（同源存檔／blob URL）

/** PCM → 嘴型譜。回 { frameMs, levels: Uint8Array }；空輸入／整段靜音 → null。
 *
 * 逐幀 RMS → 相對 peak 的三段閾值 → release 平滑：開嘴（attack）即時、閉嘴
 * （release）多一幀「縮口緩衝」——低谷首幀先收到 1 級、連續第二幀才真正歸 0。
 * 這是語音活動偵測的標準手法（attack fast, release slow）：逗號前的瞬間低谷
 * 不會讓嘴高頻開閉閃爍，真正的停頓（≥2 幀＝100ms）才閉嘴。 */
export function levelsFromPcm(pcm, sampleRate) {
  if (!pcm || !pcm.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const frameLen = Math.round((ENV_FRAME_MS / 1000) * sampleRate);
  if (frameLen <= 0) return null;
  const nFrames = Math.floor(pcm.length / frameLen);
  if (nFrames <= 0) return null;

  const rms = new Float64Array(nFrames);
  let peak = 0;
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const off = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const v = pcm[off + i];
      sum += v * v;
    }
    const r = Math.sqrt(sum / frameLen);
    rms[f] = r;
    if (r > peak) peak = r;
  }
  if (peak < ABS_SILENCE_FLOOR) return null;

  const levels = new Uint8Array(nFrames);
  let lowRun = 0; // 連續低於靜音門檻的幀數（release 平滑的記憶）
  for (let f = 0; f < nFrames; f++) {
    const ratio = rms[f] / peak;
    if (ratio < SILENCE_RATIO) {
      lowRun += 1;
      if (lowRun >= 2) {
        levels[f] = 0; // 真正的停頓：閉嘴
      } else {
        // 低谷首幀＝縮口緩衝：從上一幀的嘴型收小到最多 1，不猛閉
        const prev = f > 0 ? levels[f - 1] : 0;
        levels[f] = prev > 1 ? 1 : prev;
      }
    } else {
      lowRun = 0;
      levels[f] = ratio >= BIG_RATIO ? 2 : 1;
    }
  }
  return { frameMs: ENV_FRAME_MS, levels };
}

// ── 離線解碼（一次性、與播放管線徹底分家）─────────────────────────────────

let _ctx = null; // 模組級單例：解碼不需要 running 狀態，suspended 也能 decode
                 // （建構失敗不快取＝下次再試；iOS 對 context 數量有上限，單例正確）

function _audioCtx() {
  if (_ctx) return _ctx;
  // 直接全域 lookup（非 window.xxx）：真瀏覽器兩者等價；vitest jsdom 裡
  // window 與 globalThis 是不同物件，測試 mock 設在 globalThis——這個寫法兩邊通吃。
  const AC = (typeof AudioContext !== "undefined" && AudioContext)
    || (typeof webkitAudioContext !== "undefined" && webkitAudioContext)
    || null;
  if (!AC) return null;
  try { _ctx = new AC(); } catch (e) { return null; }
  return _ctx;
}

/** decodeAudioData 雙簽名相容：現代 promise 形＋老 Safari callback 形。
 * 兩邊誰先 settle 誰算數（同一次解碼，promise 只 settle 一次，重複 resolve 無害）。 */
function _decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/** Blob → ArrayBuffer：現代 blob.arrayBuffer() 優先，缺席（jsdom／老 Safari）
 * 退 FileReader——兩路等價，失敗都 reject 交給呼叫端的 catch。 */
function _blobToArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
    fr.readAsArrayBuffer(blob);
  });
}

/** 音檔 blob → 嘴型譜；任何失敗（無 AudioContext／decode 炸／超時）→ null。 */
export async function computeEnvelope(blob) {
  if (!blob) return null;
  const ctx = _audioCtx();
  if (!ctx) return null;
  try {
    const buf = await _blobToArrayBuffer(blob);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), DECODE_TIMEOUT_MS);
    });
    const decoded = await Promise.race([
      _decode(ctx, buf).catch(() => null),
      timeout,
    ]);
    clearTimeout(timer);
    if (!decoded || typeof decoded.getChannelData !== "function") return null;
    // TTS 輸出單聲道；多聲道也只取 ch0（嘴型譜不需要立體聲精度）
    return levelsFromPcm(decoded.getChannelData(0), decoded.sampleRate);
  } catch (e) {
    return null;
  }
}

// ── URL 譜快取（電話句級 URL／重播鍵 blob URL 共用）──────────────────────────

let _cache = new Map(); // url → Promise<env|null>；插入序當 LRU（同 TtsSynthCache）

/** 測試出口：清空快取＋AudioContext 單例（模組級狀態的測試隔離）。 */
export function _resetEnvelopeForTest() {
  _cache = new Map();
  _ctx = null;
}

/** 音檔 URL → 嘴型譜｜null。同 url 併發／重複呼叫共享同一份 Promise；失敗
 * （null）自我移除＝下次可重試，不把一次網路錯釘成永遠沒譜（同 TtsSynthCache
 * 哲學）。blob: URL 也吃（同 document 的 objectURL fetch 得回原 blob）。 */
export function envelopeForUrl(url) {
  if (typeof url !== "string" || !url) return Promise.resolve(null);
  if (_cache.has(url)) {
    const hit = _cache.get(url);
    _cache.delete(url); // 重新插入＝更新「最近用過」序
    _cache.set(url, hit);
    return hit;
  }
  const p = _fetchEnvelope(url).then((env) => {
    if (env === null && _cache.get(url) === p) _cache.delete(url);
    return env;
  });
  _cache.set(url, p);
  while (_cache.size > ENV_CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest); // 譜是純資料（無 objectURL 等資源），直接丟即可
  }
  return p;
}

async function _fetchEnvelope(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let blob;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res || !res.ok) return null;
      blob = await res.blob();
    } finally {
      clearTimeout(timer);
    }
    return await computeEnvelope(blob);
  } catch (e) {
    return null;
  }
}
