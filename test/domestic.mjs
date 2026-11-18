/* 国内版オンラインだけのテスト。
   1) ルール（public/rules.js）が1画面版と同じふるまいをするか
   2) サーバーを通して6人で最後まで遊び、配り方・奨学金の清算・秘密の守り方を確かめる
   使い方: npx wrangler dev を起動したうえで  node test/domestic.mjs */
import * as R from "../public/rules.js";

const HOST = process.env.HOST || "ws://localhost:8787";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => { if (!cond) throw new Error(msg); passed++; console.log("  ok　" + msg); };

/* ---------- 1) ルール ---------- */
function rules() {
  console.log("[1] ルール");
  const M = R.mode("full");
  ok(M.SQUARES.length === 36 && M.AGES.length === 36 && M.CHAPTERS.length === 6, "盤面は36マス・6章（1章6マス）");
  ok(M.AGES[0] === 16 && M.AGES[35] === 45, "16歳から45歳まで");
  ok(R.FAMILIES.length === 6 && new Set(R.FAMILIES.map(f => f.id)).size === 6, "家庭カードは6種");
  ok(R.FAMILIES.every(f => f.wage === 20), "お給料の基本は全員20万（せかい版のような基本給の差はない）");
  ok(R.initLearnOf(R.FAMILIES.find(f => f.perk === "dandori")) === 2 && R.initLearnOf(R.FAMILIES[0]) === 1, "段取り力だけ、はじめのまなびが★2");

  const rural = { fam: { region: "地方" } }, city = { fam: { region: "都心" } };
  ok(R.choiceDef("machi", rural).variant === "地方" && R.choiceDef("machi", city).variant === "都心", "まちのトビラは、都心と地方で中身がちがう");
  ok(R.choiceDef("machi", rural).opts.some(o => o.special === "revealAll"), "地方の「都会に出る」で、見えない選択肢がぜんぶ見えるようになる");

  const shogaku = R.choiceDef("shinro", {}).opts.find(o => o.special === "shogakukin");
  ok(shogaku.tag === "seido", "奨学金の選択肢は「制度」のタグ（家庭によって？？？になる）");
  ok(R.meetsReq({ money: 149, learn: 1 }, shogaku) && !R.meetsReq({ money: 150, learn: 1 }, shogaku), "奨学金には所得制限（おかね150万未満）がある");

  const school = R.choiceDef("learnSq", {}).opts.find(o => o.tag === "manabi");
  ok(R.effectiveMoneyReq({ seidoDiscount: true }, school) === 0 && R.effectiveMoneyFx({ seidoDiscount: true }, school) === 0,
     "制度サポートで、まなび系のカギも支払いも50万まで軽くなる");
  ok(R.choiceDef("learnSq", { perk: "dandori" }).opts[1].fx.learn === 2 && R.choiceDef("learnSq", { perk: null }).opts[1].fx.learn === 1,
     "段取り力は、本や動画の独学で★+2");

  const p = { hidden: ["seido", "career", "global"] };
  R.revealTags(p, "any", 1);
  ok(p.hidden.join() === "career,global", "見えるようになる順番は 制度→しごと→海外");

  const hid = { fam: { region: "地方" }, hidden: ["seido", "career", "global"] };
  ok(R.hiddenOptionCount(hid, 0) === 5, "地方のひとり親家庭は、盤面で5つの選択肢が？？？になる");

  const log = sel => [{ title: "進路のトビラ", opts: R.choiceDef("shinro", {}).opts, chosen: sel }];
  ok(R.endingText({ learn: 3, happy: 0, doorLog: log(0) }).includes("扉はいつも開いていた"), "エンディング：自費で進学");
  ok(R.endingText({ learn: 3, happy: 4, doorLog: log(1) }).includes("返済もようやく終わった"), "エンディング：奨学金で進学");
  ok(R.endingText({ learn: 1, happy: 7, doorLog: log(2) }).includes("たたき上げて"), "エンディング：すぐに働く");
}

