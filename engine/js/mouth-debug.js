/** ?mouthdebug=1 嘴型除錯浮層。
 *
 * 實驗室重現不了真機的「有聲、嘴不動」——必須拿本機的 ground truth。
 * 帶 ?mouthdebug=1 開頁時，左下角浮一塊唯讀狀態板，每 0.5 秒更新驅動鏈
 * 每一環的當下值；通話中截一張圖，死在哪層一眼分辨：
 *
 *   driver attached=false           → 接線層（attach 沒被呼叫）
 *   el paused=true 卻有聲           → 聲音出自別顆元件（單例假設破了）
 *   flapping=true 但嘴不動          → sprite 層（static 造型／degraded／打字 timer 佔用）
 *   sprite static=true              → 靜態外觀（static 模式）＝嘴本來就不動（設計，換動態造型即恢復）
 *
 * 純唯讀＋pointer-events:none 不擋任何操作；不帶參數＝整個模組 no-op 零成本。
 */

export function initMouthDebug(ctx) {
  let search = "";
  try {
    search = window.location.search || "";
  } catch (e) {
    return null;
  }
  let enabled = false;
  try {
    enabled = new URLSearchParams(search).get("mouthdebug") === "1";
  } catch (e) {
    enabled = false;
  }
  if (!enabled) return null;

  // 浮層開啟時把 ctx 掛全域——探針／遠端偵查可直達 driver/sprite/phone 實例
  // 拿 ground truth（僅 ?mouthdebug=1 時存在，正式使用零暴露）。
  window.__mouthDebugCtx = ctx;

  const box = document.createElement("pre");
  box.id = "mouth-debug";
  box.style.cssText =
    "position:fixed;left:8px;bottom:8px;z-index:99999;margin:0;padding:8px 10px;" +
    "background:rgba(0,0,0,.72);color:#9fe8a0;font:11px/1.5 monospace;" +
    "border-radius:6px;pointer-events:none;white-space:pre;max-width:72vw;overflow:hidden;";
  document.body.appendChild(box);

  // v2：先前版本的截圖分析顯示 v1 資訊量不夠終審——補上
  // ① 渲染心跳（renders 計數＋當下時刻：兩張截圖對照就知道浮層自己有沒有在跑）
  // ② driver 節拍實跑數（flapTicks：分辨「timer 在、回呼沒跑」）
  // ③ 頁面錯誤捕捉（回呼若在丟例外，這裡直接看到最後一條）
  // ④ sprite 深層：eye／亮著的幀／應該亮的幀／疊圖數——狀態與畫面的分歧點現形。
  let renders = 0;
  let errCount = 0;
  let lastErr = "";
  const noteErr = (msg) => {
    errCount += 1;
    lastErr = String(msg || "").slice(0, 90);
  };
  window.addEventListener("error", (e) => noteErr(e && e.message));
  window.addEventListener("unhandledrejection", (e) => {
    noteErr(e && e.reason && (e.reason.message || e.reason));
  });

  const render = () => {
    renders += 1;
    const d = ctx.driver && typeof ctx.driver.debugState === "function"
      ? ctx.driver.debugState() : {};
    const s = ctx.sprite || {};
    let phoneActive = false;
    try {
      phoneActive = !!(ctx.phone && ctx.phone.isActive && ctx.phone.isActive());
    } catch (e) { /* 唯讀浮層絕不因取值失敗炸掉 app */ }
    let ttsOn = "?";
    try {
      ttsOn = ctx.isTtsEnabled ? String(!!ctx.isTtsEnabled()) : "?";
    } catch (e) { /* 同上 */ }
    let expectFrame = "?";
    try {
      expectFrame = s._frames && s._frameTable && s._frameTable[s._eye]
        ? s._frameTable[s._eye][s._mouth] : "?";
    } catch (e) { /* 同上 */ }
    const clock = new Date().toTimeString().slice(0, 8);
    const lines = [
      "MOUTH DEBUG v2  " + clock + "  renders=" + renders + "  errors=" + errCount,
      "driver: attached=" + d.attached + " flapping=" + d.flapping +
        " ticks=" + d.flapTicks +
        (d.lastTickAgoMs != null ? " (last " + d.lastTickAgoMs + "ms)" : "") +
        " mode=" + d.mode,
      // 樂譜制：envFrames=0＝這句沒譜（走拍嘴）；score-drive 時 level＝當下譜面嘴型
      "env: frames=" + (d.envFrames != null ? d.envFrames : "?") +
        " level=" + (d.lastLevel != null ? d.lastLevel : "?"),
      "el: paused=" + d.elPaused + " ended=" + d.elEnded + " ready=" + d.elReadyState +
        " t=" + d.elTime + " src=" + d.srcKind,
      "lastEvent: " + d.lastEvent +
        (d.lastEventAgoMs != null ? " (" + d.lastEventAgoMs + "ms ago)" : ""),
      "sprite: static=" + !!s._static + " degraded=" + !!s._degraded +
        " typingTalk=" + !!s._talkTimer + " mouth=" + (s._mouth != null ? s._mouth : "?") +
        " eye=" + (s._eye || "?"),
      "frames: shown=" + (s._shownFrame || "-") + " expect=" + expectFrame +
        " stack=" + (s._stack ? s._stack.size : 0) +
        " imgs=" + (s.container ? s.container.querySelectorAll("img").length : "?"),
      "phone: active=" + phoneActive + "  tts: enabled=" + ttsOn,
    ];
    if (errCount) lines.push("lastError: " + lastErr);
    box.textContent = lines.join("\n");
  };

  render();
  const timer = setInterval(render, 500);
  return {
    box,
    stop: () => {
      clearInterval(timer);
      box.remove();
    },
  };
}
