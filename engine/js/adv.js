/**
 * adv.js —— 乙女遊戲式 ADV 對話框呈現層。
 *
 * 職責：對方「當前這一句」的舞台呈現——名牌＋正文打字機＋思考中指示。對話的完整
 * 歷史仍然全數落在 Chat Log（chat.js renderFrame 那條既有管線，本檔不取代它）；
 * 這裡只負責「角色正在說的話」這一層戲。分派點在 app.js 的 `chat.onFrame`：
 *   role:"assistant" 完整回覆 → present()（同一個 frame 也照舊進 Chat Log＋TTS）
 *   role:"status" 思考中  → thinking()（不再進 Chat Log——狀態本來就是 transient）
 * 歷史回填後 app.js 會把最後一句對方的話用 present({instant:true}) 放上框當開場。
 *
 * 打字機：約 30ms/字逐字上屏（乙遊節奏）；`prefers-reduced-motion: reduce` 或
 * `instant:true` 時整句直接顯示。新句抵達時舊句立即定格完稿再開新句——絕不兩句
 * 交錯。計時器用 setInterval，stop()/新 present() 都會先清掉。
 *
 * 命名鐵則（開源分離規範）：本檔零角色專屬字樣；名牌文字由呼叫端傳入
 * （config.characterName），DOM class 一律 adv-* 中性命名。
 * XSS 紀律：全部 textContent／createTextNode 路徑，禁 innerHTML（同 chat.js）。
 */
import { t } from "./i18n.js";

const TYPE_INTERVAL_MS = 30;

export class AdvPresenter {
  /**
   * @param {{container: HTMLElement, characterName?: string,
   *          onTypingChange?: (typing: boolean) => void}} opts
   *   onTypingChange：打字機起跑（true）／收筆（false）通知——app.js 拿它驅動
   *   立繪說話口型（「打字＝他在講話，嘴要動」）。instant 顯示
   *   不觸發（沒有打字過程）。
   */
  constructor({ container, characterName = "", onTypingChange } = {}) {
    this.container = container;
    this._timer = null;
    this._onTypingChange = typeof onTypingChange === "function" ? onTypingChange : null;
    this._reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    // DOM 骨架（同 SpritePlayer 對 #stage 的慣例：容器留空、類別建內容）：
    // .adv-box（框，CSS 上素材皮）＞ .adv-nameplate（名牌）＋ .adv-text（正文）
    // ＋ .adv-indicator（思考中「⋯⋯」脈動，hidden 預設）。
    this.box = document.createElement("div");
    this.box.className = "adv-box";

    this.nameplate = document.createElement("div");
    this.nameplate.className = "adv-nameplate";
    this.nameplate.textContent = characterName;

    this.textEl = document.createElement("div");
    this.textEl.className = "adv-text";
    // 螢幕報讀器把這裡當「他說話」的即時區域；打字機逐字改動很吵，用 aria-live
    // 搭配打完才更新的 aria-label 太複雜——直接 polite ＋ atomic，報讀器會在句子
    // 穩定後唸整句（打字機期間的中間狀態被 coalesce 掉，實測主流讀屏皆如此）。
    this.textEl.setAttribute("aria-live", "polite");
    this.textEl.setAttribute("aria-atomic", "true");

    this.indicator = document.createElement("div");
    this.indicator.className = "adv-indicator";
    this.indicator.setAttribute("aria-hidden", "true");
    this.indicator.hidden = true;
    // 三顆脈動點（純 CSS 動畫，見 layout.css .adv-indicator i）
    for (let i = 0; i < 3; i++) this.indicator.appendChild(document.createElement("i"));

    // Thinking 切換鈕（乙遊框角小鈕，常駐顯示——
    // 讓人一眼知道這個前端帶思考鏈）。雙態：這輪有思緒＝亮態（has-thoughts）、
    // 沒有＝退階靜默但仍可點——切過去看到一句淡淡的說明（比切到全空白貼心）。
    // 點一下正文↔思緒切換。思緒是 transient（不落帳本、不回填），這顆鈕就是它
    // 唯一的舞台。框本體 pointer-events none，鈕自己開 auto（CSS）。
    this.thinkingBtn = document.createElement("button");
    this.thinkingBtn.type = "button";
    this.thinkingBtn.className = "adv-thinking-btn";
    this.thinkingBtn.textContent = "Thinking";
    this.thinkingBtn.setAttribute("aria-pressed", "false");
    this._thoughts = "";
    this._thoughtsPending = false; // 思緒轉寫背景進行中（第三態）
    this._showingThoughts = false;
    this.thinkingBtn.addEventListener("click", () => this._toggleThoughts());

    this.box.appendChild(this.nameplate);
    this.box.appendChild(this.thinkingBtn);
    this.box.appendChild(this.textEl);
    this.box.appendChild(this.indicator);
    container.appendChild(this.box);
  }

