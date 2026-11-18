/* サーバー(Durable Object)を直接WebSocketで叩いて、最後まで通しでプレイする自動テスト */
const HOST = process.env.HOST || "ws://localhost:8787";
const N = Number(process.env.N || 4);
const MODE = "full";                          /* 国内版の盤面は1つだけ */
const ROOM = "T" + Math.random().toString(36).slice(2, 7).toUpperCase();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clients = [];
let finished = false, err = null, steps = 0;

function mk(i) {
  const pid = `p${i}`;
  const ws = new WebSocket(`${HOST}/ws?room=${ROOM}&pid=${pid}&name=P${i}`);
  const c = { i, pid, ws, state: null, you: null, seen: false };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t !== "state") return;
    c.state = m.g; c.you = m.you;
    try { act(c); } catch (e) { err = e; }
  };
  ws.onerror = e => { err = new Error("ws error " + c.pid); };
  return c;
}
function act(c) {
  const g = c.state;
  if (!g || finished) return;
  if (g.phase === "result") {
    if (!finished) {
      finished = true;
      console.log("=== RESULT ===");
      g.players.forEach(p => console.log(
        ` ${p.name} ${p.fam.id} hidden0=[${(clients.find(c=>c.pid===p.id)||{}).hidden0}] ♥${p.happy} ${p.money}万 ★${p.learn} / 開${p.open} 鍵${p.locked} 見${p.unseen} / ${p.doorLog.length}door`));
    }
    return;
  }
  if (g.phase === "lobby") {
    if (c.pid === g.hostId && g.players.length >= N) {
      /* 盤面の長さを選んでから始める */
      if ((g.mode || "full") !== MODE) { send(c, { t: "setmode", mode: MODE }); return; }
      setTimeout(()=>send(c, { t: "start", heavyOn: true }), 50);
    }
    return;
  }
  if (g.phase === "cards") { if (!c.seen) { c.seen = true; c.hidden0 = (c.you&&c.you.hidden)||[]; c.fam0=c.you&&c.you.fam.id; send(c, { t: "seen" }); } return; }
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

for (let i = 0; i < N; i++) { clients.push(mk(i)); await sleep(120); }
const t0 = Date.now();
while (!finished && Date.now() - t0 < 60000 && !err) await sleep(200);
clients.forEach(c => { try { c.ws.close(); } catch {} });
if (err) { console.log("FAILED:", err.message); process.exit(1); }
if (!finished) { console.log("TIMEOUT: game did not finish. steps =", steps); process.exit(1); }
console.log("OK — finished in", ((Date.now() - t0) / 1000).toFixed(1) + "s, actions:", steps);
