/* 当日の進行役むけ操作（外す・とばす・待たずに始める・進行役の引きつぎ・ロビーにもどす）、
   秘密の扱い（選択肢・とくい・見えない選択肢のタグ）、切断からの復帰、途中参加不可の自動テスト。
   使い方: HOST=ws://localhost:8787 node test/ops.mjs */
const HOST = process.env.HOST || "ws://localhost:8787";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;

function room() { return "T" + Math.random().toString(36).slice(2, 7).toUpperCase(); }

function mk(rm, pid, name) {
  const c = { pid, name, g: null, you: null, auto: false, seen: false, denied: null, closed: false };
  c.ws = new WebSocket(`${HOST}/ws?room=${rm}&pid=${pid}&name=${name}`);
  c.ws.onclose = () => { c.closed = true; };
  c.ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === "denied") { c.denied = m.reason; return; }
    if (m.t !== "state") return;
    c.g = m.g; c.you = m.you;
    if (c.auto) autoAct(c);
  };
  c.send = m => { try { c.ws.send(JSON.stringify(m)); } catch {} };
  c.close = () => { try { c.ws.close(); } catch {} };
  return c;
}
/* 通常プレイの自動応答（ゴールまで進めたいときだけ auto=true にする） */
function autoAct(c) {
  const g = c.g;
  if (!g || g.phase !== "play") return;
  const cur = g.players[g.turn];
  if (!cur || cur.id !== c.pid) return;
  const pd = g.pending;
  if (!pd) return c.send({ t: "roll" });
  if (pd.kind === "choice") {
    const open = pd.states.map((s, i) => s === "open" ? i : -1).filter(i => i >= 0);
    if (!open.length) throw new Error("choice with no open option");
    return c.send({ t: "choose", i: open[0] });
  }
  c.send({ t: "ok" });
}

/* 入る順番＝進行役が決まる順番なので、1人ずつ順番に入れる */
async function join(rm, pid, name) {
  const c = mk(rm, pid, name);
  await waitFor(c, g => g.players.some(p => p.id === pid), `${name} 参加`, 8000, true);
  return c;
}

async function waitFor(c, fn, label, ms = 8000, quiet = false) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.g && fn(c.g)) { if (!quiet) { passed++; console.log("  ok　" + label); } return c.g; }
    await sleep(50);
  }
  throw new Error("TIMEOUT: " + label + " / state=" + JSON.stringify(c.g && {
    phase: c.g.phase, turn: c.g.turn, hostId: c.g.hostId,
    players: c.g.players.map(p => `${p.name}${p.left ? "(left)" : ""}${p.done ? "(done)" : ""}${p.connected ? "" : "(off)"}`),
  }));
}

/* ============ 1. ロビーでの操作 ============ */
async function lobbyOps() {
  console.log("[1] ロビー：名簿から外す／進行役をゆずる・引きつぐ");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B"), c = await join(rm, "c", "C");
  await waitFor(a, g => g.players.length === 3, "3人そろう");

  a.send({ t: "kick", id: "c" });
  await waitFor(a, g => g.players.length === 2 && !g.players.some(p => p.id === "c"), "進行役がCを名簿から外せる");
  await waitFor(b, g => g.players.length === 2, "外れたことが全員に伝わる");

  b.send({ t: "kick", id: "a" });
  await sleep(300);
  if (a.g.players.length !== 2) throw new Error("進行役でない人が外せてしまった");
  passed++; console.log("  ok　進行役でない人は外せない");

  a.send({ t: "passHost", id: "b" });
  await waitFor(b, g => g.hostId === "b", "進行役をゆずれる");

  b.close();                                   /* 進行役の端末が落ちる */
  await waitFor(a, g => !g.players.find(p => p.id === "b").connected, "切断が見える");
  a.send({ t: "claimHost" });
  await waitFor(a, g => g.hostId === "a", "残った人が進行役を引きつげる");

  const d = await join(rm, "d", "D");          /* 外した人が入り直すと色がぶつからない */
  await waitFor(a, g => g.players.length === 3, "入り直せる");
  const colors = new Set(a.g.players.map(p => p.color));
  if (colors.size !== a.g.players.length) throw new Error("色がぶつかっている: " + [...colors]);
  passed++; console.log("  ok　入り直しても色がぶつからない");
  [a, b, c, d].forEach(x => x.close());
}

