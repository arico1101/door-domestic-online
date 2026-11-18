/* ===== トビラ 国内版 オンライン — クライアント =====
   判定はすべてサーバー(Durable Object)が行う。ここは表示と入力だけを担当する。 ===== */
import * as R from "./rules.js";
import * as SE from "./se.js";

/* ---------- i18n ---------- */
/* 国内版は日本語だけ。画面の部品はせかい版から引きついだ日英の作りのままだが、
   ゲームの中身（家庭カード・トビラ・できごと）は日本語しかないので、言語は日本語に固定する */
let lang = "ja";
const L = v => (v && typeof v === "object" && v.ja !== undefined) ? v[lang] : v;
const fm = n => lang === "ja" ? `${n}万` : `${n < 0 ? "-" : ""}¥${(Math.abs(n) * 10).toLocaleString("en-US")}k`;
const fage = n => lang === "ja" ? `${n}歳` : `Age ${n}`;
const ja = () => lang === "ja";
const $ = id => document.getElementById(id);

/* 描いたアイコン（index.html の <symbol> を参照する。絵文字は使わない） */
const ic = (name, cls) => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
/* 見た目は家庭カードで決まる（サーバーの R.assignChars が p.char を送ってくる）。
   配る前のロビーだけは、席の色から仮のキャラを引く */
const charOf = p => p.char || R.CHARS[Math.max(0, R.PCOLORS.indexOf(p.color))] || R.CHARS[0];
const faceBg = p => `background-image:url(./chars/${charOf(p)}-face.png)`;

/* ---------- 通信 ---------- */
let ws = null, G = null, YOU = null, MYPID = null, ROOM = null, retry = 0;
let shown = {};            /* コマの表示位置（1マスずつ動かすため） */
let lastKey = "";          /* 同じモーダルを描き直さないための署名 */
let animTimer = null;
let previewMode = false;
let resultSe = false;      /* 結果発表のファンファーレを、一度だけにするための目印 */

/* ---------- 効果音 ---------- */
/* Storybook のプレビューでは鳴らさない（画面を見るための表示なので） */
const se = name => { if (!previewMode) SE.play(name); };
/* ボタンは data-se で音を指定する。指定がなければタップ音、"off" なら押した先で鳴らす。
   最初のタップで AudioContext もつないでおく（ブラウザは操作前に音を出せない） */
document.addEventListener("pointerdown", e => {
  const b = e.target.closest && e.target.closest("button");
  if (!b || b.disabled || previewMode) return;
  SE.resume();
  const name = b.dataset.se || "tap";
  if (name !== "off") SE.play(name);
}, true);
function syncSe() {
  const on = SE.isOn();
  const label = on ? (ja() ? "音 ON" : "Sound on") : (ja() ? "音 OFF" : "Sound off");
  $("seBtnLabel").textContent = on ? (ja() ? "音" : "Sound") : (ja() ? "消音" : "Muted");
  $("seBtn").querySelector("use").setAttribute("href", on ? "#ic-sound" : "#ic-mute");
  $("seBtn").setAttribute("aria-pressed", String(on));
  $("seBtn").setAttribute("aria-label", label);
  $("seBtnLobby").textContent = label;
  $("seBtnLobby").classList.toggle("on", on);
  $("seBtnLobby").setAttribute("aria-pressed", String(on));
}
const flipSe = () => { const on = SE.toggle(); syncSe(); if (on) SE.play("pop"); };
$("seBtn").onclick = flipSe;
$("seBtnLobby").onclick = flipSe;