/* ---------- 2) サーバーを通して6人で遊ぶ ---------- */
async function sixPlayers() {
  console.log("[2] 6人で最後まで");
  const room = "D" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const cs = [];
  for (let i = 0; i < 6; i++) {
    const c = { pid: "p" + i, g: null, you: null, fam0: null, sawCards: null };
    c.ws = new WebSocket(`${HOST}/ws?room=${room}&pid=${c.pid}&name=P${i}`);
    c.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t !== "state") return;
      c.g = m.g; c.you = m.you;
      act(c);
    };
    c.send = m => { try { c.ws.send(JSON.stringify(m)); } catch {} };
    cs.push(c);
    await sleep(120);
  }
  let err = null;
  function act(c) {
    const g = c.g;
    try {
      if (g.phase === "lobby" && c.pid === g.hostId && g.players.length === 6 && !c.started) {
        c.started = true; setTimeout(() => c.send({ t: "start", heavyOn: true }), 50);
      }
      if (g.phase === "cards" && c.you && !c.fam0) {
        c.fam0 = { ...c.you.fam };
        c.sawCards = g.players.map(p => p.card);
        c.send({ t: "seen" });
      }
      if (g.phase !== "play") return;
      const cur = g.players[g.turn];
      if (!cur || cur.id !== c.pid) return;
      const pd = g.pending;
      if (!pd) return c.send({ t: "roll" });
      if (pd.kind === "choice") {
        const open = pd.states.map((s, i) => s === "open" ? i : -1).filter(i => i >= 0);
        if (!open.length) throw new Error("開けられる選択肢がない");
        return c.send({ t: "choose", i: open[Math.floor(Math.random() * open.length)] });
      }
      c.send({ t: "ok" });
    } catch (e) { err = e; }
  }
  const t0 = Date.now();
  while (!err && Date.now() - t0 < 60000 && !(cs[0].g && cs[0].g.phase === "result")) await sleep(200);
  cs.forEach(c => { try { c.ws.close(); } catch {} });
  if (err) throw err;
  const g = cs[0].g;
  ok(g && g.phase === "result", "6人とも45歳のゴールまで進み、結果発表になる");

  const ids = cs.map(c => c.fam0.id);
  ok(new Set(ids).size === 6, "6人に6種の家庭カードが1枚ずつ配られる");
  for (const c of cs) {
    const f = R.FAMILIES.find(x => x.id === c.fam0.id);
    const me = g.players.find(p => p.id === c.pid);
    if (me.initMoney !== f.money || me.initLearn !== R.initLearnOf(f)) throw new Error(`${c.pid}: はじめの持ちものが家庭カードとちがう`);
  }
  ok(true, "はじめのおかね・まなびが、家庭カードどおり");

  const card = cs[0].sawCards.find(x => x && x.id !== cs[0].fam0.id);
  ok(card && card.region && typeof card.allow === "number" && !("perk" in card) && !("perkText" in card) && !("hide" in card),
     "カード確認の時点で、ほかの人のまち・仕送りは見え、とくいとタグは見えない");

  ok(g.players.every(p => p.loan === 0), "45歳のゴールで、奨学金はみんな清算ずみ");
  const seidoPro = g.players.find(p => p.fam.perk === "seidoPro");
  const shinro = seidoPro.doorLog.find(e => e.title === "進路のトビラ");
  const iShogaku = shinro.opts.findIndex(o => o.special === "shogakukin");
  ok(shinro.states[iShogaku] !== "unseen", "「制度を知っている」家庭には、18歳の奨学金がはじめから見えている");
}

try {
  rules();
  await sixPlayers();
  console.log(`\nOK — ${passed} checks passed`);
  process.exit(0);
} catch (e) {
  console.log("\nFAILED:", e.message);
  process.exit(1);
}