  _toggleThoughts() {
    this._stopTimer(); // 打字中切＝先定格完稿，切回來時是整句
    this._showingThoughts = !this._showingThoughts;
    this.box.classList.toggle("adv-showing-thoughts", this._showingThoughts);
    this.thinkingBtn.setAttribute("aria-pressed", String(this._showingThoughts));
    // 空思緒的思緒頁＝一句淡說明（切過去空白也沒關係——給句話更貼心；
    // 樣式吃 .adv-showing-thoughts 的斜體退階，自然像註腳）。pending 第三態
    // ＝轉寫還在背景跑，佔位句換「浮現中」。
    this.textEl.textContent = this._showingThoughts
      ? (this._thoughts || this._thoughtsPlaceholder())
      : (typeof this._fullText === "string" ? this._fullText : "");
  }

  /** 空思緒頁的佔位句：pending（轉寫進行中）與退階（這輪定案無卡）兩態各一句。 */
  _thoughtsPlaceholder() {
    return this._thoughtsPending ? t("adv.thoughtsPending") : t("adv.noThoughts");
  }

  /** @param {*} thoughts 這輪思緒（字串＝亮態；其餘＝空）
   *  @param {boolean} [pending] 轉寫背景進行中——truthy 且無
   *    思緒字串時進第三態（is-pending 呼吸＋佔位句「浮現中」）。三態互斥：
   *    有思緒＝亮態（pending 強制 false，契約上 thoughts_pending=true 時 thoughts
   *    恆 null，這裡只是防禦）；pending＝呼吸態；皆無＝退階。 */
  _setThoughts(thoughts, pending) {
    this._thoughts =
      typeof thoughts === "string" ? thoughts.trim().replace(/\n{2,}/g, "\n") : "";
    this._thoughtsPending = !!pending && !this._thoughts;
    // 新戲一律從正文開始演（上一輪停在思緒頁也翻回來）；鈕常駐、三態標記
    this._showingThoughts = false;
    this.box.classList.remove("adv-showing-thoughts");
    this.thinkingBtn.setAttribute("aria-pressed", "false");
    this.thinkingBtn.classList.toggle("has-thoughts", !!this._thoughts);
    this.thinkingBtn.classList.toggle("is-pending", this._thoughtsPending);
    // 讀屏同步：pending＝內容載入中（標準 aria-busy 語意）；離態即除。
    if (this._thoughtsPending) this.thinkingBtn.setAttribute("aria-busy", "true");
    else this.thinkingBtn.removeAttribute("aria-busy");
  }

  /** 晚到思緒更新入口：背景轉寫完成後 app.js 依 for_ts 校驗
   * 通過才呼叫。text 字串＝設思緒＋轉亮態（正停在思緒頁＝原地刷新內容）；
   * null（或空白）＝這輪定案無卡：清 pending 回退階（佔位句換回「沒有留下思緒」）。
   * 只動思緒側狀態——不翻頁、不碰正文打字機（正文可能還在打或使用者正在讀）；
   * 已亮的思緒不會被 null 撤掉（null 只殺 pending，不殺已送達的卡——防禦語意，
   * 正常時序下 null 只會到在 pending 中）。 */
  updateThoughts(text) {
    const clean =
      typeof text === "string" ? text.trim().replace(/\n{2,}/g, "\n") : "";
    this._thoughtsPending = false;
    this.thinkingBtn.classList.remove("is-pending");
    this.thinkingBtn.removeAttribute("aria-busy");
    if (clean) {
      this._thoughts = clean;
      this.thinkingBtn.classList.add("has-thoughts");
    }
    // 正停在思緒頁：原地刷新——字串＝新內容直接上；null＝佔位句回退階版。
    if (this._showingThoughts) {
      this.textEl.textContent = this._thoughts || this._thoughtsPlaceholder();
    }
  }