function myId() {
  /* 同じ端末の別タブでも別プレイヤーになれるよう、まずタブ内(sessionStorage)を見る。
     ?pid= を付けると固定できる（同じ端末で複数人が遊ぶとき・テスト用） */
  const forced = new URLSearchParams(location.search).get("pid");
  if (forced) { sessionStorage.setItem("tobira-pid", forced); return forced; }
  let id = sessionStorage.getItem("tobira-pid") || localStorage.getItem("tobira-pid");
  if (!id) id = crypto.randomUUID();
  sessionStorage.setItem("tobira-pid", id);
  localStorage.setItem("tobira-pid", id);
  return id;
}
function connect(code, name) {
  ROOM = code;
  localStorage.setItem("tobira-room", code);
  localStorage.setItem("tobira-name", name);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(code)}&pid=${encodeURIComponent(myId())}&name=${encodeURIComponent(name)}`);
  ws.onopen = () => { retry = 0; $("connMsg").textContent = ""; };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "state") { MYPID = m.pid; G = m.g; YOU = m.you; M = R.mode(G.mode); window.__tobira.msgs++; render(); }
  };
  ws.onclose = () => {
    if (!ROOM) return;
    $("connMsg").textContent = ja() ? "接続が切れました。つなぎ直しています…" : "Disconnected. Reconnecting…";
    setTimeout(() => connect(code, name), Math.min(1000 * ++retry, 5000));
  };
  ws.onerror = () => {};
}
let M = R.mode("full");   /* いま描いている盤面。状態が届くたびに入れかえる */
const firstAge = () => M.AGES[0];
const lastAge = () => M.AGES[M.AGES.length - 1];
const years = () => lastAge() - firstAge();
const hasTalk = () => M.SQUARES.some(sq => sq.t === "talk");
const send = m => { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(m)); } catch {} };

/* ---------- 画面切り替え ---------- */
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
}
/* パネルの外を押したときにすること。null のあいだは外を押しても閉じない。
   トビラやできごとは選ばずに閉じられると進行が止まるので、既定は閉じない側にしておく */
let modalDismiss = null;
/* userModal：いま開いているのが「自分でボタンを押して開いたもの」か
   （じぶんのカード・あそびかた・ネタバラシ・トビラ一覧）。
   これが true のあいだは、サーバーから状態が届いても勝手に閉じない。
   以前は状態が届くたびに閉じていて、ネタバラシを開いた直後に消える不具合になっていた。 */
let userModal = false;
function openModal(html, watching, onDismiss) {
  $("modalBox").className = "modal" + (watching ? " watching" : "");
  $("modalBox").innerHTML = html;
  $("overlay").classList.add("open");
  $("modalBox").scrollTop = 0;
  modalDismiss = onDismiss || null;
}
function closeModal() {
  $("overlay").classList.remove("open"); $("modalBox").innerHTML = ""; lastKey = ""; modalDismiss = null; userModal = false;
}
const isOpen = () => $("overlay").classList.contains("open");
/* 外側は、下の閉じるボタンとまったく同じことをする */
$("overlay").onclick = e => { if (e.target === $("overlay") && modalDismiss) modalDismiss(); };

/* ---------- ロビー ---------- */
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   /* まぎらわしい文字は除く */
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const nameOf = () => ($("nameInput").value.trim() || (ja() ? "プレイヤー" : "Player")).slice(0, 12);

$("createBtn").onclick = () => connect(newCode(), nameOf());
$("joinBtn").onclick = () => {
  const c = $("codeInput").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(c)) { $("connMsg").textContent = ja() ? "コードを入れてください" : "Enter a room code"; return; }
  connect(c, nameOf());
};
$("startBtn").onclick = () => send({ t: "start", heavyOn: $("heavyToggle").checked });
$("againBtn").onclick = () => send({ t: "again" });
/* 自分で開くパネル。他人の番のモーダルの上には重ねてよく、閉じたら元の画面にもどる。
   自分の番の最中は開かない（トビラを選んでいる途中の画面が巻きもどってしまうため） */
const openOverPending = fn => {
  if (userModal) return;                                  /* すでに自分で開いている */
  if (!isOpen()) return fn(() => render());
  if (G && G.pending && G.pending.for !== MYPID) return fn(() => { lastKey = ""; render(); });
};
$("cardBtn").onclick = () => { if (YOU) openOverPending(cb => showCard(true, cb)); };
$("helpBtnGame").onclick = () => openOverPending(() => renderRules(0));
/* あいことばは、押すとコピーできる（途中で入りなおす人に伝えるため） */
$("roomChip").onclick = async () => {
  if (!ROOM) return;
  try { await navigator.clipboard.writeText(ROOM); } catch { return; }
  const el = $("roomChip");
  el.classList.add("copied");
  setTimeout(() => el.classList.remove("copied"), 1200);
};
$("hostBtn").onclick = () => { if (hostOpen()) closeHost(); else renderHostPanel(); };
$("claimBtn").onclick = () => send({ t: "claimHost" });

/* ---------- サイコロ ---------- */
const PIPS = {1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8]};
let spinTimer = null;
function diceFace(n, box) {
  const on = new Set(PIPS[n] || []);
  (box || $("diceFace")).innerHTML = Array.from({ length: 9 }, (_, i) => on.has(i) ? "<span><i></i></span>" : "<span></span>").join("");
}
/* 画面中央の大きなサイコロ。立体の6面を組んで、本体ごと転がす。
   出目を決めるのはサーバーなので、返事が来るまで回しつづけて、来たら着地させる。
   着地するまでコマも歩かせない（diceBusy） */
let diceBusy = false, rollStart = 0;
const MIN_ROLL = 900, HOLD = 820;                /* 着地の回りこみ(.6s)を見せてから閉じる */
/* その目の面が正面を向くように、本体を回す向き。CSSの .f1〜.f6 の置き方と対になっている */
const FACE_ROT = {
  1: "rotateX(0deg) rotateY(0deg)", 2: "rotateX(0deg) rotateY(-90deg)",
  3: "rotateX(-90deg) rotateY(0deg)", 4: "rotateX(90deg) rotateY(0deg)",
  5: "rotateX(0deg) rotateY(90deg)", 6: "rotateX(0deg) rotateY(180deg)",
};
/* 6面ぶんの目を一度だけ組み立てる */
function buildBigDie(die) {
  if (die.childElementCount) return;
  for (let n = 1; n <= 6; n++) {
    const face = document.createElement("div");
    face.className = "face f" + n;
    diceFace(n, face);
    die.appendChild(face);
  }
}
function startBigDice() {
  if (diceBusy) return;
  diceBusy = true; rollStart = Date.now();
  const stage = $("diceStage"), scene = $("dieScene"), die = $("bigDie");
  buildBigDie(die);
  stage.classList.add("on");
  scene.classList.remove("land");
  die.classList.remove("land"); die.style.transform = ""; die.classList.add("roll");
  $("dieMsg").textContent = "";                 /* 回っているあいだは文字を出さない。前回の「N マスすすむ！」も消す */
  se("roll");
  spinTimer = setInterval(() => diceFace(1 + Math.floor(Math.random() * 6)), 80);
}
function landBigDice(n) {
  if (!diceBusy || !spinTimer) return;
  const wait = Math.max(0, MIN_ROLL - (Date.now() - rollStart));
  setTimeout(() => {
    if (!spinTimer) return;
    clearInterval(spinTimer); spinTimer = null;
    const die = $("bigDie");
    /* 回っている途中の向きをいったん固定してから着地の向きへ動かす。
       そうしないと、アニメを外した瞬間に正面向きへ飛んでしまう */
    const mid = getComputedStyle(die).transform;
    die.classList.remove("roll");
    die.style.transition = "none";
    die.style.transform = mid;
    void die.offsetWidth;                         /* ここで一度レイアウトさせる */
    die.style.transition = "";
    die.classList.add("land");
    die.style.transform = FACE_ROT[n] || FACE_ROT[1];
    $("dieScene").classList.add("land");
    diceFace(n);
    se("land");
    $("dieMsg").textContent = ja() ? `${n} マスすすむ！` : `Move ${n}!`;
    setTimeout(() => {
      $("diceStage").classList.remove("on");
      diceBusy = false;
      if (G) { stepAnim(); renderPending(); }     /* ここからコマが歩きだす */
    }, HOLD);
  }, wait);
}
$("diceBtn").onclick = () => {
  const cur = G && G.players[G.turn];
  /* 子ども時代は1マスずつなので、サイコロの音ではなく足音にする */
  if (cur && cur.pos >= 4) startBigDice(); else se("step");
  send({ t: "roll" });
};

/* ---------- 言語 ---------- */
function applyLang() {
  document.documentElement.lang = ja() ? "ja" : "en";
  document.title = "トビラ 国内版 オンライン";
  $("langJa").classList.toggle("on", ja());
  $("langEn").classList.toggle("on", !ja());
  $("gameSub").textContent = "国内版 オンライン ─ みんなの端末で遊ぶ";
  $("nameInput").placeholder = ja() ? "なまえ" : "Your name";
  $("createBtn").textContent = ja() ? "ルームをつくる" : "Create a room";
  $("joinNote").textContent = ja() ? "または、進行役から聞いたコードで参加：" : "Or join with the code from your host:";
  $("joinBtn").textContent = ja() ? "ルームに参加" : "Join room";
  $("lobbyNote").innerHTML = ja()
    ? "1台ずつ、自分の端末で開いてください。<br><b>上のみんなの名前を押すと、その人の家庭カードが見られます。</b>"
    : "Open this on your own device.<br><b>Tap anyone's name at the top to see their family card.</b>";
  $("waitTitle").textContent = ja() ? "まっています" : "Waiting";
  $("codeLabel").textContent = ja() ? "あいことば" : "Room code";
  $("shareNote").textContent = ja() ? "このコードを、いっしょに遊ぶ人に伝えてください。" : "Share this code with the other players.";
  $("heavyLabel").innerHTML = ja()
    ? "死別・震災などのライフイベントを含める<br><small>ファシリテーター向け設定。参加者の状況にあわせてONにしてください。</small>"
    : "Include loss & disaster life events<br><small>For facilitators. Turn on when it suits your group.</small>";
  $("startBtn").textContent = ja() ? "ゲーム開始" : "Start game";
  $("cardBtnLabel").textContent = ja() ? "じぶんのカード" : "My card";
  $("helpBtnLabel").textContent = ja() ? "あそびかた" : "How to play";
  $("hostBtnLabel").textContent = ja() ? "進行" : "Host";
  $("cardBtn").setAttribute("aria-label", ja() ? "自分の家庭カードとステータスを見る" : "See my card and status");
  $("helpBtnGame").setAttribute("aria-label", ja() ? "あそびかた" : "How to play");
  $("hostBtn").setAttribute("aria-label", ja() ? "進行役メニュー" : "Host tools");
  $("logoTxt").textContent = ja() ? "トビラ" : "TOBIRA";
  $("resTitle").textContent = ja() ? "けっか はっぴょう" : "Results";
  resultLabels();
  $("againBtn").textContent = ja() ? "もういちど遊ぶ" : "Play again";
  syncSe();
  if (G) { renderBoard(); render(); }
}
/* 言語の切りかえは出さない（上の lang のコメント参照） */
$("langJa").style.display = "none";
$("langEn").style.display = "none";

/* ================= 盤面 =================
   マスをマス目に並べるのではなく、1本の道を24等分してタイルに切る。
   タイルが曲がることで「つぎにどっちへ進むか」が形そのものでわかる。 */
const NS = "http://www.w3.org/2000/svg";
const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
const mqMobile = window.matchMedia("(max-width:700px)");

/* 段と段のあいだを広くとるほど、曲がり角の半径(corner)を大きくできる。
   半径がマスの幅に近いと内がわがつぶれて扇形になるので、幅の1.7倍以上を保つ。
   空はマスを置くぶんだけ細くして、盤面を上まで使う。 */
/* 盤面の道。マスの数だけ等分して切るので、段の数ぶんだけ折れ線を用意する。
   みじかめ（24マス）は PC 4段・スマホ 8段、ぜんぶ（36マス）は PC 6段・スマホ 12段。 */
const LAY_WIDE = {
  vb: [1780, 864], corner: 100, skyH: 84, artH: 250, aspect: 2.06,
  /* 1段目と4段目だけ左へ66のばしてある。こうすると3つのUターンがちょうど半分で
     切れて、切り口が水平になる（1段目には曲がり角が1つしかないぶんの帳尻） */
  pts: [[106,150],[1672,150],[1672,360],[172,360],[172,570],[1672,570],[1672,780],[106,780]],
  sub: true, tokenW: 52, tokenH: 66, fsBig: 21, fsSmall: 17,
};
/* ぜんぶ（36マス）の PC 6段。のばし量は4段と同じ66でよい——段を足しても
   Uターンの切れ目は同じ周期でくり返すので、切り口は水平のまま（ずれ0.003タイル） */
const LAY_WIDE_FULL = {
  vb: [1780, 1284], corner: 100, skyH: 84, artH: 250, aspect: 1.386,
  pts: [[106,150],[1672,150],[1672,360],[172,360],[172,570],[1672,570],
        [1672,780],[172,780],[172,990],[1672,990],[1672,1200],[106,1200]],
  sub: true, tokenW: 52, tokenH: 66, fsBig: 21, fsSmall: 17,
};
const LAY_TALL = {
  /* スマホは上の余白を広めにとって、風景が見えるようにしてある */
  vb: [560, 1965], corner: 112, skyH: 108, artH: 235,
  pts: [[92,200],[468,200],[468,440],[92,440],[92,680],[468,680],[468,920],[92,920],
        [92,1160],[468,1160],[468,1400],[92,1400],[92,1640],[468,1640],[468,1880],[92,1880]],
  sub: false, tokenW: 46, tokenH: 58, fsBig: 21, fsSmall: 18,
};
/* ぜんぶ（36マス）のスマホ 12段。縦はもともとUターンの切り口をそろえていないので、
   みじかめと同じ作りのまま段を足している */
const LAY_TALL_FULL = {
  vb: [560, 2925], corner: 112, skyH: 108, artH: 235,
  pts: [[92,200],[468,200],[468,440],[92,440],[92,680],[468,680],[468,920],[92,920],
        [92,1160],[468,1160],[468,1400],[92,1400],[92,1640],[468,1640],[468,1880],[92,1880],
        [92,2120],[468,2120],[468,2360],[92,2360],[92,2600],[468,2600],[468,2840],[92,2840]],
  sub: false, tokenW: 46, tokenH: 58, fsBig: 21, fsSmall: 18,
};
/* いま描く盤面に合った折れ線を返す */
const layFor = wide => (M.SQUARES.length > 24 ? (wide ? LAY_WIDE_FULL : LAY_TALL_FULL)
                                              : (wide ? LAY_WIDE : LAY_TALL));
const HALFW = { choice: 66, start: 62, goal: 62 };
const halfW = t => HALFW[t] || 52;

let geo = null;   /* {lay, at(s), seg} — コマの位置計算でも使う */

/* 折れ線を、角だけ丸めた細かい点列に変える */
function densePath(lay) {
  const P = lay.pts, Rr = lay.corner, out = [];
  const unit = (a, b) => { const d = [b[0]-a[0], b[1]-a[1]]; const n = Math.hypot(d[0], d[1]); return [d[0]/n, d[1]/n, n]; };
  let cur = P[0].slice();
  for (let i = 1; i < P.length; i++) {
    const v = P[i], [ux, uy, len] = unit(cur, v), hasCorner = i < P.length - 1;
    const stop = hasCorner ? Math.max(0, len - Rr) : len;
    const n = Math.max(2, Math.round(stop / 6));
    for (let k = 0; k <= n; k++) out.push([cur[0] + ux*stop*k/n, cur[1] + uy*stop*k/n]);
    if (hasCorner) {
      const [wx, wy] = unit(v, P[i+1]);
      const s = [cur[0] + ux*stop, cur[1] + uy*stop], e = [v[0] + wx*Rr, v[1] + wy*Rr], m = 40;
      for (let k = 1; k <= m; k++) {
        const t = k/m, it = 1-t;
        out.push([it*it*s[0] + 2*it*t*v[0] + t*t*e[0], it*it*s[1] + 2*it*t*v[1] + t*t*e[1]]);
      }
      cur = e;
    }
  }
  return out;
}
function buildGeo(lay) {
  const D = densePath(lay), cum = [0];
  for (let i = 1; i < D.length; i++) cum.push(cum[i-1] + Math.hypot(D[i][0]-D[i-1][0], D[i][1]-D[i-1][1]));
  const total = cum[cum.length - 1];
  const at = s => {
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m; else hi = m; }
    const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    const p = [D[lo][0] + (D[hi][0]-D[lo][0])*t, D[lo][1] + (D[hi][1]-D[lo][1])*t];
    const a = D[Math.max(0, lo-2)], b = D[Math.min(D.length-1, hi+2)];
    const dx = b[0]-a[0], dy = b[1]-a[1], n = Math.hypot(dx, dy) || 1;
    return { p, n: [-dy/n, dx/n] };
  };
  return { lay, at, seg: total / M.SQUARES.length };
}

/* 背景：富士山・都心・地方の里山が地つづきに並ぶ、一枚の風景（1画面の国内版と同じ絵）。
   3つの風景はそれぞれ「地平線を y=0」とした座標で描き、
   同じ倍率で拡大して空の帯におさめる（縦だけ縮めるとつぶれて見えるため） */
const SCENES = [
  { cx: 0.15, w: 180, draw: a => {          /* 富士山・鳥居・桜 */
    a("path", { d: "M-169 0 L-83 -112 L3 0 Z", fill: "#BBD6E8" });
    a("path", { d: "M-113 -76 L-83 -112 L-53 -76 q-30 14 -60 0 z", fill: "#FFFFFF" });
    a("path", { d: "M17 0 v-56 M83 0 v-56", stroke: "#D95F45", "stroke-width": 10, "stroke-linecap": "round" });
    a("path", { d: "M3 -56 h94 M11 -40 h78", stroke: "#D95F45", "stroke-width": 10, "stroke-linecap": "round" });
    a("path", { d: "M145 -20 v22", stroke: "#B08968", "stroke-width": 7, "stroke-linecap": "round" });
    a("circle", { cx: 139, cy: -38, r: 30, fill: "#F8CBDA" });
    a("circle", { cx: 169, cy: -20, r: 21, fill: "#FBDCE6" });
    a("circle", { cx: 117, cy: -16, r: 17, fill: "#FBDCE6" });
  }},
  { cx: 0.5, w: 126, draw: a => {           /* 都心：ビルの街なみ */
    [[-126,-70],[-84,-46],[-40,-92],[4,-56],[48,-76],[92,-44]].forEach(([bx, by], i) => {
      a("rect", { x: bx, y: by, width: 34, height: -by, rx: 4, fill: i % 2 ? "#CBDAE9" : "#D9E5F0" });
      for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++)
        if (by + 12 + r * 20 < -10) a("rect", { x: bx + 7 + c * 14, y: by + 12 + r * 20, width: 8, height: 10, rx: 2, fill: "#EEF5FA" });
    });
  }},
  { cx: 0.85, w: 175, draw: a => {          /* 地方：里山・田んぼ・民家 */
    a("path", { d: "M-141 0 q120 -54 250 -14 q50 16 80 14 z", fill: "#DCEEC6" });
    a("path", { d: "M-13 0 v-48", stroke: "#A98363", "stroke-width": 9, "stroke-linecap": "round" });
    a("circle", { cx: -13, cy: -58, r: 30, fill: "#8CC28A" });
    a("circle", { cx: -40, cy: -44, r: 20, fill: "#A2D19E" });
    a("circle", { cx: 12, cy: -42, r: 18, fill: "#A2D19E" });
    a("path", { d: "M81 0 h60 v-24 h-60 z", fill: "#EFE2CE" });
    a("path", { d: "M73 -22 l38 -28 l38 28 z", fill: "#9FB3C4" });
    a("path", { d: "M-149 0 h44 v-18 h-44 z", fill: "#EFE2CE" });
    a("path", { d: "M-155 -16 l28 -22 l28 22 z", fill: "#9FB3C4" });
  }},
];
function drawScenery(svg, lay) {
  const [W, H] = lay.vb, artH = lay.artH, cloudH = lay.skyH;
  const defs = el("defs");
  /* 地平線(artH)のあたりで、空の色から地面の色へゆっくり変わるようにする */
  const grad = el("linearGradient", { id: "sky", x1: 0, y1: 0, x2: 0, y2: 1 });
  [["0%", "#DAEDFA"], [`${Math.round(artH / H * 62)}%`, "#E2F1F6"],
   [`${Math.round(artH / H * 108)}%`, "#EAF5EE"], ["100%", "#E3F2D8"]].forEach(([o, c]) =>
    grad.appendChild(el("stop", { offset: o, "stop-color": c })));
  defs.appendChild(grad); svg.appendChild(defs);
  svg.appendChild(el("rect", { width: W, height: H, fill: "url(#sky)" }));

  const g = el("g", {}), add = (t, a) => g.appendChild(el(t, a));
  /* 太陽と雲は、マスに隠れない上のほうに置く */
  add("circle", { cx: W * 0.93, cy: cloudH * 0.34, r: cloudH * 0.22, fill: "#FFE49A" });
  [0.1, 0.34, 0.6, 0.78].forEach(f => {
    const cx = W * f, cy = cloudH * 0.26, rx = cloudH * 0.34, ry = cloudH * 0.13;
    add("ellipse", { cx, cy, rx, ry, fill: "#fff", opacity: .9 });
    add("ellipse", { cx: cx - rx * 0.6, cy: cy + ry * 0.5, rx: rx * 0.62, ry: ry * 0.8, fill: "#fff", opacity: .9 });
  });
  /* 3つの風景。倍率は縦横おなじ＝形がつぶれない。
     マスの下にもぐりこむ大きさで描く（タイルはこのあとに重ねる） */
  const k = artH / 124;
  SCENES.forEach(sc => {
    const cx = Math.min(W - sc.w * k * 0.55, Math.max(sc.w * k * 0.55, W * sc.cx));
    const sg = el("g", { transform: `translate(${cx.toFixed(1)} ${artH}) scale(${k.toFixed(3)})`, opacity: .92 });
    sc.draw((t, a) => sg.appendChild(el(t, a)));
    g.appendChild(sg);
  });
  /* 道ぞいの木 */
  const tree = (tx, ty, sz) => {
    add("path", { d: `M${tx} ${ty} v${16*sz}`, stroke: "#A98363", "stroke-width": 4.5*sz, "stroke-linecap": "round" });
    add("circle", { cx: tx, cy: ty - 5*sz, r: 13*sz, fill: "#93C58F" });
    add("circle", { cx: tx - 9*sz, cy: ty + 2*sz, r: 10*sz, fill: "#7FB87F" });
    add("circle", { cx: tx + 9*sz, cy: ty + 1*sz, r: 9*sz, fill: "#7FB87F" });
  };
  const inset = lay.sub ? 46 : 28, n = lay.sub ? 4 : 8;
  for (let i = 0; i < n; i++) {
    const ty = artH + 30 + (H - artH - 70) * (i + .5) / n;
    tree(inset, ty, lay.sub ? 1 : .8);
    tree(W - inset, ty + 34, lay.sub ? .9 : .75);
  }
  svg.appendChild(g);
}

/* 高さ y のところで、その形の中にとれる「いちばん長い横の線」。無ければ null */
function widestSpan(poly, y) {
  const xs = [];
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + (x1 - x0) * (y - y0) / (y1 - y0));
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  let best = null;
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (!best || xs[k + 1] - xs[k] > best[1] - best[0]) best = [xs[k], xs[k + 1]];
  return best;
}
/* 横位置 x のところで、yRef をふくむ「ひとつづきの縦のひろがり」。無ければ null。
   Uターンのマスは同じ x で上の腕と下の腕をまたぐので、つながった区間だけを返す */
function vSpanAt(poly, x, yRef) {
  const ys = [];
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    if ((x0 <= x && x1 > x) || (x1 <= x && x0 > x)) ys.push(y0 + (y1 - y0) * (x - x0) / (x1 - x0));
  }
  if (ys.length < 2) return null;
  ys.sort((a, b) => a - b);
  for (let k = 0; k + 1 < ys.length; k += 2)
    if (yRef >= ys[k] - 1 && yRef <= ys[k + 1] + 1) return [ys[k], ys[k + 1]];
  return null;
}
/* マスの中で、文字のかたまりがいちばん広く入る場所をさがす。
   まっすぐなマスならまん中、Uターンのマスなら曲がりの外がわの太いところが選ばれる。
   offs は「かたまりの中心から見た、各行の位置」 */
function bestLabelSpot(poly, offs) {
  const ys = poly.map(q => q[1]);
  const top = Math.min(...ys), bot = Math.max(...ys), N = 30;
  const probes = [];
  offs.forEach(o => { probes.push(o - 12, o + 4); });
  const cand = [];
  for (let i = 0; i <= N; i++) {
    const ay = top + (bot - top) * i / N;
    let lo = -Infinity, hi = Infinity;
    for (const o of probes) {
      const sp = widestSpan(poly, ay + o);
      if (!sp) { lo = 0; hi = -1; break; }
      lo = Math.max(lo, sp[0]); hi = Math.min(hi, sp[1]);
    }
    if (hi - lo > 0) cand.push({ x: (lo + hi) / 2, y: ay, w: hi - lo });
  }
  if (!cand.length) return null;
  const max = Math.max(...cand.map(c => c.w));
  const tie = cand.filter(c => c.w >= max - 1);        /* 同じ広さなら、そのまん中に置く */
  return tie[Math.floor(tie.length / 2)];
}

/* 横位置 x のところで、その形が上下どこからどこまであるか。無ければ null */
function spanAtX(poly, x) {
  const ys = [];
  for (let k = 0; k < poly.length; k++) {
    const [x0, y0] = poly[k], [x1, y1] = poly[(k + 1) % poly.length];
    if ((x0 <= x && x1 > x) || (x1 <= x && x0 > x)) ys.push(y0 + (y1 - y0) * (x - x0) / (x1 - x0));
  }
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
}

/* マスのアイコン（盤面用・線で描く） */
/* アイコンの上下のひろがり（線の太さこみ）。種類ごとに高さがちがうので、
   文字のかたまりを上下まんなかに置くにはこれを見込む必要がある */
const ICON_Y = {
  income: [-12, 12], cost: [-15, 16], event: [-16, 18], heavy: [-16, 18], learn: [-10, 11],
  choice: [-21, 17], start: [-9, 9], goal: [-12, 16], talk: [-14, 15], fam: [-12, 12],
};

function tileIcon(type, cx, cy, c) {
  const g = el("g", { transform: `translate(${cx} ${cy})` });
  const a = (t, at) => g.appendChild(el(t, at));
  const S = { fill: "none", stroke: c, "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" };
  if (type === "income") {
    a("ellipse", { cx: 0, cy: 6, rx: 13, ry: 5, fill: "#F6C445", stroke: c, "stroke-width": 2.6 });
    a("ellipse", { cx: 0, cy: 0, rx: 13, ry: 5, fill: "#FFD86B", stroke: c, "stroke-width": 2.6 });
    a("ellipse", { cx: 0, cy: -6, rx: 13, ry: 5, fill: "#FFE49A", stroke: c, "stroke-width": 2.6 });
  } else if (type === "cost") {
    a("circle", { cx: -4, cy: -2, r: 11, fill: "#fff", stroke: c, "stroke-width": 2.8 });
    a("path", { ...S, d: "M-8 -6 L-4 -2 L0 -6 M-8 -1 h8 M-4 -2 v6", "stroke-width": 2.6 });
    a("path", { ...S, d: "M10 2 v10 M10 14 l-5 -5 M10 14 l5 -5", "stroke-width": 3.2 });
  } else if (type === "event" || type === "heavy") {
    a("path", { d: "M4 -14 L-9 3 h7 l-4 13 L11 -2 h-7 z", fill: type === "heavy" ? "#C9A98C" : "#B59BE8", stroke: c, "stroke-width": 2.6, "stroke-linejoin": "round" });
  } else if (type === "learn") {
    a("path", { d: "M-13 -8 h11 a2 2 0 0 1 2 2 v15 a2 2 0 0 0 -2 -2 h-11 z", fill: "#fff", stroke: c, "stroke-width": 2.8, "stroke-linejoin": "round" });
    a("path", { d: "M13 -8 h-11 a2 2 0 0 0 -2 2 v15 a2 2 0 0 1 2 -2 h11 z", fill: "#DCEEF9", stroke: c, "stroke-width": 2.8, "stroke-linejoin": "round" });
  } else if (type === "choice") {
    a("path", { d: "M-12 15 v-22 a12 12 0 0 1 24 0 v22 z", fill: "#fff", stroke: "#D4547A", "stroke-width": 3, "stroke-linejoin": "round" });
    a("circle", { cx: 6, cy: 5, r: 2.6, fill: "#D4547A" });
  } else if (type === "start") {
    a("path", { ...S, d: "M-12 0 h20 M2 -7 l8 7 l-8 7", stroke: "#fff", "stroke-width": 4 });
  } else if (type === "talk") {
    a("circle", { cx: -7, cy: -7, r: 5.2, fill: "#fff", stroke: c, "stroke-width": 2.6 });
    a("path", { d: "M-16 13 a9 9 0 0 1 18 0 z", fill: "#fff", stroke: c, "stroke-width": 2.6, "stroke-linejoin": "round" });
    a("circle", { cx: 9, cy: -4, r: 4.4, fill: "#BFE6D2", stroke: c, "stroke-width": 2.6 });
    a("path", { d: "M2 13 a7.5 7.5 0 0 1 15 0 z", fill: "#BFE6D2", stroke: c, "stroke-width": 2.6, "stroke-linejoin": "round" });
  } else if (type === "goal") {
    a("path", { ...S, d: "M-9 14 v-24", stroke: "#7A6320", "stroke-width": 3.4 });
    a("path", { d: "M-9 -10 h20 v12 h-20 z", fill: "#fff", stroke: "#7A6320", "stroke-width": 2.6 });
    a("path", { d: "M-9 -10 h10 v6 h-10 z M1 -4 h10 v6 h-10 z", fill: "#7A6320" });
  }
  return g;
}

function renderBoard() {
  const lay = layFor(!mqMobile.matches);
  /* PCは盤面を1画面におさめるので、横幅の上限を盤面の縦横比から決める（CSSのvar） */
  document.documentElement.style.setProperty("--board-aspect", String(lay.aspect || 2.06));
  geo = buildGeo(lay);
  const svg = $("board");
  svg.setAttribute("viewBox", `0 0 ${lay.vb[0]} ${lay.vb[1]}`);
  svg.innerHTML = "";
  drawScenery(svg, lay);

  const gTiles = el("g", {}), gLabels = el("g", {});
  svg.appendChild(gTiles); svg.appendChild(gLabels);
  const { at, seg } = geo;
  const band = [];                                      /* 各マスの上下端。章ラベルの位置決めに使う */

  M.SQUARES.forEach((sq, i) => {
    const m = R.TYPE_META[sq.t], hw = halfW(sq.t);
    /* STEPS：1マスの輪郭を何点で折るか。多いほど曲線がなめらかになる */
    const s0 = i * seg + 3.5, s1 = (i + 1) * seg - 3.5, STEPS = 22, left = [], right = [], mid = [];
    for (let k = 0; k <= STEPS; k++) {
      const { p, n } = at(s0 + (s1 - s0) * k / STEPS);
      left.push([p[0] + n[0]*hw, p[1] + n[1]*hw]);
      right.push([p[0] - n[0]*hw, p[1] - n[1]*hw]);
      mid.push(p);
    }
    const d = "M" + left.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ")
      + " L " + right.reverse().map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L ") + " Z";
    gTiles.appendChild(el("path", { d, id: `sq-${i}`, fill: m.fill, stroke: "#FFFFFF", "stroke-width": 9, "stroke-linejoin": "round" }));

    const poly = left.concat(right);
    const big = sq.t === "choice" || sq.t === "start" || sq.t === "goal";
    const tTxt = L(sq.name) || L(m.label);
    /* 年齢はトビラ・スタート・ゴールだけ。せまい画面では説明文は出さない */
    const ageTxt = ja() ? `${M.AGES[i]}歳` : `Age ${M.AGES[i]}`;
    let sTxt = big
      ? ageTxt + (L(sq.sub) ? "・" + L(sq.sub) : "")
      : (lay.sub ? (L(sq.sub) || "") : "");
    /* アイコン・見出し・説明の位置（かたまりの中心から見た相対位置）。
       アイコンの高さはマスの種類でちがうので、それを見込んで上下おなじ余白にそろえる */
    const iy = ICON_Y[sq.t] || [-12, 12];
    const oIcon = -(big ? 30 : 26), oTitle = (big ? 12 : 10), oSub = (big ? 32 : 28);
    const blockTop = oIcon + iy[0], blockBot = sTxt ? oSub + 3 : oTitle + 4;
    const dy = -(blockTop + blockBot) / 2;
    const offs = [oIcon + dy, oTitle + dy];
    if (sTxt) offs.push(oSub + dy);
    const spot = bestLabelSpot(poly, offs)
      || { x: mid[Math.floor(mid.length / 2)][0], y: mid[Math.floor(mid.length / 2)][1], w: 2 * hw };
    /* 上と下の余白をそろえる。いちばん広い場所は、曲がったマスだと上下どちらかに
       よることがあるので、その位置での「マスの縦のまん中」に置きなおす */
    const vSpan = vSpanAt(poly, spot.x, spot.y);
    if (vSpan) spot.y = (vSpan[0] + vSpan[1]) / 2;
    /* 1行ごとに、その高さで使える幅を測る。曲がったマスでも白いフチをまたがない。
       まとめて一番せまいところに合わせると、曲がりのマスだけ字が潰れてしまう */
    const roomAt = ys => {
      let room = Infinity;
      for (const y of ys) {
        const sp = widestSpan(poly, y);
        room = Math.min(room, sp ? 2 * Math.min(spot.x - sp[0], sp[1] - spot.x) : 0);
      }
      return Math.max(46, room - 24);
    };
    const fit = (txt, base, ys) => {
      const w = [...txt].reduce((s2, ch) => s2 + (ch.charCodeAt(0) > 0x2E80 ? 1 : 0.55), 0);
      return Math.min(base, roomAt(ys) / Math.max(1, w));
    };
    gLabels.appendChild(tileIcon(sq.t, spot.x, spot.y + offs[0], m.chip));
    const yT = spot.y + offs[1];
    const title = el("text", { x: spot.x, y: yT, "text-anchor": "middle",
      "font-size": Math.max(10, fit(tTxt, big ? lay.fsBig : lay.fsSmall, [yT, yT - 14])),
      "font-weight": 900, fill: m.ink });
    title.textContent = tTxt;
    gLabels.appendChild(title);
    if (sTxt) {
      const yS = spot.y + offs[2], probes = [yS, yS - 9];
      let fs = fit(sTxt, big ? (lay.sub ? 12 : 12.5) : 11, probes);
      /* 曲がりの上で幅が足りないときは、トビラは年齢だけ／ほかのマスは説明を出さない */
      if (fs < 9.8 && big && sTxt !== ageTxt) { sTxt = ageTxt; fs = fit(sTxt, 12, probes); }
      if (fs >= 9.8) {
        const sub = el("text", { x: spot.x, y: yS, "text-anchor": "middle",
          "font-size": fs, "font-weight": 700,
          fill: big ? m.ink : "#6E7E8C", opacity: big ? .92 : 1 });
        sub.textContent = sTxt;
        gLabels.appendChild(sub);
      }
    }
    band[i] = poly;      /* 章のラベルを置くときに、どこが空いているかを測るのに使う */
  });

  /* 章のラベルは、段と段のあいだの「ほんとうに空いているところ」のまん中に置く。
     角のタイルはとなりの段までふくらむので、盤面のまん中(cx)での空きだけを見る */
  const cx = lay.vb[0] / 2, perRow = lay.sub ? 6 : 3;
  const spans = band.map(poly => spanAtX(poly, cx));
  M.CHAPTERS.forEach((ch, r) => {
    const first = r * 6;
    const tops = spans.slice(first, first + perRow).filter(Boolean).map(v => v[0] - 4.5);
    const bots = spans.slice(0, first).filter(Boolean).map(v => v[1] + 4.5);
    const top = tops.length ? Math.min(...tops) : 40;
    const y = bots.length
      ? (Math.max(...bots) + top) / 2
      : Math.max(16, top - 30);                         /* 1章目だけは、段の上に同じだけ空けて置く */
    const t = L(ch.t);
    const w = Math.min(lay.vb[0] - 24, t.length * (lay.sub ? 14 : 15) + 24);
    gLabels.appendChild(el("rect", { x: cx - w/2, y: y - 13, width: w, height: 26, rx: 13,
      fill: "#fff", opacity: .95, stroke: "#DCE7EE", "stroke-width": 2 }));
    const e = el("text", { x: cx, y: y + 5, "font-size": lay.sub ? 13.5 : 14.5, "font-weight": 900,
      fill: "#3F5266", "text-anchor": "middle" });
    e.textContent = t;
    gLabels.appendChild(e);
  });

  svg.appendChild(el("g", { id: "tokLayer" }));
}
mqMobile.addEventListener("change", () => { renderBoard(); renderTokens(); });

/* コマの表情。数字の変化ではなく「いまの状態」をあらわす */
function emotionOf(p, isTurn) {
  if (p.left) return "angry";
  if (p.money < 0) return "sad";
  if (p.done) return "joy";
  return isTurn ? "fun" : "joy";
}
function renderTokens() {
  const layer = $("tokLayer");
  if (!layer || !G || !geo) return;
  layer.innerHTML = "";
  const { at, seg, lay } = geo;
  /* 同じマスに重なったときは、少しずつ横にずらす */
  const bucket = {};
  G.players.forEach(p => {
    const pos = shown[p.id] != null ? shown[p.id] : p.pos;
    (bucket[pos] = bucket[pos] || []).push(p);
  });
  Object.entries(bucket).forEach(([posStr, list]) => {
    const pos = +posStr;
    const sq = M.SQUARES[pos]; if (!sq) return;
    const { p: c, n } = at(pos * seg + seg / 2);
    const hw = halfW(sq.t);
    /* どの段でも「タイルの上ふち」に立つよう、法線の向きをそろえる */
    const sg = n[1] < 0 ? 1 : -1;
    const base = [c[0] + n[0]*sg*(hw - 6), c[1] + n[1]*sg*(hw - 6)];
    const W = lay.tokenW, H = lay.tokenH;
    list.forEach((p, k) => {
      const off = (k - (list.length - 1) / 2) * (W * 0.52);
      const foot = [base[0] + off, base[1] - Math.abs(off) * 0.12];
      const g = el("g", { id: `tok-${p.id}` });
      g.appendChild(el("ellipse", { cx: foot[0], cy: foot[1] - 1, rx: 15, ry: 5, fill: "rgba(63,82,102,.18)" }));
      const isTurn = G.players[G.turn] && G.players[G.turn].id === p.id && !p.done;
      if (p.id === MYPID) {
        g.appendChild(el("rect", { x: foot[0] - 31, y: foot[1] - H - 23, width: 62, height: 22, rx: 11, fill: "#F4879F" }));
        const t = el("text", { x: foot[0], y: foot[1] - H - 8, "text-anchor": "middle",
          "font-size": 12.5, "font-weight": 900, fill: "#fff" });
        t.textContent = ja() ? "あなた" : "YOU";
        g.appendChild(t);
      }
      /* キャラは SVG の <image> で描く。HTMLを埋めこむ foreignObject だと
         描き直しのタイミングが影や名前とそろわず、歩いている最中にずれて見える */
      const img = el("image", {
        href: `./chars/${charOf(p)}-${emotionOf(p, isTurn)}.png`,
        x: foot[0] - W/2, y: foot[1] - H, width: W, height: H,
        preserveAspectRatio: "xMidYMax meet",
        opacity: isTurn ? 1 : .82,
      });
      img.style.filter = "drop-shadow(0 1px 2px rgba(63,82,102,.3))";
      g.appendChild(img);
      layer.appendChild(g);
    });
  });
}
/* サーバーが決めた位置まで、1マスずつ歩かせる。
   表示が失敗しても進行を止めないよう、必ず終了して次のモーダルを出す */
function stepAnim() {
  if (animTimer || !G || diceBusy) return;
  const behind = () => G.players.some(p => (shown[p.id] == null ? p.pos : shown[p.id]) !== p.pos);
  if (!behind()) return;
  let guard = 0;
  animTimer = setInterval(() => {
    try {
      guard++;
      let moved = false;
      G.players.forEach(p => {
        if (shown[p.id] == null) shown[p.id] = p.pos;
        if (shown[p.id] < p.pos) { shown[p.id]++; moved = true; }
        else if (shown[p.id] > p.pos) shown[p.id] = p.pos;
      });
      if (moved) se("step");
      renderTokens();
      const cur = G.players[G.turn];
      if (cur && shown[cur.id] != null) focusSquare(shown[cur.id]);
    } catch (e) {
      console.log("anim error", e);
    } finally {
      if (!behind() || guard > 40) {
        clearInterval(animTimer); animTimer = null;
        renderPending();
      }
    }
  }, 200);
}
function focusSquare(pos) {
  const t = $(`sq-${pos}`);
  if (!t || !t.getBoundingClientRect) return;
  const r = t.getBoundingClientRect();
  if (r.height === 0) return;
  window.scrollTo({ top: Math.max(0, r.top + window.scrollY - (window.innerHeight - r.height) / 2), behavior: "smooth" });
}

/* ---------- プレイヤー一覧（画面上） ---------- */
/* 画面上のプレイヤーカードの中身。トビラの画面でも同じ見た目を使う */
function playerCardBody(p) {
  return `
      <div class="av" style="${faceBg(p)}; border-color:${p.color}"></div>
      <div style="min-width:0; flex:1">
        <div class="nm">${p.name}${p.id === MYPID ? `<span class="mine-badge">${ja() ? "あなた" : "you"}</span>` : ""}
          <span class="age">${fage(M.AGES[p.pos])}</span></div>
        <div class="row">
          <span class="m1">${ic("coin", "s")}${fm(p.money)}</span>
          <span class="m2">★${p.learn}</span>
          <span class="m3">♥${p.happy}</span>
        </div>
      </div>`;
}
function renderStrip() {
  const s = $("playersStrip");
  s.innerHTML = "";
  G.players.forEach((p, i) => {
    const c = document.createElement("div");
    c.className = "pcard" + (i === G.turn ? " now" : "") + (p.done ? " done" : "")
      + (p.connected ? "" : " off") + (p.left ? " left" : "");
    c.style.setProperty("--ring", p.color);
    c.innerHTML = playerCardBody(p);
    /* 押すと、その人の家庭カード（境遇）が開く。他人の番のモーダルの上にも重ねてよい */
    if (p.card) {
      c.classList.add("tap");
      c.setAttribute("role", "button");
      c.title = ja() ? `${p.name} さんの家庭カードを見る` : `See ${p.name}'s family card`;
      c.onclick = () => openOverPending(() => showOtherCard(p.id));
    }
    s.appendChild(c);
  });
}

