"use strict";

/** 純函式：這個環境需不需要掛 iOS 捏合鎖（抽出來給測試）。 */
export function shouldInstallGestureGuard(win) {
  return !!win && !!win.document && "GestureEvent" in win;
}

/**
 * iOS 頁面級捏合縮放鎖：頁面被放大後視覺視口可雙軸平移、fixed 元素會被
 * 推出可視區——app 式介面直接擋掉（系統層輔助縮放不受影響）。
 * 回傳是否有掛（非 iOS 無 GestureEvent＝零行為、回 false）。
 * passive:false 必須明給——preventDefault 在 passive listener 內是 no-op。
 */
export function installViewportLock(win) {
  const w = win || window;
  if (!shouldInstallGestureGuard(w)) return false;
  const stop = function (e) { e.preventDefault(); };
  ["gesturestart", "gesturechange", "gestureend"].forEach(function (type) {
    w.document.addEventListener(type, stop, { passive: false });
  });
  return true;
}