/* ============ 2. ゲーム中の操作 ============ */
async function gameOps() {
  console.log("[2] ゲーム中：待たずに始める／手番をとばす／進行から外す／ロビーにもどす");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B"), c = await join(rm, "c", "C");
  await waitFor(a, g => g.players.length === 3, "3人そろう");
  a.send({ t: "start", heavyOn: true });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");

  a.send({ t: "seen" });                       /* BとCはカードを開かないまま */
  await waitFor(a, g => g.players.filter(p => p.seen).length === 1, "Aだけ確認ずみ");
  a.send({ t: "forceCards" });
  await waitFor(a, g => g.phase === "play", "待たずに始められる");
  if (a.g.players[a.g.turn].done) throw new Error("抜けた人の手番から始まっている");

  const t0 = a.g.turn;
  a.send({ t: "skipTurn" });
  await waitFor(a, g => g.turn !== t0, "手番をとばせる");

  const victim = a.g.players[a.g.turn].id;     /* いま手番の人を進行から外す */
  if (victim === "a") { a.send({ t: "skipTurn" }); await waitFor(a, g => g.players[g.turn].id !== "a", "Aの番をとばす"); }
  const kickId = a.g.players[a.g.turn].id;
  a.send({ t: "kick", id: kickId });
  await waitFor(a, g => g.players.find(p => p.id === kickId).left === true, "手番の人を進行から外せる");
  await waitFor(a, g => g.players[g.turn].id !== kickId && !g.players[g.turn].done, "手番が次の人にうつる");

  const rest = a.g.players.filter(p => !p.left).map(p => p.id);
  [a, b, c].forEach(x => { if (rest.includes(x.pid)) { x.auto = true; autoAct(x); } });
  await waitFor(a, g => g.phase === "result", "残った人だけで最後まで進む", 60000);
  if (!a.g.players.find(p => p.id === kickId).left) throw new Error("退出の印が消えている");
  passed++; console.log("  ok　結果に退出の印が残る");

  [a, b, c].forEach(x => x.auto = false);
  a.send({ t: "reset" });
  await waitFor(a, g => g.phase === "lobby", "ロビーにもどせる");
  if (a.g.players.some(p => p.id === kickId)) throw new Error("退出した人が名簿に残っている");
  if (a.g.players.some(p => p.done || p.left)) throw new Error("前のゲームの状態が残っている");
  passed++; console.log("  ok　退出した人は名簿から消え、状態がまっさらになる");
  [a, b, c].forEach(x => x.close());
}

/* ============ 3. 進行中でもロビーにもどせる ============ */
async function midReset() {
  console.log("[3] とちゅうでロビーにもどす");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B");
  await waitFor(a, g => g.players.length === 2, "2人そろう");
  a.send({ t: "start", heavyOn: false });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");
  a.send({ t: "reset" });
  await waitFor(b, g => g.phase === "lobby" && g.players.length === 2, "カード確認中でももどせる");
  [a, b].forEach(x => x.close());
}

/* ============ 4. 選択肢は本人の端末にしか届かない ============ */
async function choicePrivacy() {
  console.log("[4] 選んでいる最中、選択肢がほかの人に届かない");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B");
  await waitFor(a, g => g.players.length === 2, "2人そろう");
  a.send({ t: "start", heavyOn: false });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");
  a.send({ t: "seen" }); b.send({ t: "seen" });
  await waitFor(a, g => g.phase === "play", "プレイ開始");

  /* だれかがトビラの前に立つまで進める */
  for (let i = 0; i < 300; i++) {
    const g = a.g;
    if (g.phase !== "play") break;
    if (g.pending && g.pending.kind === "choice") break;
    const cur = g.players[g.turn];
    const c = cur.id === "a" ? a : b;
    if (!g.pending) c.send({ t: "roll" });
    else c.send({ t: "ok" });
    await sleep(60);
  }
  if (!a.g.pending || a.g.pending.kind !== "choice") throw new Error("トビラにたどりつけなかった");
  const actorId = a.g.pending.for;
  const actor = actorId === "a" ? a : b;
  const other = actorId === "a" ? b : a;

  if (!actor.g.pending.opts || !actor.g.pending.states) throw new Error("本人に選択肢が届いていない");
  passed++; console.log("  ok　本人には選択肢が届く");
  await waitFor(other, g => g.pending && g.pending.kind === "choice", "ほかの人にも「選んでいる」ことは伝わる");
  const seen = other.g.pending;
  if (seen.opts || seen.states || seen.actor) throw new Error("ほかの人に選択肢が届いてしまっている: " + JSON.stringify(Object.keys(seen)));
  passed++; console.log("  ok　ほかの人には選択肢そのものが届かない");
  if (!seen.def || !seen.def.title) throw new Error("トビラの名前は伝わってほしい");
  if (seen.def.variant) throw new Error("トビラの種類（都心/地方など）まで伝わっている");
  passed++; console.log("  ok　トビラの名前だけは伝わる");

  /* 選んだあと：結果はみんなに、本人だけの注記は本人に */
  const open = actor.g.pending.states.map((st, i) => st === "open" ? i : -1).filter(i => i >= 0);
  if (open.length) {
    actor.send({ t: "choose", i: open[0] });
    await waitFor(other, g => g.pending && g.pending.kind === "result", "えらんだ結果はみんなに見える");
    if (other.g.pending.pnotes) throw new Error("本人だけの注記がほかの人に届いている");
    passed++; console.log("  ok　本人だけの注記はほかの人に届かない");
  }
  [a, b].forEach(x => x.close());
}