/* ---------- 進行役パネル ----------
   ゲームのモーダルとは別のオーバーレイを使う（できごとの表示と取り合わない） */
function openHost(html) {
  $("hostBox").innerHTML = html;
  $("hostOverlay").classList.add("open");
  document.body.classList.add("host-open");
}
function closeHost() {
  $("hostOverlay").classList.remove("open");
  $("hostBox").innerHTML = "";
  document.body.classList.remove("host-open");
}
const hostOpen = () => $("hostOverlay").classList.contains("open");
/* パネルの外（うしろの暗いところ）をさわっても閉じる。
   ゲームのモーダルは選ぶまで閉じないので、こちらの #hostOverlay だけに付ける */
$("hostOverlay").onclick = e => { if (e.target === $("hostOverlay")) closeHost(); };
const iAmHost = () => !!G && MYPID === G.hostId;
const ask = t => window.confirm(L(t));

function renderHostPanel() {
  if (!G || !iAmHost()) { closeHost(); return; }
  const cur = G.phase === "play" ? G.players[G.turn] : null;
  const rows = G.players.map(p => {
    const tags = [];
    if (p.id === G.hostId) tags.push(ja() ? "進行役" : "host");
    if (cur && p.id === cur.id) tags.push(ja() ? "いまの手番" : "current turn");
    if (p.left) tags.push(ja() ? "退出" : "left");
    else if (p.done) tags.push(ja() ? "ゴール" : "finished");
    return `<div class="host-row${p.connected ? "" : " off"}">
      <span class="hn"><span class="p-dot" style="background:${p.color}"></span>${p.name}
        <span class="tag">${p.connected ? (ja() ? "接続中" : "online") : (ja() ? "切断中" : "offline")}</span></span>
      ${tags.map(t => `<span class="tag">${t}</span>`).join("")}
      ${p.id === MYPID || p.left ? "" : `<button class="host-act" data-pass="${p.id}">${ja() ? "ゆずる" : "make host"}</button>
      <button class="host-act danger" data-kick="${p.id}">${ja() ? "外す" : "Remove"}</button>`}
    </div>`;
  }).join("");

  const btns = [];
  if (G.phase === "cards") btns.push(`<button class="host-act" id="hForce">${ja()
    ? "まだの人を待たずに始める" : "Start without the ones still looking"}</button>`);
  if (G.phase === "play" && cur) btns.push(`<button class="host-act" id="hSkip">${ja()
    ? `${cur.name} さんの番をとばす` : `Skip ${cur.name}'s turn`}</button>`);
  btns.push(`<button class="host-act danger" id="hReset">${ja()
    ? "ロビーにもどす" : "Back to the lobby"}</button>`);
  btns.push(`<button class="host-act" id="hClose">${ja() ? "とじる" : "Close"}</button>`);

  openHost(`<div class="rule-page">
    <span class="m-tag" style="background:#5B7FA8">${ic("tools", "s")} ${ja() ? "進行役メニュー" : "Host tools"}</span>
    <h2>${ja() ? "進行がとまったとき" : "When the game gets stuck"}</h2>
    <div class="host-note">${ja()
      ? "端末が落ちた・席を外した・まちがえて入った——そんなときだけ使ってください。<br>ゲームの中身は変わりません。"
      : "Only for when a device dies, someone steps out, or joins by mistake.<br>None of this changes the game itself."}</div>
    <div class="host-list">${rows}</div>
    <div class="host-btns">${btns.join("")}</div>
  </div>`);

  $("hClose").onclick = closeHost;
  $("hostBox").querySelectorAll("[data-kick]").forEach(b => b.onclick = () => {
    const p = G.players.find(x => x.id === b.dataset.kick) || { name: "" };
    if (!ask(G.phase === "lobby"
      ? { ja: `${p.name} さんを名簿から外します。よろしいですか？`, en: `Remove ${p.name} from the room. Are you sure?` }
      : { ja: `${p.name} さんを、ここから先の進行から外します（けっか発表にも出ません）。よろしいですか？`,
          en: `${p.name} will be dropped from the rest of the game (and from the results). Are you sure?` })) return;
    send({ t: "kick", id: b.dataset.kick });
  });
  $("hostBox").querySelectorAll("[data-pass]").forEach(b => b.onclick = () => {
    const p = G.players.find(x => x.id === b.dataset.pass) || { name: "" };
    if (!ask({ ja: `進行役を ${p.name} さんにゆずります。よろしいですか？`, en: `Hand the host role to ${p.name}. Are you sure?` })) return;
    send({ t: "passHost", id: b.dataset.pass });
  });
  if ($("hForce")) $("hForce").onclick = () => {
    const left = G.players.filter(p => !p.seen).map(p => p.name).join(ja() ? "、" : ", ");
    if (!ask({ ja: `まだカードを見ていない人（${left}）を待たずに始めます。よろしいですか？`,
               en: `Start without those who haven't opened their card (${left}). Are you sure?` })) return;
    send({ t: "forceCards" }); closeHost();
  };
  if ($("hSkip")) $("hSkip").onclick = () => {
    if (!ask({ ja: `${cur.name} さんの番をとばして、次の人にすすみます。よろしいですか？`,
               en: `Skip ${cur.name}'s turn and move on. Are you sure?` })) return;
    send({ t: "skipTurn" }); closeHost();
  };
  $("hReset").onclick = () => {
    if (!ask({ ja: "いまのゲームをやめて、ロビーにもどります。とちゅうの結果は消えます。よろしいですか？",
               en: "End this game and return to the lobby. Progress will be lost. Are you sure?" })) return;
    send({ t: "reset" }); closeHost();
  };
}

/* 一覧に置くトビラの目じるし。奥のわくと手前の扉をかさねて、扉だけがひらくようにする */
const doorMark = () => `<span class="d-mark">
      <svg class="ic way" aria-hidden="true"><use href="#ic-doorway"/></svg>
      <svg class="ic leaf" aria-hidden="true"><use href="#ic-door-leaf"/></svg></span>`;

/* ---------- モーダル部品 ---------- */
const tagChip = (type, label) => {
  const m = R.TYPE_META[type] || R.TYPE_META.event;
  return `<span class="m-tag" style="background:${m.chip}">${ic(m.icon, "s")} ${label != null ? label : L(m.label)}</span>`;
};
/* ステータスがどう変わったかを、前後の数字で見せる */
function chgPanel(before, fx) {
  const rows = [
    ["money", ja() ? "おかね" : "Money", before.money, fx.money || 0, v => fm(v)],
    ["learn", ja() ? "まなび" : "Learn", before.learn, fx.learn || 0, v => "★" + v],
    ["happy", ja() ? "ハッピー" : "Happy", before.happy, fx.happy || 0, v => "♥" + v],
  ].filter(r => r[3] !== 0);
  if (!rows.length) return `<div class="fx-line"><span class="fx">${ja() ? "数字は変わらなかった" : "No change"}</span></div>`;
  const emo = (fx.happy || 0) > 0 ? "joy" : ((fx.money || 0) > 0 || (fx.learn || 0) > 0 ? "fun" : "sad");
  return `<div class="chg-body">
    <div class="chg-char" style="background-image:url(./chars/${before.char}-${emo}.png)"></div>
    <div class="chg-rows">${rows.map(([k, label, base, d, f]) => `
      <div class="chg-r ${k}"><span class="k">${label}</span>
        <span class="v"><s>${f(base)}</s>${f(base + d)}</span>
        <span class="d ${d > 0 ? "up" : "dn"}">${d > 0 ? "+" : ""}${k === "money" ? fm(d) : d}</span></div>`).join("")}
    </div></div>`;
}
function beforeOf(pid) {
  const p = G.players.find(x => x.id === pid) || { money: 0, learn: 0, happy: 0, color: R.PCOLORS[0] };
  return { money: p.money, learn: p.learn, happy: p.happy, char: charOf(p) };
}
/* おかね・まなびは文字で書かず、画面上のプレイヤーカードと同じ色のアイコンだけで示す */
const money = n => `<span class="m1">${ic("coin", "s")}${fm(n)}</span>`;
const learn = n => `<span class="m2">${ic("star", "s")}${n}</span>`;
function reqLabel(p, o) {
  const parts = [];
  const em = R.effectiveMoneyReq(p, o);
  if (o.req.money) parts.push(money(em) + (em < o.req.money ? "（制度サポートで−50万）" : ""));
  if (o.req.learn) parts.push(learn(o.req.learn));
  if (o.req.maxMoney != null) parts.push(ja() ? `所得制限 ${money(o.req.maxMoney)}未満` : `Income limit: under ${money(o.req.maxMoney)}`);
  return parts.join(" ＋ ");
}
const waitingNote = who => `<div class="waiting-note">${ic("clock", "s")} ${ja() ? `${who} さんが かくにん中…` : `Waiting for ${who}…`}</div>`;
/* 見ているだけのときは、自分の番とはっきり見た目を変える */
const watchHead = a => `<div class="watch-head"><span class="av" style="${faceBg(a)}"></span>${
  ja() ? `${a.name} さんの番を見ています` : `Watching ${a.name}'s turn`}</div>`;
const privNote = v => (v && (!Array.isArray(v) || v.length))
  ? `<div class="m-note priv">${(Array.isArray(v) ? v.map(L).join("<br>") : L(v))}</div>` : "";

/* 出てきた画面にあわせて鳴らす音を選ぶ。数字が増えるか減るかで、うれしい／つらいを分ける。
   死別・干ばつなどの重いできごとも選択肢として出るので、そこは控えめなノックの音のまま */
function pendingSe(pd, mine) {
  if (pd.kind === "goal") return "goal";
  if (pd.kind === "choice") return mine ? "door" : "pop";
  const fx = pd.fx || {};
  if ((fx.money || 0) < 0 || (fx.happy || 0) < 0) return "bad";
  if ((fx.money || 0) > 0 || (fx.learn || 0) > 0 || (fx.happy || 0) > 0) return "good";
  return pd.type === "heavy" ? "bad" : "pop";
}

/* 他人がえらんでいるあいだ、画面の下に出す帯。モーダルとちがい操作をふさがない */
function showWatchBar(info) {
  const bar = $("watchBar");
  if (!bar) return;
  if (!info) { bar.classList.remove("on"); bar.innerHTML = ""; return; }
  const { who, door } = info;
  bar.innerHTML = `<span class="av" style="${faceBg(who)}"></span>
    <span class="wb-txt"><b>${who.name}</b>${ja() ? " さんが えらんでいます…" : " is choosing…"}
      <small>${ic(door && door.heavy ? "bolt" : "door", "s")} ${L((door && door.title) || {ja:"トビラの前",en:"at a door"})}</small></span>
    <span class="wb-hint">${ja() ? "そのあいだ、じぶんのカードや盤面を見られます" : "Meanwhile you can check your card and the board"}</span>`;
  bar.classList.add("on");
}

/* ---------- 保留中のできごと（サーバーから来る） ---------- */
function renderPending() {
  const pd = G.pending;
  /* 自分で開いたものは、状態が届いても消さない（閉じたときに render() から描き直される） */
  if (userModal) return;
  if (!pd) { showWatchBar(null); if (isOpen() && lastKey) closeModal(); return; }
  if (animTimer || diceBusy) return;            /* サイコロが止まり、コマが動き終わってから出す */
  /* 他人がトビラの前でえらんでいるあいだは、全画面でふさがない。
     盤面と自分のカード・あそびかたに手が届くようにして、待ち時間を手持ちぶさたにしない */
  if (pd.kind === "choice" && pd.for !== MYPID) {
    const who = G.players.find(p => p.id === pd.for) || { name: "?", color: R.PCOLORS[0] };
    if (isOpen() && lastKey) closeModal();
    showWatchBar({ who, door: pd.def });
    lastKey = JSON.stringify(pd);
    return;
  }
  showWatchBar(null);
  const key = JSON.stringify(pd);
  if (key === lastKey && isOpen()) return;
  lastKey = key;
  const mine = pd.for === MYPID;
  const actor = G.players.find(p => p.id === pd.for) || { name: "?", color: R.PCOLORS[0] };
  const type = pd.type === "heavy" ? "heavy" : (["learn", "event", "income", "cost"].includes(pd.type) ? pd.type : "choice");
  se(pendingSe(pd, mine));

  if (pd.kind === "info") {
    /* 「みんなで話す」マスだけは観戦ではなく、全員が同じ画面を見て話す時間 */
    const talk = pd.type === "talk";
    openModal(`<div class="m-head">${mine || talk ? "" : watchHead(actor)}
        ${tagChip(pd.type === "heavy" ? "heavy" : (R.TYPE_META[pd.type] ? pd.type : "event"))}
        <h2>${L(pd.title)}</h2>
        ${talk ? `<p class="m-sub">${ja() ? `${actor.name} さんが このマスに止まりました` : `${actor.name} landed here`}</p>` : ""}</div>
      <div class="m-body">
        <p class="m-lead">${L(pd.body)}</p>
        ${pd.note ? `<div class="m-note${talk ? " talk" : ""}">${L(pd.note)}</div>` : ""}
        ${privNote(pd.pnote)}
        ${talk ? "" : chgPanel(beforeOf(pd.for), pd.fx || {})}
        ${mine ? `<button class="m-btn" id="mOk">${talk ? (ja() ? "話せた！ すすむ" : "We talked — continue") : "OK"}</button>`
          : (talk ? `<div class="waiting-note">${ic("people", "s")} ${ja() ? "みんなで話してから、すすみます" : "Talk together, then continue"}</div>` : waitingNote(actor.name))}
        ${talk && YOU ? `<button class="m-btn ghost" id="mTalkCard">${ic("card", "s")} ${ja()
          ? "じぶんのカードとステータスを見る" : "See my card and status"}</button>` : ""}
      </div>`, !mine && !talk);
    if (mine) $("mOk").onclick = () => { send({ t: "ok" }); };
    /* 話し合いの最中に、自分の手もとをいつでも確認できるようにする。
       閉じたら話し合いの画面にもどす */
    if ($("mTalkCard")) $("mTalkCard").onclick = () => { lastKey = ""; showCard(true, () => { lastKey = ""; renderPending(); }); };
  }
  else if (pd.kind === "result") {
    openModal(`<div class="m-head">${mine ? "" : watchHead(actor)}
        ${tagChip(type, mine ? (ja() ? "えらんだ！" : "Chosen!") : (ja() ? `${actor.name} さんが えらんだ` : `${actor.name} chose`))}
        <h2>${L(pd.title)}</h2></div>
      <div class="m-body">
        <p class="m-lead">${L(pd.body)}${ja() ? "。" : "."}</p>
        ${pd.notes && pd.notes.length ? `<div class="m-note">${pd.notes.map(L).join("<br>")}</div>` : ""}
        ${privNote(pd.pnotes)}
        ${chgPanel(beforeOf(pd.for), pd.fx || {})}
        ${mine ? `<button class="m-btn" id="mOk">OK</button>` : waitingNote(actor.name)}
      </div>`, !mine);
    if (mine) $("mOk").onclick = () => { send({ t: "ok" }); };
  }
  else if (pd.kind === "choice") {
    /* 開くかどうか・いくらかかるかは、押すまで伏せておく。
       「どれを選びたいか」を先に考えてもらうため。押すと中身が開いて、最終確認になる */
    const p = pd.actor;
    const openN = (pd.states || []).filter(x => x === "open").length;
    /* 死別・干ばつなどのライフイベントは「トビラ」として数えないので、ラベルも出さない */
    const isDoor = pd.type !== "heavy";
    const stuck = openN === 0;
    const order = R.shuffle(pd.opts.map((_, i) => i));
    /* 死別・干ばつなどのライフイベントは「トビラ」ではない（結果発表の「出会ったトビラ」にも数えない）。
       一覧で扉の目じるしを出さないのと同じ線引きで、押したあとの確認画面もトビラの言い方をしない */
    const W = isDoor ? {
      ask: ja() ? "このトビラを開けますか？" : "Open this door?",
      yes: ja() ? "はい、このトビラを開ける" : "Yes, open it",
      backAgain: ja() ? "やっぱり、ほかのトビラを見る" : "Back to the other doors",
      back: ja() ? "ほかのトビラを見る" : "Back to the other doors",
      ng: ja() ? "……このトビラは開かなかった。" : " — this door didn't open.",
      pass: ja() ? "どれも開かない。今回は見送る" : "None will open — pass this time",
    } : {
      ask: ja() ? "これをえらびますか？" : "Choose this?",
      yes: ja() ? "はい、これにする" : "Yes, choose this",
      backAgain: ja() ? "やっぱり、ほかの選択肢を見る" : "Back to the other options",
      back: ja() ? "ほかの選択肢を見る" : "Back to the other options",
      ng: ja() ? "……これは選べなかった。" : " — you can't choose this.",
      pass: ja() ? "どれも選べない。今回は見送る" : "None can be chosen — pass this time",
    };
    const head = `<div class="m-head">
        ${tagChip(pd.def.heavy ? "heavy" : "choice")}
        <h2>${L(pd.def.title)}</h2>
      </div>`;
    const me = G.players.find(x => x.id === pd.for);

    /* --- 一覧：どれも同じ見た目。中身はホバー（スマホでは常時）で読める --- */
    /* まず「どんなトビラの前にいるか」を読んでから、自分の手もと（ステータス）を見てもらう */
    const listHtml = () => `<div class="m-body">
        <p class="m-lead">${L(pd.def.body)}</p>
        ${me ? `<div class="pcard now m-pcard" style="--ring:${me.color}">${playerCardBody(me)}</div>` : ""}
        <div class="door-list">${order.map(i => {
          const o = pd.opts[i];
          if (pd.states[i] === "unseen") return `<button class="door unseen" disabled>
              ${isDoor ? `<span class="d-mark unseen">${ic("eye")}</span>` : ""}
              <span class="d-main"><span class="d-title">？？？</span>
                <span class="d-desc">${ja() ? "この選択肢は、見えない。" : "You can't see this option."}</span></span></button>`;
          /* 中身（どう伸びるか・なにを失うか）は押したあとの確認画面で見せる。
             ここでは名前だけを見て、開けにいくかどうかを決める。
             「押せる」ことは文字で説明せず、目じるしのトビラがひらいて答える */
          return `<button class="door pick" data-i="${i}" data-se="off" ${mine ? "" : "disabled"}>
              ${isDoor ? doorMark() : ""}
              <span class="d-main"><span class="d-title">${L(o.t)}</span></span></button>`;
        }).join("")}</div>
        ${mine ? "" : waitingNote(actor.name)}
      </div>`;

    /* --- 押したあと：カギと金額を開いて、最後にもう一度たずねる --- */
    const confirmHtml = i => {
      const o = pd.opts[i], ok = pd.states[i] === "open";
      const key2 = reqLabel(p, o);
      const em = R.effectiveMoneyReq(p, o), raw = o.fx.money || 0, efx = R.effectiveMoneyFx(p, o);
      const cut = efx !== raw, redundant = o.req.money && efx === -em;
      const loan = o.special === "shogakukin" && !(p.seidoDiscount || p.perk === "seidoPro");
      const cost = ((efx || cut) && !redundant)
        ? `<div class="d-cost ${efx < 0 ? "minus" : "plus"}">${ic("coin", "s")} ${ja() ? "おかね" : "Money"} ${cut ? `<s>${fm(raw)}</s>→` : ""}${efx > 0 ? "+" : ""}${fm(efx)}${loan ? (ja() ? "＋これから返済" : " + repayment from now on") : ""}</div>` : "";
      /* 何が足りないのかを取りちがえないように、理由ごとに書きわける */
      const short = (o.req.maxMoney != null && p.money >= o.req.maxMoney)
        ? "所得制限で、いまのあなたは対象外だった" : "カギが足りない";
      return `<div class="m-body">
        <div class="c-card ${ok ? "ok" : "ng"}">
          ${isDoor ? `<span class="d-badge ${ok ? "open" : "lock"}">${ic(ok ? "door" : "lock", "s")}${ok
            ? (ja() ? "開けられるトビラ" : "A door you can open")
            : (ja() ? "カギが足りないトビラ" : "A door you can't open")}</span>` : ""}
          <div class="c-title">${L(o.t)}</div>
          <div class="d-desc">${L(o.d)}</div>
          ${o.cons ? `<div class="d-cons">${L(o.cons)}</div>` : ""}
          ${key2 ? `<div class="c-key">${ja() ? "カギ：" : "Key: "}${key2}
            <span class="c-now">${ja() ? "いまのあなた：" : "You have: "}${money(p.money)}${ja() ? "／" : " / "}${learn(p.learn)}</span></div>` : ""}
          ${cost}
        </div>
        ${ok
          ? `<p class="c-ask">${W.ask}</p>
             <button class="m-btn" id="mYes" data-se="${isDoor ? "open" : "tap"}">${W.yes}</button>
             <button class="m-btn ghost" id="mBack">${W.backAgain}</button>`
          : `<p class="c-ask ng">${ic("lock", "s")} ${short}${W.ng}</p>
             <button class="m-btn" id="mBack">${W.back}</button>
             ${stuck ? `<button class="m-btn ghost" id="mPass">${W.pass}</button>` : ""}`}
      </div>`;
    };

    const bind = () => {
      if (!mine) return;
      document.querySelectorAll("#modalBox .door.pick:not(:disabled)").forEach(b => {
        b.onclick = () => {
          se(pd.states[+b.dataset.i] === "open" ? "unlock" : "locked");
          paint(confirmHtml(+b.dataset.i), +b.dataset.i);
        };
      });
      if ($("mBack")) $("mBack").onclick = () => paint(listHtml());
      if ($("mPass")) $("mPass").onclick = () => send({ t: "choose", i: -1, pass: true });
    };
    const paint = (body, pickI) => {
      $("modalBox").innerHTML = head + body;
      $("modalBox").scrollTop = 0;
      bind();
      if (mine && pickI != null && $("mYes")) $("mYes").onclick = () => send({ t: "choose", i: pickI });
    };
    openModal(head + listHtml());
    bind();
  }
  else if (pd.kind === "goal") {
    /* 45歳のゴールで、のこった奨学金をここで清算する（1画面版と同じ） */
    const loanNote = pd.loan > 0
      ? `<div class="m-note">${ic("cap", "s")} のこっていた奨学金 <b>${fm(pd.loan)}</b> をここで清算。<br>${lastAge()}歳——ようやく、返しおえた。</div>` : "";
    openModal(`<div class="m-head">${mine ? "" : watchHead(actor)}
        ${tagChip("goal")}
        <h2>${ja() ? `${actor.name} さん、${lastAge()}歳でゴール！` : `${actor.name} reached the goal at ${lastAge()}!`}</h2></div>
      <div class="m-body">
        <p class="m-lead">${ja() ? `${firstAge()}歳からの${years()}年間、おつかれさま！ ${pd.rankAt}番目のゴールです。` : `${years()} years from age ${firstAge()} — well done! Finished #${pd.rankAt}.`}</p>
        ${loanNote}${chgPanel(beforeOf(pd.for), pd.fx || {})}
        ${mine ? `<button class="m-btn" id="mOk">OK</button>` : waitingNote(actor.name)}
      </div>`, !mine);
    if (mine) $("mOk").onclick = () => send({ t: "ok" });
  }
}

/* これまでに自分がえらんだ選択肢。
   えらばなかった選択肢——とくに「？？？」の中身——はここにも出さない。
   それがわかるのは、全員がゴールしたあとのネタバラシだけ。 */
function myChoiceList() {
  const list = (YOU && YOU.myChoices) || [];
  if (!list.length) return "";
  const rows = list.map(c => {
    const fx = [];
    if (c.fx.money) fx.push(`<span class="m1">${c.fx.money > 0 ? "+" : ""}${fm(c.fx.money)}</span>`);
    if (c.fx.learn) fx.push(`<span class="m2">★+${c.fx.learn}</span>`);
    if (c.fx.happy) fx.push(`<span class="m3">♥+${c.fx.happy}</span>`);
    return `<div class="mc-row">
      <span class="mc-age">${fage(c.age)}</span>
      <span class="mc-main"><span class="mc-door">${L(c.door)}</span>
        <span class="mc-t">${L(c.t)}</span>
        ${fx.length ? `<span class="mc-fx">${fx.join("")}</span>` : ""}</span></div>`;
  }).join("");
  return `<div class="fam-mine">
    <div class="k">${ic("check", "s")} ${ja() ? `あなたがえらんできたこと（${list.length}件）` : `What you have chosen so far (${list.length})`}</div>
    <div class="mc-list">${rows}</div>
    <div class="mc-note">${ja()
      ? "えらばなかった選択肢は、ここには出ません。ぜんぶ見られるのは、全員がゴールしたあとです。"
      : "The options you didn't take aren't shown here — you'll see them all once everyone finishes."}</div>
  </div>`;
}

/* 家庭カードの境遇の行：まちと仕送り（1画面版と同じ並び）。allow はいまの仕送り */
const famLines = (region, allow) => `
        <div class="fam-line">${ic("home", "s")}<span>まち：<b>${L(region)}</b></span></div>
        <div class="fam-line">${ic("coin", "s")}<span>仕送り：<b>${allow > 0 ? "毎回のお給料 +" + allow + "万" : "なし"}</b></span></div>`;

/* ---------- ほかの人の家庭カード ----------
   境遇（物語・まち・仕送り）は全員に見せる。とくいはサーバーから届かないので出せない */
function showOtherCard(pid) {
  const p = G.players.find(x => x.id === pid);
  if (!p || !p.card) return;
  if (pid === MYPID) return showCard(true, () => render());
  userModal = true;
  se("card");
  lastKey = "card:" + pid;
  const c = p.card;
  const done = () => { closeModal(); render(); };
  openModal(`
    <div class="fam-top" style="--fam:${p.color}">
      <div class="av" style="${faceBg(p)}"></div>
      <div style="min-width:0">
        <span class="pill">${ic("home", "s")} ${ja() ? `${p.name} さんの家庭カード` : `${p.name}'s Family Card`}</span>
        <div class="nm">${L(c.name)}</div>
      </div>
    </div>
    <div class="m-body">
      <div class="fam-story">${L(c.story)}
${famLines(c.region, c.allow)}
      </div>
      <div class="now-stats">
        <div class="ns money"><div class="k">${ic("coin", "s")}${ja() ? "おかね" : "Money"}</div><div class="v">${fm(p.money)}</div></div>
        <div class="ns learn"><div class="k">${ic("star", "s")}${ja() ? "まなび" : "Learn"}</div><div class="v">★${p.learn}</div></div>
        <div class="ns happy"><div class="k">${ic("heart", "s")}${ja() ? "ハッピー" : "Happy"}</div><div class="v">♥${p.happy}</div></div>
      </div>
      <div class="fam-secret">${ic("lock", "s")} ${ja()
        ? "「とくい」は、結果発表までその人にだけ見えています。"
        : "Each player's Strength stays theirs until the results."}</div>
      <button class="m-btn" id="mCard">${ja() ? "とじる" : "Close"}</button>
    </div>`, false, done);
  $("mCard").onclick = done;
}

/* 「とくい」は「名前：どこに・どう効くか」の形で書いてある。名前を太字、効きかたを下に小さく出す */
function perkHtml(fam) {
  const t = L(fam.perkText);
  const i = t.indexOf(ja() ? "：" : ": ");
  if (i < 0) return t;
  const how = t.slice(i + (ja() ? 1 : 2));
  return `${t.slice(0, i)}<small>${ja() ? how : how.charAt(0).toUpperCase() + how.slice(1)}</small>`;
}

/* ---------- 家庭カード（自分のぶん） ---------- */
function showCard(review, onClose) {
  userModal = true;   /* 自分で開いたものなので、状態が届いても閉じない */
  if (!YOU) return;
  se("card");
  const p = YOU;
  const me = G.players.find(x => x.id === MYPID) || { money: p.fam.money, name: "", pos: 0, color: R.PCOLORS[0] };
  lastKey = "card";
  const done = () => {
    closeModal();
    if (!review) send({ t: "seen" });
    else if (onClose) onClose();
  };
  openModal(`
    <div class="fam-top" style="--fam:${me.color}">
      <div class="av" style="${faceBg(me)}"></div>
      <div style="min-width:0">
        <span class="pill">${ic("home", "s")} ${L(R.TYPE_META.fam.label)}</span>
        <div class="nm">${L(p.fam.name)}</div>
      </div>
    </div>
    <div class="m-body">
      <div class="fam-story">${L(p.fam.story)}
${famLines(p.fam.region, p.allow)}
      </div>
      <div class="now-stats">
        <div class="ns money"><div class="k">${ic("coin", "s")}${ja() ? "おかね" : "Money"}</div><div class="v">${fm(me.money)}</div></div>
        <div class="ns learn"><div class="k">${ic("star", "s")}${ja() ? "まなび" : "Learn"}</div><div class="v">★${me.learn}</div></div>
        <div class="ns happy"><div class="k">${ic("heart", "s")}${ja() ? "ハッピー" : "Happy"}</div><div class="v">♥${me.happy}</div></div>
      </div>
      ${(p.open + p.locked + p.unseen) > 0 ? `<div class="now-doors">
        <div class="k">${ic("door", "s")}${ja() ? "ここまでに出会ったトビラ" : "Doors met so far"}</div>
        <div class="dl"><span class="lo">${ja() ? "開けられた" : "opened"} <b>${p.open}</b></span>
          <span class="ll">${ja() ? "カギが足りなかった" : "short of keys"} <b>${p.locked}</b></span>
          <span class="lu">${ja() ? "見えなかった" : "couldn't see"} <b>${p.unseen}</b></span></div>
      </div>` : ""}
      <div class="fam-perk">
        <div class="k">${ic("spark", "s")} ${ja() ? "あなたのとくい" : "Your strength"}
          <span class="only-you">${ic("lock", "s")} ${ja() ? "あなたにだけ" : "only you"}</span></div>
        <div class="v">${perkHtml(p.fam)}</div>
      </div>
      ${myChoiceList()}
      <div class="fam-secret">${ic("people", "s")} ${ja()
        ? "家庭カードは、みんなにも見えています（「とくい」だけは結果発表まであなたにだけ）。"
        : "Everyone can see family cards (only your Strength stays yours until the results)."}</div>
      <button class="m-btn" id="mCard">${review ? (ja() ? "とじる" : "Close") : (ja() ? "OK、覚えた" : "Got it")}</button>
    </div>`, false, done);
  $("mCard").onclick = done;
}

/* 盤面の長さのえらびかた。進行役だけがボタンで切りかえられ、ほかの人には結果だけ出る。
   人数の上限はモードで変わるので、短いほうへ切りかえると入りきらない人は名簿から外れる。 */
function renderModePick(host) {
  const keys = Object.keys(R.MODES);
  /* 国内版の盤面は1つだけなので、えらぶ欄そのものを出さない */
  if ($("modeWrap")) $("modeWrap").style.display = keys.length > 1 ? "" : "none";
  $("modeLabel").textContent = ja() ? "どこまで遊ぶ？" : "How far do you play?";
  $("modeBtns").innerHTML = keys.map(k => {
    const m = R.MODES[k], on = k === (G.mode || "full");
    return host
      ? `<button class="chip-btn${on ? " on" : ""}" data-mode="${k}">${L(m.label)}</button>`
      : (on ? `<button class="chip-btn on" disabled>${L(m.label)}</button>` : "");
  }).join("");
  if (host) $("modeBtns").querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
    const k = b.dataset.mode, m = R.MODES[k];
    if (k === (G.mode || "full")) return;
    /* 短いほうに切りかえると、上限をこえて入っている人が名簿から外れる。先に断る */
    if (G.players.length > m.maxPlayers && !ask({
      ja: `${L(m.label)} は${m.maxPlayers}人までです。あとから入った${G.players.length - m.maxPlayers}人は名簿から外れます。よろしいですか？`,
      en: `${L(m.label)} takes up to ${m.maxPlayers}. The last ${G.players.length - m.maxPlayers} will be removed. Continue?`,
    })) return;
    send({ t: "setmode", mode: k });
  });
  const m = R.MODES[G.mode || "full"];
  $("modeNote").textContent = ja()
    ? `${m.SQUARES.length}マス・${m.AGES[m.AGES.length - 1]}歳まで・${m.minStart}〜${m.maxPlayers}人`
    : `${m.SQUARES.length} squares · up to age ${m.AGES[m.AGES.length - 1]} · ${m.minStart}–${m.maxPlayers} players`;
}

/* ---------- 描画のふりわけ ---------- */
function render() {
  if (!G) return;
  if (G.phase !== "result") resultSe = false;
  /* あいことばは、ゲーム中もずっと出しておく（途中で入りなおす人に伝えられるように） */
  if ($("roomChip")) {
    $("roomChip").textContent = ROOM || "";
    $("roomChip").style.display = ROOM ? "" : "none";
    $("roomChip").title = ja() ? "あいことば（押すとコピー）" : "Room code (tap to copy)";
  }
  if (G.phase === "lobby") {
    showScreen("wait");
    $("roomCode").textContent = ROOM || "------";
    const host = MYPID === G.hostId;
    $("heavyWrap").style.display = host ? "" : "none";
    $("startBtn").style.display = host ? "" : "none";
    renderModePick(host);
    const min = M.minStart, max = M.maxPlayers;
    $("waitNote").textContent = host
      ? (G.players.length < min
          ? (ja() ? `あと${min - G.players.length}人ではじめられます（${min}〜${max}人）`
                  : `${min - G.players.length} more to start (${min}–${max} players)`)
          : (ja() ? "全員そろったら開始してください" : "Start when everyone is in"))
      : (ja() ? "進行役が開始するのを待っています…" : "Waiting for the host to start…");
    $("waitList").innerHTML = G.players.map(p =>
      `<div class="p-row wait-row"><span class="p-dot" style="background:${p.color}"></span>
       <span style="flex:1; font-weight:700">${p.name}${p.id === MYPID ? `<span class="mine-badge">${ja() ? "あなた" : "you"}</span>` : ""}${p.id === G.hostId ? (ja() ? "・進行役" : " · host") : ""}</span>
       <span class="st">${p.connected ? (ja() ? "接続中" : "online") : (ja() ? "切断中" : "offline")}</span>
       ${host && p.id !== MYPID ? `<button class="rm" data-kick="${p.id}" aria-label="remove">✕</button>` : ""}</div>`).join("");
    $("waitList").querySelectorAll("[data-kick]").forEach(b => b.onclick = () => {
      const p = G.players.find(x => x.id === b.dataset.kick) || { name: "" };
      if (!ask({ ja: `${p.name} さんを名簿から外します。よろしいですか？`, en: `Remove ${p.name} from the room. Are you sure?` })) return;
      send({ t: "kick", id: b.dataset.kick });
    });
    /* 進行役の端末が落ちて戻ってこないとき、残った人が引きつげる */
    const hostP = G.players.find(p => p.id === G.hostId);
    $("claimWrap").style.display = (!host && hostP && !hostP.connected) ? "" : "none";
    $("claimBtn").textContent = ja() ? `進行役を引きつぐ（${hostP ? hostP.name : ""} さんが切断中）` : `Take over as host (${hostP ? hostP.name : ""} is offline)`;
    closeModal(); closeHost();
  }
  else if (G.phase === "cards") {
    showScreen("game");
    hostTools();
    renderBoard(); renderStrip(); shown = {}; renderTokens();
    $("turnPill").style.removeProperty("--ring");
    $("turnPill").innerHTML = `<span class="tp-txt">${ja() ? "家庭カードをかくにん中" : "Checking family cards"}</span>`;
    $("diceBtn").disabled = true;
    $("diceLabel").textContent = ja() ? "まっています" : "Waiting";
    $("diceFace").style.display = "none";
    if (YOU && !YOU.seen) { if (lastKey !== "card") showCard(false); }
    else {
      const yet = G.players.filter(p => !p.seen);
      const names = yet.map(p => p.name + (p.connected ? "" : ja() ? "（切断中）" : " (offline)")).join(ja() ? "、" : ", ");
      lastKey = "waitcards";
      openModal(`<div class="m-head">${tagChip("fam")}
          <h2>${ja() ? "みんながカードを見ています" : "Everyone is checking their card"}</h2></div>
        <div class="m-body">
          <p class="m-lead">${ja() ? `まだの人：<b>${names}</b>` : `Still looking: <b>${names}</b>`}</p>
          <button class="m-btn ghost" id="mAgainCard">${ja() ? "自分のカードをもう一度見る" : "See my card again"}</button>
          ${iAmHost() ? `<button class="m-btn" id="mForce">${ja()
            ? "待たずに始める（進行役）" : "Start without them (host)"}</button>` : ""}
        </div>`);
      $("mAgainCard").onclick = () => showCard(true);
      if ($("mForce")) $("mForce").onclick = () => {
        if (!ask({ ja: `まだカードを見ていない人（${names}）を待たずに始めます。よろしいですか？`,
                   en: `Start without those who haven't opened their card (${names}). Are you sure?` })) return;
        send({ t: "forceCards" });
      };
    }
  }
  else if (G.phase === "play") {
    showScreen("game");
    hostTools();
    if (!$("board").children.length) renderBoard();
    renderStrip();
    G.players.forEach(p => { if (shown[p.id] == null) shown[p.id] = p.pos; });
    renderTokens();
    stepAnim();
    const cur = G.players[G.turn];
    const mine = cur && cur.id === MYPID;
    $("turnPill").style.setProperty("--ring", cur.color);
    $("turnPill").innerHTML = `<span class="av" style="${faceBg(cur)}"></span>`
      + `<span class="tp-txt">${ja() ? `${cur.name} さんの番・${M.AGES[cur.pos]}歳` : `${cur.name}'s turn · Age ${M.AGES[cur.pos]}`}</span>`
      + (cur.connected ? "" : `<span class="tp-off">${ja() ? "切断中" : "offline"}</span>`);
    const child = cur.pos < 4;
    $("diceFace").style.display = child ? "none" : "grid";
    if (G.dice && diceBusy) landBigDice(G.dice);
    if (!spinTimer) diceFace(G.dice || 1);
    $("diceBtn").disabled = !(mine && !G.pending);
    $("diceLabel").textContent = mine
      ? (child ? (ja() ? "一歩すすむ" : "Step forward") : (ja() ? "サイコロを回す" : "Roll the dice"))
      : (ja() ? `${cur.name} さんの番` : `${cur.name}'s turn`);
    renderPending();
  }
  else if (G.phase === "result") {
    showScreen("result"); closeModal(); closeHost(); showResult();
    if (!resultSe) { resultSe = true; se("result"); }
  }
}

