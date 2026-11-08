/* サーバー(Durable Object)を直接WebSocketで叩いて、結果発表まで通しでプレイする自動テスト。
   使い方: N=人数 HOST=接続先 node test/play.mjs   （既定は N=4・ws://localhost:8787）
   あわせて、ゲーム中ずっと「ほかの人のとくい・見えない選択肢のタグが届いていないか」を見張る。 */
const HOST = process.env.HOST || "ws://localhost:8787";
const N = Number(process.env.N || 4);
const ROOM = "T" + Math.random().toString(36).slice(2, 7).toUpperCase();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = [];
let finished = false, err = null, steps = 0, leakChecks = 0;

/* 秘密の項目。結果発表までは、ほかの人の情報の中に一度も出てきてはいけない */
const SECRET = ["perk", "perkText", "hide", "hidden", "unseen", "doorLog", "pnote", "pnotes", "opts", "states", "actor"];
function leak(obj, path = "") {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET.includes(k)) return path + k;
    const r = leak(v, path + k + ".");
    if (r) return r;
  }
  return null;
}
function checkSecrets(c) {
  const g = c.state;
  if (g.phase === "result") return;
  for (const p of g.players) {
    if (p.id === c.pid) continue;
    const found = leak(p);
    if (found) throw new Error(`${c.pid} に ${p.id} の秘密が届いている: players.${found}`);
  }
  if (g.pending && g.pending.for !== c.pid) {
    const found = leak(g.pending);
    if (found) throw new Error(`${c.pid} に ${g.pending.for} の選択の中身が届いている: pending.${found}`);
  }
  leakChecks++;
}

function mk(i) {
  const pid = `p${i}`;
  const ws = new WebSocket(`${HOST}/ws?room=${ROOM}&pid=${pid}&name=P${i}`);
  const c = { i, pid, ws, state: null, you: null, seen: false };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t !== "state") return;
    c.state = m.g; c.you = m.you;
    try { checkSecrets(c); act(c); } catch (e) { err = e; }
  };
  ws.onerror = () => { err = new Error("ws error " + c.pid); };
  return c;
}
function act(c) {
  const g = c.state;
  if (!g || finished) return;
  if (g.phase === "result") {
    if (!finished) {
      finished = true;
      console.log(`=== RESULT (${N}人) ===`);
      g.players.forEach(p => {
        if (!p.fam) throw new Error("結果発表で家庭カードが公開されていない");
        console.log(` ${p.name} ${p.fam.id}(${p.fam.name}) とくい=${p.perk} ♥${p.happy} ${p.money}万 ★${p.learn} / 開${p.open} 鍵${p.locked} 見${p.unseen} / ${p.doorLog.length}door 奨学金残${p.loan}`);
        if (p.loan !== 0) throw new Error("45歳のゴールで奨学金が清算されていない");
        if (!("perk" in p) || !p.fam.perkText) throw new Error("結果発表で「とくい」が公開されていない");
      });
    }
    return;
  }
  if (g.phase === "lobby") {
    if (c.pid === g.hostId && g.players.length >= N) setTimeout(() => send(c, { t: "start", heavyOn: true }), 50);
    return;
  }
  if (g.phase === "cards") {
    if (!c.seen) {
      c.seen = true;
      if (!c.you || !c.you.fam || !c.you.fam.perkText) throw new Error("自分の家庭カード（とくい）が届いていない");
      send(c, { t: "seen" });
    }
    return;
  }
  if (g.phase === "play") {
    const cur = g.players[g.turn];
    if (!cur || cur.id !== c.pid) return;
    steps++;
    if (steps > 4000) { err = new Error("too many steps (stuck?)"); finished = true; return; }
    const pd = g.pending;
    if (!pd) return send(c, { t: "roll" });
    if (pd.kind === "choice") {
      const open = pd.states.map((s, i) => s === "open" ? i : -1).filter(i => i >= 0);
      if (!open.length) { err = new Error("choice with no open option and no pass path"); finished = true; return; }
      return send(c, { t: "choose", i: open[Math.floor(Math.random() * open.length)] });
    }
    return send(c, { t: "ok" });
  }
}
const send = (c, m) => { try { c.ws.send(JSON.stringify(m)); } catch {} };

const t0 = Date.now();
for (let i = 0; i < N; i++) { clients.push(mk(i)); await sleep(120); }
while (!finished && Date.now() - t0 < 90000 && !err) await sleep(200);
clients.forEach(c => { try { c.ws.close(); } catch {} });
if (err) { console.log("FAILED:", err.message); process.exit(1); }
if (!finished) { console.log("TIMEOUT: game did not finish. steps =", steps); process.exit(1); }
console.log(`OK — ${N}人で結果発表まで ${((Date.now() - t0) / 1000).toFixed(1)}s, actions: ${steps}, 秘匿チェック: ${leakChecks}回`);
process.exit(0);