async function cardVisibility() {
  console.log("[5] 家庭カード：境遇はみんなに、とくいは本人だけ");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B");
  await waitFor(a, g => g.players.length === 2, "2人そろう");
  a.send({ t: "start", heavyOn: false });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");
  await waitFor(a, g => g.players.every(p => p.card), "全員の境遇が届く");
  const bOnA = a.g.players.find(p => p.id === "b").card;
  for (const k of ["name", "region", "story"])
    if (!bOnA[k]) throw new Error(`ほかの人のカードに ${k} が無い`);
  if (bOnA.allow == null) throw new Error("ほかの人のカードに仕送りが無い");
  passed++; console.log("  ok　カード確認の時点で、ほかの人の境遇（名前・まち・物語・仕送り）が見える");
  /* とくいと見えない選択肢のタグは、種明かしの仕掛けそのもの。結果発表まで本人だけ */
  const leak = (obj, path = "") => {
    if (!obj || typeof obj !== "object") return null;
    for (const [k, v] of Object.entries(obj)) {
      if (["perk", "perkText", "hide", "hidden", "unseen", "doorLog"].includes(k)) return path + k;
      const r = leak(v, path + k + ".");
      if (r) return r;
    }
    return null;
  };
  for (const p of a.g.players.filter(p => p.id !== "a")) {
    const found = leak(p);
    if (found) throw new Error(`ほかの人のとくい／タグが届いている: ${found}`);
  }
  passed++; console.log("  ok　ほかの人の「とくい」と見えない選択肢のタグは届かない");
  if (!a.you || !a.you.fam || !a.you.fam.perkText) throw new Error("自分のとくいは見えてほしい");
  if (!Array.isArray(a.you.hidden) || typeof a.you.hiddenN !== "number") throw new Error("自分の見えない選択肢の情報は自分に届いてほしい");
  passed++; console.log("  ok　自分のとくい・見えない選択肢の数は自分に届く");

  /* 結果発表までずっと秘密のまま。結果発表になったら全員分が公開される */
  a.send({ t: "seen" }); b.send({ t: "seen" });
  await waitFor(a, g => g.phase === "play", "プレイ開始");
  let checks = 0;
  const watch = (c) => {
    const prev = c.ws.onmessage;
    c.ws.onmessage = ev => {
      prev(ev);
      const g = c.g;
      if (!g || g.phase === "result") return;
      for (const p of g.players.filter(p => p.id !== c.pid)) {
        const found = leak(p);
        if (found) { c.leak = `players.${found}`; return; }
      }
      if (g.pending && g.pending.for !== c.pid) {
        for (const k of ["opts", "states", "actor", "pnote", "pnotes"]) if (k in g.pending) { c.leak = "pending." + k; return; }
      }
      checks++;
    };
  };
  watch(a); watch(b);
  a.auto = true; b.auto = true; autoAct(a); autoAct(b);
  await waitFor(a, g => g.phase === "result" || a.leak || b.leak, "結果発表まで進む", 60000, true);
  if (a.leak || b.leak) throw new Error("ゲーム中に秘密が届いている: " + (a.leak || b.leak));
  passed++; console.log(`  ok　結果発表まで、ほかの人のとくい・タグ・選択肢は一度も届かない（${checks}回確認）`);
  const bRes = a.g.players.find(p => p.id === "b");
  if (!("perk" in bRes) || !bRes.fam || !bRes.fam.perkText || !Array.isArray(bRes.doorLog)) throw new Error("結果発表で全員分が公開されていない");
  passed++; console.log("  ok　結果発表で、ほかの人のとくい・トビラの記録が公開される");
  [a, b].forEach(x => { x.auto = false; x.close(); });
}