  /** 呈現一句完整回覆。opts.instant=true（或使用者偏好減少動態）＝跳過打字機；
   * opts.thoughts＝這輪的思緒（有值＝Thinking 鈕現身）；
   * opts.thoughtsPending＝轉寫在背景跑（此時 thoughts 恆
   * null，後端契約）——鈕進 is-pending 呼吸態，晚到結果走 updateThoughts()。
   * partial 流的 present({resume:true}) 不帶 pending（轉寫要不要跑到 final 才
   * 知道）——中間輪 _setThoughts(undefined, undefined) 維持退階＝現狀不變。
   * 顯示層空行壓縮：連續空行摺成單一換行——句與句緊鄰換行、
   * 不再隔一整行的空。只動「這裡怎麼演」，他的原話（帳本／Chat Log 資料層）
   * 一字不動。
   *
   * opts.resume（邊寫邊送）：partial frame 送來的是這一輪目前
   * 累積的完整文字（不是增量），每次都要「接著打」而不是「重頭打」——canResume
   * 判準：resume 有開＋現況非空＋新全文確實以現況為前綴＋非 reduced-motion，四者
   * 皆成立才續打；缺一即退回一般 present() 行為（重頭），這包含「新文字其實跟
   * 現況對不上」的邊界情況（如 final frame 洗掉 tmux 220 欄硬換行造成的雜訊換行，
   * 導致 clean 過的 final 文字不再是 partial 累積文字的嚴格前綴——這種落差視為
   * 可接受的設計邊界：退回重頭打，不強行修補文字比對）。
   *
   * `_stopTimer()` 有「定格完稿」副作用——中途被清時會把 `_fullText` 貼回
   * `textEl`。resume 續打的起點在**現況**（`shown`），不是上一次 present() 設定的
   * `_fullText`（那可能是上一輪還沒打完的更長目標）；如果照舊順序直接呼叫
   * `_stopTimer()`，畫面會先被那個舊目標的「定格完稿」貼上瞬間全文，下一拍才被
   * 新目標蓋過去——一次可見的閃跳。修法：resume 成立時**先**把 `_fullText` 蓋成
   * 「現在實際顯示的字串」（`shown`）再呼叫 `_stopTimer()`，讓定格點＝現況，
   * `_stopTimer()` 的副作用因此變成無感的自我確認，不會倒帶也不會跳終。
   *
   * 思緒頁污染防呆：Thinking 鈕串流中常駐可點
   * （layout.css `.adv-thinking-btn { pointer-events: auto; }`，從不 disable）。
   * 若在 partial 串流打字中途點開它，`textEl.textContent` 這一刻顯示的是
   * `_toggleThoughts` 寫入的思緒文字／佔位句，不是正文——如果 `shown` 直接讀
   * `textEl.textContent`，resume 基準會被這段文字污染（幾乎不可能是新全文的
   * 前綴），導致 `canResume` 誤判為 false、整段已累積的回覆被迫重頭打一次，
   * 正是「不閃跳」這個功能想避免的事，只是觸發條件換成了一個支援中的互動而非
   * 單純的新 partial 抵達。
   * 修法：`_toggleThoughts` 進思緒頁前一定先呼叫 `_stopTimer()`，那一刻
   * `_fullText` 已經照上面的既有慣例被定格成「切換當下的完整正文」（`settle()`／
   * `thinking()` 等既有中斷路徑同樣遵守「中斷＝補到完整終值，不留半句」）——
   * 因此思緒頁開著時，正確的續打基準是 `_fullText`，不是 `textEl.textContent`。
   * 光修基準還不夠：`canResume` 成立時，原本的邏輯會假設 `textEl` 已經顯示正確
   * 前綴而略過重寫（省一次無謂的 DOM 寫入）——這個假設在思緒頁情境下不成立
   * （畫面顯示的仍是思緒文字），所以下面顯式判斷 `wasShowingThoughts`，該補寫
   * 的續打前綴（或清空）補回去，不留一拍思緒文字殘影。`_setThoughts(opts.thoughts)`
   * 本來就會把 `_showingThoughts`／CSS 樣式重置回正文態，這裡不重複那段，只補
   * 上它没做的：把 `textEl` 的內容也同步换回正文。 */
  present(text, opts = {}) {
    const full = (typeof text === "string" ? text : "").replace(/\n{2,}/g, "\n");
    const wasShowingThoughts = this._showingThoughts;
    const shown = wasShowingThoughts
      ? (typeof this._fullText === "string" ? this._fullText : "")
      : (this.textEl.textContent || "");
    const canResume = !!opts.resume && !!shown && full.startsWith(shown) && !this._reduced;
    if (canResume) this._fullText = shown; // 定格點＝現況，_stopTimer 不得倒帶也不得跳終
    this._stopTimer();
    this._setThinking(false);
    this._setThoughts(opts.thoughts, opts.thoughtsPending); // 順手把 _showingThoughts／樣式重置回正文態（pending 三態一併重算）
    this._fullText = full; // 打字機中途被打斷時 _stopTimer 用它定格完稿
    if (!full) {
      this.textEl.textContent = "";
      return;
    }
    if (opts.instant || this._reduced) {
      this.textEl.textContent = full;
      return;
    }
    // 打字機：Array.from 以 code point 切分（surrogate pair 安全——emoji／罕見字
    // 不會被劈成半個亂碼字元）。resume 時起點 i 落在「現況已顯的長度」，不是 0——
    // 續打第一拍直接從下一個字元開始，不會重繪已經在螢幕上的前綴。
    const chars = Array.from(full);
    let i = canResume ? Array.from(shown).length : 0;
    // canResume 成立且 textEl 本來就顯示正確前綴（一般情況）時不必重寫；但
    // !canResume（重頭）或 wasShowingThoughts（剛從思緒頁切回，textEl 現在顯示
    // 的還是思緒文字，即使 canResume 成立也不能沿用畫面現況）都必須顯式寫入
    // 前綴——canResume 為 false 時 i=0，slice(0,0) 自然就是空字串，兩種情況共用
    // 同一行不必分支。
    if (!canResume || wasShowingThoughts) {
      this.textEl.textContent = chars.slice(0, i).join("");
    }
    if (i >= chars.length) {
      this.textEl.textContent = full; // resume 且已顯完（零成長的重複 partial）＝定格，不重啟打字機
      return;
    }
    this._notifyTyping(true);
    this._timer = setInterval(() => {
      i += 1;
      this.textEl.textContent = chars.slice(0, i).join("");
      if (i >= chars.length) this._stopTimer();
    }, TYPE_INTERVAL_MS);
  }