/* 進行役だけに工具アイコンを出し、パネルを開いたままなら中身を最新にする */
function hostTools() {
  $("hostBtn").style.display = iAmHost() ? "" : "none";
  if (hostOpen()) renderHostPanel();
}

/* ---------- 結果発表 ---------- */
/* 結果画面の見出しは盤面の長さで変わるので、描くたびに作る */
function resultLabels() {
  $("resSub").textContent = ja()
    ? `${firstAge()}歳から${lastAge()}歳、${years()}年間のけっか。順位は「ハッピー」の数で決まります — そして、みんなの「とくい」と見えなかったトビラの公開`
    : `${years()} years, from age ${firstAge()} to ${lastAge()}. Ranking is decided by ♥ Happiness — and everyone's Strengths and hidden doors are revealed`;
  $("allDoorsBtn").textContent = ja() ? `${years()}年間のトビラ一覧を見る` : `See all doors of the ${years()} years`;
}

function showResult() {
  resultLabels();
  const playing = G.players.filter(p => !p.left);
  const gone = G.players.filter(p => p.left);
  const sorted = [...playing].sort((a, b) => b.happy - a.happy || b.money - a.money);
  const list = $("resultList");
  list.innerHTML = "";
  sorted.forEach((p, i) => {
    const total = p.open + p.locked + p.unseen;
    const pct = n => total ? Math.round(n / total * 100) : 0;
    const diff = p.money - p.initMoney;
    const dLearn = p.learn - (p.initLearn != null ? p.initLearn : 1);
    const tone = R.FAM_TONE[L(p.fam.region)] || ["#E9A87C", "#D98E63"];
    const card = document.createElement("div");
    card.className = "res-card";
    card.innerHTML = `
      <div class="res-head">
        <div class="av" style="${faceBg(p)}; border-color:${p.color}"></div>
        <div style="min-width:0">
          <span class="rank">${ja() ? `${i + 1}位` : `#${i + 1}`}</span>
          <div class="r-name">${p.name}</div>
          <div class="r-fam" style="color:${tone[1]}">${ic("home", "s")} ${L(p.fam.name)}</div>
        </div>
      </div>
      <div class="r-story">${L(p.fam.story)}</div>
      <div class="r-stats">
        <div class="rs happy"><div class="k">${ic("heart")}${ja() ? "ハッピー" : "Happiness"}</div>
          <div class="v"><s>0</s>${p.happy}</div>
          <div class="d ${p.happy > 0 ? "up" : ""}">${p.happy > 0 ? "+" + p.happy : (ja() ? "変わらず" : "no change")}</div></div>
        <div class="rs money"><div class="k">${ic("coin")}${ja() ? "おかね" : "Money"}</div>
          <div class="v"><s>${fm(p.initMoney)}</s>${fm(p.money)}</div>
          <div class="d ${diff > 0 ? "up" : (diff < 0 ? "dn" : "")}">${diff > 0 ? "+" : ""}${diff === 0 ? (ja() ? "変わらず" : "no change") : fm(diff)}</div></div>
        <div class="rs learn"><div class="k">${ic("star")}${ja() ? "まなび" : "Learning"}</div>
          <div class="v"><s>★${p.initLearn != null ? p.initLearn : 1}</s>★${p.learn}</div>
          <div class="d ${dLearn > 0 ? "up" : ""}">${dLearn > 0 ? "+" + dLearn : (ja() ? "変わらず" : "no change")}</div></div>
      </div>
      ${p.loan > 0 ? `<div class="r-loan">${ic("cap", "s")} ${ja()
        ? `奨学金が、まだ <b>${fm(p.loan)}</b> のこっている` : `<b>${fm(p.loan)}</b> of the scholarship is still unpaid`}</div>` : ""}
      <div class="r-perk">${ic("spark", "s")} <span><b>${ja() ? "とくい" : "Strength"}</b>：${L(p.fam.perkText)}</span></div>
      <div class="r-ending"><b>${ja() ? `${lastAge()}歳のいま` : `Life at ${lastAge()}`}</b>：${L(R.endingText(p, playing.length === 1, M))}</div>
      <div class="doorbar">
        <div class="seg-open" style="width:${pct(p.open)}%"></div>
        <div class="seg-lock" style="width:${pct(p.locked)}%"></div>
        <div class="seg-unseen" style="width:${pct(p.unseen)}%"></div>
      </div>
      <div class="doorbar-label">${ja()
        ? `出会ったトビラ ${total}枚 ── <span class="lo">開けられた ${p.open}</span>／<span class="ll">カギが足りなかった ${p.locked}</span>／<span class="lu">見えていなかった ${p.unseen}</span>`
        : `${total} doors met ── <span class="lo">opened ${p.open}</span> / <span class="ll">short of keys ${p.locked}</span> / <span class="lu">never saw ${p.unseen}</span>`}</div>
      <div class="r-btns">
        <button class="chip-btn fc-btn" data-p="${p.id}">${ic("home", "s")} ${ja() ? "家庭カードを見る" : "See family card"}</button>
        <button class="chip-btn rv-btn" data-p="${p.id}">${ic("door", "s")} ${ja() ? "トビラのネタバラシを見る" : "See this player's door reveal"}</button>
      </div>`;
    list.appendChild(card);
  });
  list.querySelectorAll(".rv-btn").forEach(b => b.onclick = () => showRevealModal(b.dataset.p));
  list.querySelectorAll(".fc-btn").forEach(b => b.onclick = () => showFamRevealModal(b.dataset.p));
  /* ふりかえりタイム（1画面版と同じ文面）。国内版オンラインには進行スライドがまだないので、結果画面に置く */
  const totalUnseen = playing.reduce((n, p) => n + (p.unseen || 0), 0);
  $("insightBox").innerHTML = `
    <b>■ ふりかえりタイム</b><br>
    順位を決めたのは、お金の多さじゃなくて <b>♥ハッピー</b>。<br>
    ♥が多いということは——<b>人生の選択肢をたくさん持ち、じぶんの意思で選べた</b>ということ。<br>
    そして「選べる」ためには、<b>おかね</b>や<b>まなび</b>というカギが必要だった。<br><br>
    でも今日いちばん大事なのは、たぶんこっち——<br>
    ${playing.length > 1 ? `みんなの人生をあわせて、<b>${totalUnseen}枚のトビラが「見えてすら いなかった」</b>ということ。`
                         : `あなたの人生で、<b>${totalUnseen}枚のトビラが「見えてすら いなかった」</b>ということ。`}<br>
    カギが足りないのと、扉があることを知らないのは、ぜんぜん違う。<br><br>
    ${ic("door", "s")} それぞれのカードの<b>「ネタバラシ」ボタン</b>で、？？？の中身をのぞいてみよう。<br><br>
    🗣 話してみよう：<br>
    ・開けたかったのに、届かなかった／見えていなかったトビラはあった？<br>
    ・秘密にしていた「とくい」も見せ合おう。同じマスで、見えていた景色はどう違った？<br>
    ・現実の世界で「カギ」になるものは、お金のほかに何があるだろう？`;
  $("resLeftNote").innerHTML = gone.length
    ? (ja() ? `とちゅうで抜けた人：${gone.map(p => p.name).join("、")}` : `Left partway: ${gone.map(p => p.name).join(", ")}`)
    : "";
}

/* ---------- 結果発表のあとに、だれの家庭カードでも見られる ----------
   ふりかえりで「だれが、どんな家庭だったか」を確かめるため。とくいもここでは公開ずみ。
   国内版のお給料は全員おなじ式なので、せかい版のような「出なかった数字」の欄はない */
function showFamRevealModal(pid) {
  const p = G.players.find(x => x.id === pid);
  if (!p || !p.fam) return;
  const f = p.fam;
  const learn0 = p.initLearn != null ? p.initLearn : 1;
  openModal(`
    <div class="fam-top" style="--fam:${p.color}">
      <div class="av" style="${faceBg(p)}"></div>
      <div style="min-width:0">
        <span class="pill">${ic("home", "s")} ${ja() ? `${p.name} さんの家庭カード` : `${p.name}'s Family Card`}</span>
        <div class="nm">${L(f.name)}</div>
      </div>
    </div>
    <div class="m-body">
      <div class="fam-story">${L(f.story)}
${famLines(f.region, f.allow)}
      </div>
      <div class="fam-start">
        <div class="k">${ic("start", "s")} ${firstAge()}歳のスタート</div>
        <div class="now-stats">
          <div class="ns money"><div class="k">${ic("coin", "s")}${ja() ? "おかね" : "Money"}</div><div class="v">${fm(p.initMoney != null ? p.initMoney : f.money)}</div></div>
          <div class="ns learn"><div class="k">${ic("star", "s")}${ja() ? "まなび" : "Learn"}</div><div class="v">★${learn0}</div></div>
          <div class="ns happy"><div class="k">${ic("heart", "s")}${ja() ? "ハッピー" : "Happy"}</div><div class="v">♥0</div></div>
        </div>
      </div>
      <div class="fam-perk">
        <div class="k">${ic("spark", "s")} ${ja() ? "とくい" : "Strength"}</div>
        <div class="v">${perkHtml(f)}</div>
      </div>
      <button class="m-btn" id="fcOk">${ja() ? "とじる" : "Close"}</button>
    </div>`, false, closeModal);
  $("fcOk").onclick = closeModal;
}

/* ---------- ネタバラシ ---------- */
function rawReqLabel(o) {
  const parts = [];
  if (o.req.money) parts.push(`${ja() ? "おかね" : "Money "}${fm(o.req.money)}`);
  if (o.req.learn) parts.push(`★${o.req.learn}`);
  if (o.req.maxMoney != null) parts.push(ja() ? `所得制限おかね${fm(o.req.maxMoney)}未満` : `income limit: under ${fm(o.req.maxMoney)}`);
  return parts.join("＋");
}
function fxInline(fx) {
  const parts = [];
  if (fx.money) parts.push(`${fx.money > 0 ? "+" : ""}${fm(fx.money)}`);
  if (fx.learn) parts.push(`★+${fx.learn}`);
  if (fx.happy) parts.push(`♥+${fx.happy}`);
  return parts.join(" ");
}
const RV_META = {
  chosen: ["check", { ja: "えらんだ", en: "Chosen" }, "#4CA872"],
  open: ["door", { ja: "開けられた", en: "Could open" }, "#4CA872"],
  locked: ["lock", { ja: "カギ不足", en: "Short of keys" }, "#C98A3C"],
  unseen: ["eye", { ja: "見えてなかった！", en: "Never saw it!" }, "#7E6BC4"],
};
function showRevealModal(pid) {
  userModal = true;   /* 自分で開いたものなので、状態が届いても閉じない */
  const p = G.players.find(x => x.id === pid);
  const secs = (p.doorLog || []).map(e => {
    const rows = e.opts.map((o, i) => {
      const st = e.chosen === i ? "chosen" : e.states[i];
      const [icon, label, col] = RV_META[st];
      const key = rawReqLabel(o), fx = fxInline(o.fx);
      return `<div class="rv-opt ${st}"><span class="rv-ic" style="color:${col}">${ic(icon)}</span>
        <span class="rv-main"><span class="rv-t">${L(o.t)}</span><span class="rv-d">${L(o.d)}</span>
        <span class="rv-meta">${key || (ja() ? "カギなし" : "No key")}${fx ? `　→ ${fx}` : ""}</span></span>
        <span class="rv-st">${L(label)}</span></div>`;
    }).join("");
    return `<div class="rv-door"><div class="rv-title">${e.age != null ? fage(e.age) + " ── " : ""}${L(e.title)}${e.variant ? `（${L(e.variant)}の家庭）` : ""}</div>${rows}</div>`;
  }).join("");
  openModal(`<div class="rule-page">
      ${tagChip("choice", ja() ? "ネタバラシ" : "The Reveal")}
      <h2>${ja() ? `${p.name} さんが出会ったトビラ、ぜんぶ` : `Every door ${p.name} met`}</h2>
      <p class="m-lead" style="text-align:left">${ja() ? "紫は、ゲーム中「？？？」で中身が見えなかったトビラ。<br>ほんとうは、こんな選択肢だった——" : "Purple marks options hidden as ？？？ during the game.<br>Here's what they really were —"}</p>
      <div class="rv-list">${secs || `<p class='m-lead'>${ja() ? "トビラには出会わなかったみたい。" : "No doors were met."}</p>`}</div>
      <button class="m-btn" id="rvOk">${ja() ? "とじる" : "Close"}</button></div>`, false, closeModal);
  $("rvOk").onclick = closeModal;
}
const whoChips = list => list.map(p => `<span class="who"><span class="p-dot" style="background:${p.color}"></span>${p.name}</span>`).join("");
function showAllDoorsModal() {
  userModal = true;   /* 自分で開いたものなので、状態が届いても閉じない */
  const kt = v => v == null ? "" : (v.ja !== undefined ? v.ja : v);
  const map = new Map();
  G.players.filter(p => !p.left).forEach(p => (p.doorLog || []).forEach(e => {
    const key = `${e.age}|${kt(e.title)}|${kt(e.variant)}`;
    if (!map.has(key)) map.set(key, { age: e.age, title: e.title, variant: e.variant, opts: e.opts, perOpt: e.opts.map(() => ({ chosen: [], locked: [], unseen: [] })) });
    const g = map.get(key);
    e.opts.forEach((o, i) => {
      if (!g.perOpt[i]) g.perOpt[i] = { chosen: [], locked: [], unseen: [] };
      if (e.chosen === i) g.perOpt[i].chosen.push(p);
      else if (e.states[i] === "unseen") g.perOpt[i].unseen.push(p);
      else if (e.states[i] === "locked") g.perOpt[i].locked.push(p);
    });
  }));
  M.SQUARES.forEach((sq, i) => {
    if (sq.t !== "choice") return;
    /* まちのトビラは、都心と地方で中身がちがう。両方を載せる */
    (sq.key === "machi" ? ["地方", "都心"] : ["地方"]).forEach(region => {
      const dummy = { fam: { region }, perk: null, money: 0, learn: 0, seidoDiscount: false, name: "", hidden: [] };
      const def = R.choiceDef(sq.key, dummy, M);
      const key = `${M.AGES[i]}|${kt(def.title)}|${kt(def.variant)}`;
      if (!map.has(key)) map.set(key, { age: M.AGES[i], title: def.title, variant: def.variant, opts: def.opts, perOpt: def.opts.map(() => ({ chosen: [], locked: [], unseen: [] })), untrodden: true });
    });
  });
  const secs = [...map.values()].sort((a, b) => a.age - b.age).map(g => {
    const rows = g.opts.map((o, i) => {
      const st = g.perOpt[i], key = rawReqLabel(o), fx = fxInline(o.fx), lines = [];
      if (st.chosen.length) lines.push(`<div class="rv-who" style="color:#4CA872">${ic("check", "s")} ${ja() ? "えらんだ" : "Chose"}：${whoChips(st.chosen)}</div>`);
      if (st.locked.length) lines.push(`<div class="rv-who" style="color:#C98A3C">${ic("lock", "s")} ${ja() ? "カギ不足" : "Short of keys"}：${whoChips(st.locked)}</div>`);
      if (st.unseen.length) lines.push(`<div class="rv-who" style="color:#7E6BC4">${ic("eye", "s")} ${ja() ? "見えなかった" : "Couldn't see"}：${whoChips(st.unseen)}</div>`);
      return `<div class="rv-opt ${st.unseen.length ? "unseen" : ""}"><span class="rv-main">
        <span class="rv-t">${L(o.t)}</span><span class="rv-d">${L(o.d)}</span>
        <span class="rv-meta">${key || (ja() ? "カギなし" : "No key")}${fx ? `　→ ${fx}` : ""}</span>${lines.join("")}</span></div>`;
    }).join("");
    return `<div class="rv-door"${g.untrodden ? ' style="opacity:.75"' : ""}>
      <div class="rv-title">${fage(g.age)} ── ${L(g.title)}${g.variant ? `（${L(g.variant)}の家庭）` : ""}${g.untrodden ? `<span class="rv-untrod">${ic("walk", "s")} ${ja() ? "だれも通らなかった" : "no one passed here"}</span>` : ""}</div>${rows}</div>`;
  }).join("");
  openModal(`<div class="rule-page">
      ${tagChip("choice", ja() ? "トビラ一覧" : "All Doors")}
      <h2>${ja() ? `${years()}年間に、こんなトビラがあった` : `The doors of these ${years()} years`}</h2>
      <div class="rv-list">${secs}</div>
      <button class="m-btn" id="adOk">${ja() ? "とじる" : "Close"}</button></div>`, false, closeModal);
  $("adOk").onclick = closeModal;
}
$("allDoorsBtn").onclick = showAllDoorsModal;

/* ---------- あそびかた ---------- */
/* 盤面の長さで文言と項目が変わるので、開くたびに組み立てる */
/* あそびかた（1画面の国内版と同じ中身。オンラインで遊ぶぶんの説明だけ足してある） */
const rulePages = () => [
  {type:"goal", tag:"めざすもの", title:"順位を決めるのは ♥ハッピー", items:[
    ["die",`これは<b>${firstAge()}歳から${lastAge()}歳までの${years()}年間</b>をたどる人生すごろく。サイコロを回して、みんなでゴールをめざそう。`],
    ["walk","<b>高校時代（16〜18歳）はサイコロを使わず、1マスずつ</b>進む。進路を選ぶ前の、準備の時間だ。"],
    ["heart","最後の順位は、おかねの多さじゃなく <b>♥ハッピーの数</b>で決まる！"],
    ["door","♥は、人生の選択「<b>トビラ</b>」を開けるともらえる。<b>♥の数＝じぶんの意思で選べた数</b>だ。"],
  ]},
  {type:"choice", tag:"トビラとカギ", title:"いい選択には「カギ」がいる", items:[
    ["door","<b>大きなトビラのマス</b>に止まると、人生の選択がやってくる。"],
    ["star","選択肢には<b>カギ</b>（必要なおかね・★まなび）があるものも。"],
    ["lock","カギが足りないと、そのトビラは開けられない…！"],
    ["people","えらぶ前に、<b>「なぜそれを選ぶのか」をひとこと</b>みんなに話してから決めよう。"],
  ]},
  {type:"learn", tag:"まなびとおかね", title:"★まなびは、未来のカギ", items:[
    ["book","<b>まなびマス</b>やトビラ、できごとで★まなびが貯まる。"],
    ["coin","お給料は「<b>20万＋★×10万</b>」。★が多いほど、たくさん稼げる！"],
    ["bolt","<b>できごとマス</b>では、ラッキーもアクシデントも起こる。"],
  ]},
  {type:"fam", tag:"さいごに", title:"スタート地点は、人それぞれ", items:[
    ["home","はじめに引く<b>家庭カード</b>で、持ちものやまちが変わる。"],
    ["people","家庭カードは<b>みんなに見えている</b>。上の名前を押すと、その人のカードが開く。<b>「とくい」だけは結果発表まで本人だけ</b>。"],
    ["eye","とちゅうで「？？？」の選択肢に出会うかも。それが何なのかは——遊びおわってからのお楽しみ。"],
    ["people","全員ゴールしたら<b>ふりかえりタイム</b>。<b>「ネタバラシ」</b>で、？？？の中身をたしかめよう。"],
  ]},
];
function rulePageHtml(page) {
  const PAGES = rulePages();
  const pg = PAGES[page];
  const items = pg.items.map(([icon, tx]) => `<div class="rule-item"><span class="r-ic">${ic(icon)}</span><span>${L(tx)}</span></div>`).join("");
  const dots = PAGES.map((_, i) => `<span class="${i === page ? "on" : ""}"></span>`).join("");
  const last = page === rulePages().length - 1;
  return `<div class="rule-page">
      ${tagChip(pg.type, L(pg.tag))}
      <h2>${L(pg.title)}</h2>
      <div class="rule-list">${items}</div>
      <div class="rule-dots">${dots}</div>
      <div class="rule-nav">
        ${page > 0 ? `<button class="m-btn ghost" id="rulePrev">${ja() ? "← まえ" : "← Back"}</button>` : ""}
        ${last ? "" : `<button class="m-btn ghost" id="ruleClose">${ja() ? "とじる" : "Close"}</button>`}
        ${last ? `<button class="m-btn" id="ruleDone">${ja() ? "OK！" : "OK!"}</button>` : `<button class="m-btn" id="ruleNext">${ja() ? "つぎへ →" : "Next →"}</button>`}
      </div></div>`;
}

/* ページをめくるたびに「つぎへ」が上下に動くと、押しまちがえる。
   ぜんぶのページを画面の外で一度だけ測って、いちばん高いページに高さをそろえる。
   （言語と横幅が変われば測りなおす） */
let ruleH = { key: "", h: 0 };
function rulesMinHeight(width) {
  const key = `${lang}|${Math.round(width)}`;
  if (ruleH.key === key) return ruleH.h;
  const probe = document.createElement("div");
  probe.className = "modal";
  probe.style.cssText = `position:absolute; left:-9999px; top:0; visibility:hidden;`
    + `width:${width}px; max-height:none; height:auto; overflow:visible; animation:none;`;
  document.body.appendChild(probe);
  let h = 0;
  try {
    rulePages().forEach((_, i) => {
      probe.innerHTML = rulePageHtml(i);
      h = Math.max(h, probe.firstElementChild.offsetHeight);
    });
  } catch (e) { h = 0; }
  probe.remove();
  /* 書体がまだ読みこみ中だと高さがずれるので、そのときは覚えこまない */
  const fontsReady = !document.fonts || document.fonts.status === "loaded";
  ruleH = { key: fontsReady ? key : "", h };
  return h;
}

function renderRules(page) {
  userModal = true;   /* 自分で開いたものなので、状態が届いても閉じない */
  lastKey = "rules" + page;
  const last = page === rulePages().length - 1;
  const closeRules = () => { closeModal(); render(); };
  openModal(rulePageHtml(page), false, closeRules);
  /* 開いてから測る（モーダルの横幅が決まっていないと測れない） */
  const box = $("modalBox"), body = box.firstElementChild;
  const h = rulesMinHeight(box.getBoundingClientRect().width);
  if (h) body.style.minHeight = h + "px";
  if ($("ruleClose")) $("ruleClose").onclick = closeRules;
  if ($("rulePrev")) $("rulePrev").onclick = () => renderRules(page - 1);
  if (last) $("ruleDone").onclick = closeRules;
  else $("ruleNext").onclick = () => renderRules(page + 1);
}

/* 開発用: ブラウザから内部状態をのぞくためのフック */
setInterval(() => {
  try {
    if (!previewMode && G && G.pending && !isOpen() && !animTimer && !diceBusy) renderPending();
  } catch (e) {}
}, 1500);

function previewGame({ screen, state, you, pid, room, lang: previewLang, modal, modalOptions = {}, dice, diceValue } = {}) {
  previewMode = true;
  if (animTimer) { clearTimeout(animTimer); animTimer = null; }
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  diceBusy = false;
  shown = {};
  lastKey = "";
  resultSe = false;
  closeModal();
  closeHost();
  $("diceStage").classList.remove("on");

  const phases = {
    wait: "lobby", waiting: "lobby", cards: "cards", card: "cards",
    game: "play", board: "play", play: "play", result: "result",
  };
  G = state ? structuredClone(state) : null;
  if (G && phases[screen]) G.phase = phases[screen];
  M = R.mode(G && G.mode);          /* Storybookのストーリーからも盤面の長さが決まる */
  YOU = you ? structuredClone(you) : null;
  MYPID = pid || (YOU && YOU.id) || (G && G.players && G.players[0] && G.players[0].id) || null;
  ROOM = room || null;
  if (previewLang === "ja" || previewLang === "en") lang = previewLang;

  if (screen === "lobby" || !G) {
    G = null;
    showScreen("lobby");
    applyLang();
    $("nameInput").value = modalOptions.name || "";
    $("codeInput").value = modalOptions.code || "";
    $("connMsg").textContent = L(modalOptions.error) || "";
    return;
  }

  applyLang();
  render();

  const command = typeof modal === "string" ? { type: modal } : (modal || {});
  switch (command.type) {
    case "card": showCard(true); break;
    case "rules": renderRules(command.page ?? modalOptions.rulePage ?? 0); break;
    case "host": renderHostPanel(); break;
    case "choiceConfirm": {
      const index = command.index ?? modalOptions.index;
      const choice = document.querySelector(`#modalBox .door.pick[data-i="${Number(index)}"]`);
      if (choice) choice.click();
      break;
    }
    case "allDoors":
    case "all-doors": showAllDoorsModal(); break;
    case "reveal": showRevealModal(command.pid || modalOptions.revealPid || MYPID); break;
    case "famReveal": showFamRevealModal(command.pid || modalOptions.revealPid || MYPID); break;
  }

  const die = $("bigDie");
  const diceMode = dice || command.dice || modalOptions.dice;
  const previewDiceValue = diceValue ?? command.diceValue ?? modalOptions.diceValue;
  if (diceMode === "rolling") startBigDice();
  else if (diceMode === "landed") {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    diceBusy = false;
    buildBigDie(die);
    $("diceStage").classList.add("on");
    die.classList.remove("roll");
    die.classList.add("land");
    const value = Math.min(6, Math.max(1, Number(previewDiceValue) || 1));
    die.style.transform = FACE_ROT[value];
    diceFace(value);
    $("dieMsg").textContent = ja() ? `${value} マスすすむ！` : `Move ${value}!`;
  }
}

window.__tobira = {
  get state(){ return G; }, get you(){ return YOU; }, get pid(){ return MYPID; },
  get anim(){ return animTimer; }, get lastKey(){ return lastKey; },
  get wsState(){ return ws && ws.readyState; }, get room(){ return ROOM; },
  preview: previewGame,
  msgs: 0,
};

/* ---------- 起動 ---------- */
$("nameInput").value = localStorage.getItem("tobira-name") || "";
const urlCode = new URLSearchParams(location.search).get("room");
if (urlCode) $("codeInput").value = urlCode.toUpperCase();
diceFace(3);
applyLang();