/* ============ 6. 切断からの復帰 ============ */
async function reconnect() {
  console.log("[6] 切断しても、同じ端末（同じpid）でつなぎ直せば同じ席に戻れる");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B"), c = await join(rm, "c", "C");
  await waitFor(a, g => g.players.length === 3, "3人そろう");
  a.send({ t: "start", heavyOn: false });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");
  [a, b, c].forEach(x => x.send({ t: "seen" }));
  await waitFor(a, g => g.phase === "play", "プレイ開始");
  /* 何手か進めて、Bの状態をおぼえておく */
  for (let i = 0; i < 40; i++) {
    const cur = a.g.players[a.g.turn];
    const x = [a, b, c].find(y => y.pid === cur.id);
    const pd = x.g.pending;
    if (!pd) x.send({ t: "roll" });
    else if (pd.kind === "choice") x.send({ t: "choose", i: pd.states.indexOf("open") });
    else x.send({ t: "ok" });
    await sleep(60);
  }
  const before = a.g.players.find(p => p.id === "b");
  const seat = a.g.players.findIndex(p => p.id === "b");
  const famBefore = b.you.fam.id;
  b.close();
  await waitFor(a, g => !g.players.find(p => p.id === "b").connected, "Bの切断が全員に見える");
  const b2 = mk(rm, "b", "B");
  await waitFor(b2, g => g.players.find(p => p.id === "b").connected, "Bがつなぎ直せる");
  const after = b2.g.players.find(p => p.id === "b");
  if (b2.g.players.findIndex(p => p.id === "b") !== seat) throw new Error("席の順番が変わっている");
  if (after.pos !== before.pos || after.money !== before.money || after.color !== before.color) throw new Error("戻ったら状態が変わっている");
  if (!b2.you || b2.you.fam.id !== famBefore) throw new Error("戻ったら家庭カードが変わっている");
  if (b2.g.players.length !== 3) throw new Error("つなぎ直しで人数が増えている");
  passed++; console.log("  ok　同じ席・同じ家庭カード・同じ位置とおかねで戻れる");
  /* 戻った人の手番もちゃんと回る */
  [a, b2, c].forEach(x => { x.auto = true; autoAct(x); });
  await waitFor(a, g => g.phase === "result", "戻ったあとも結果発表まで進む", 60000);
  [a, b2, c].forEach(x => { x.auto = false; x.close(); });
}

/* ============ 7. 途中参加はできない ============ */
async function noMidJoin() {
  console.log("[7] ゲームが始まったあとは、新しい人は入れない");
  const rm = room();
  const a = await join(rm, "a", "A"), b = await join(rm, "b", "B");
  await waitFor(a, g => g.players.length === 2, "2人そろう");
  a.send({ t: "start", heavyOn: false });
  await waitFor(a, g => g.phase === "cards", "カード確認へ");
  const z = mk(rm, "z", "Z");
  const t0 = Date.now();
  while (!z.denied && Date.now() - t0 < 5000) await sleep(50);
  if (z.denied !== "started") throw new Error("途中参加が断られていない: " + z.denied);
  passed++; console.log("  ok　新しい人には「もう始まっている」と返して席を作らない");
  await sleep(300);
  if (a.g.players.some(p => p.id === "z") || a.g.players.length !== 2) throw new Error("途中参加の人が名簿に入っている");
  if (z.g) throw new Error("途中参加の人にゲームの状態が送られている");
  passed++; console.log("  ok　名簿は2人のまま・ゲームの状態も送られない");
  /* 満員（6人）のロビーにも入れない */
  const rm2 = room();
  const six = [];
  for (let i = 0; i < 6; i++) six.push(await join(rm2, "s" + i, "S" + i));
  const seventh = mk(rm2, "s6", "S6");
  const t1 = Date.now();
  while (!seventh.denied && Date.now() - t1 < 5000) await sleep(50);
  if (seventh.denied !== "full") throw new Error("7人目が断られていない: " + seventh.denied);
  passed++; console.log("  ok　7人目は「満員」で断られる");
  [a, b, z, seventh, ...six].forEach(x => x.close());
}

try {
  await lobbyOps();
  await gameOps();
  await midReset();
  await choicePrivacy();
  await cardVisibility();
  await reconnect();
  await noMidJoin();
  console.log(`\nOK — ${passed} checks passed`);
  process.exit(0);
} catch (e) {
  console.log("\nFAILED:", e.message);
  process.exit(1);
}