  /** 思考中：正文清空、顯示脈動點。傳入文字（協定 status frame 的 text）當
   * 無障礙描述，視覺上只顯示點（乙遊感——文字版的「思考中⋯⋯」留給讀屏）。 */
  thinking(text) {
    this._stopTimer();
    this._fullText = ""; // 進思考態＝上一句戲份結束，別讓 _stopTimer 又把舊句補回來
    this._setThoughts(""); // 新輪醞釀中：上一輪的思緒鈕收掉
    this.textEl.textContent = "";
    this.indicator.setAttribute(
      "aria-label",
      typeof text === "string" && text ? text : "……"
    );
    this._setThinking(true);
  }

  /** 立即定格：打字機若在跑，直接顯示整句（新 frame 抵達前的收尾）。 */
  settle() {
    this._stopTimer();
  }

  /** 待機提示（正文為空時的 placeholder，CSS `:empty::before` 顯示）：連線中／
   * 未連線時框裡不留空玻璃。這是介面系統文字，不是對方的話——不走 present()
   * 的語意（不進打字機、不佔 aria-live 即時區）。 */
  setIdleNote(text) {
    if (typeof text === "string" && text) {
      this.textEl.dataset.idle = text;
    } else {
      delete this.textEl.dataset.idle;
    }
  }

  _setThinking(on) {
    this.indicator.hidden = !on;
    this.box.classList.toggle("adv-thinking", !!on);
  }

  _stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      // 定格完稿：計時器在句子中途被清（settle()／新 present()／thinking()）時，
      // 把正文直接補到完整終值——絕不停在半句。
      if (typeof this._fullText === "string" && this._fullText) {
        this.textEl.textContent = this._fullText;
      }
      this._notifyTyping(false); // 打字真的在跑才有「收筆」可言（timer guard 內）
    }
  }

  _notifyTyping(typing) {
    if (!this._onTypingChange) return;
    try {
      this._onTypingChange(!!typing);
    } catch (e) {
      /* 回呼炸了不拖累戲台本體（同 chat.js onFrame 回呼的防禦立場） */
    }
  }
}
