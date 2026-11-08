import * as R from "../public/rules.js";

/* Storybook の雛形。サーバー（src/index.js）が送ってくるのと同じ形の状態を、
   決まった値で組み立てる。乱数は使わない（毎回おなじ画面になるように）。 */
const M = R.mode("full");
const clone = value => structuredClone(value);
const FAMILY_BY_ID = Object.fromEntries(R.FAMILIES.map(family => [family.id, family]));
const PLAYER_IDS = ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"];
const NAMES = ["ありさ", "はると", "ゆい", "そうた", "めい", "けんた"];

/** サーバーの deal() と同じ項目を持つプレイヤー */
export function createPlayer(index = 0, overrides = {}) {
  const famId = overrides.familyId || ["f1", "f2", "f3", "f4", "f5", "f6"][index % 6];
  const fam = clone(FAMILY_BY_ID[famId] || FAMILY_BY_ID.f1);
  const lv = R.startLearn(fam);
  const { familyId, ...rest } = overrides;
  const player = {
    id: PLAYER_IDS[index] || `player-${index + 1}`,
    name: NAMES[index % NAMES.length],
    color: R.PCOLORS[index % R.PCOLORS.length],
    connected: true, pos: 0, money: fam.money, initMoney: fam.money,
    allow: fam.allow, learn: lv, initLearn: lv, happy: 0,
    fam, region: fam.region, perk: fam.perk, hidden: [...fam.hide], loan: 0,
    open: 0, locked: 0, unseen: 0, doorLog: [],
    seidoDiscount: false, seidoUsed: false, hadHeavy: false, disasterTurns: 0, letterIn: null,
    done: false, rankAt: null, seen: true, left: false,
    ...rest,
  };
  player.hidden = [...(rest.hidden || player.fam.hide)];
  return player;
}

export function createGame(overrides = {}) {
  const players = overrides.players || [createPlayer(0)];
  return {
    phase: "play", hostId: players[0]?.id || PLAYER_IDS[0], turn: 0,
    dice: null, pending: null, heavyOn: false, mode: "full", players,
    ...overrides,
  };
}

/** ブラウザが受けとる形（stateFor() と同じく、g と you に分ける） */
export function createState({ game = createGame(), viewerId } = {}) {
  const g = game;
  const viewer = g.players.find(player => player.id === (viewerId || g.players[0]?.id));
  const you = viewer?.fam ? {
    fam: viewer.fam, hidden: viewer.hidden, perk: viewer.perk, allow: viewer.allow,
    loan: viewer.loan, seidoDiscount: viewer.seidoDiscount, seen: viewer.seen,
    open: viewer.open, locked: viewer.locked, unseen: viewer.unseen,
    myChoices: (viewer.doorLog || []).filter(entry => entry.chosen != null).map(entry => ({
      age: entry.age, door: entry.title, variant: entry.variant,
      t: entry.opts[entry.chosen].t, d: entry.opts[entry.chosen].d,
      fx: entry.appliedFx || entry.opts[entry.chosen].fx,
    })),
  } : null;
  const reveal = g.phase === "result";
  const players = g.players.map(player => {
    const o = {
      id: player.id, name: player.name, color: player.color, connected: player.connected,
      pos: player.pos, money: player.money, learn: player.learn, happy: player.happy,
      done: player.done, rankAt: player.rankAt, seen: player.seen, left: !!player.left,
    };
    if (player.fam) {
      const f = player.fam;
      o.card = { id: f.id, name: f.name, region: f.region, story: f.story, money: f.money, allow: f.allow };
      o.allow = player.allow; o.disasterTurns = player.disasterTurns;
    }
    if (reveal) for (const key of ["fam", "perk", "hidden", "initMoney", "initLearn",
      "open", "locked", "unseen", "doorLog", "loan", "seidoDiscount"]) o[key] = player[key];
    return o;
  });
  /* 本人以外への pending は、サーバーの pendingFor() と同じく中身を抜く */
  let pending = g.pending;
  if (pending && pending.for !== viewer?.id) {
    pending = { ...pending };
    delete pending.pnote; delete pending.pnotes;
    if (pending.kind === "choice") {
      delete pending.opts; delete pending.states; delete pending.actor;
      pending.def = { title: g.pending.def.title, heavy: g.pending.def.heavy };
    }
  }
  return { pid: viewer?.id, g: { ...g, pending, players }, you };
}

function choicePending(player, def, type = "choice") {
  const states = def.opts.map(o => o.tag && player.hidden.includes(o.tag) ? "unseen" : R.meetsReq(player, o) ? "open" : "locked");
  return {
    kind: "choice", for: player.id, type,
    def: { title: def.title, body: def.body, variant: def.variant, heavy: !!def.heavy },
    opts: def.opts, states,
    actor: { name: player.name, money: player.money, learn: player.learn, pos: player.pos, perk: player.perk, seidoDiscount: player.seidoDiscount },
  };
}
function doorLog(player, key, chosen, age) {
  const def = R.choiceDef(key, player, M);
  const states = def.opts.map(o => o.tag && player.hidden.includes(o.tag) ? "unseen" : R.meetsReq(player, o) ? "open" : "locked");
  const pick = chosen == null ? null : chosen;
  return { title: def.title, variant: def.variant, age, opts: def.opts, states, chosen: pick,
           appliedFx: pick == null ? undefined : { ...def.opts[pick].fx } };
}
const info = (player, type, title, body, fx = {}, note = null, pnote = null) => ({ kind: "info", for: player.id, type, title, body, note, pnote, fx });

/* 結果発表用のプレイヤー（45歳でゴールずみ） */
function resultPlayer(index, familyId, overrides = {}) {
  const p = createPlayer(index, { familyId, pos: 35, done: true, rankAt: index + 1, ...overrides });
  const early = createPlayer(index, { familyId, money: FAMILY_BY_ID[familyId].money });
  p.doorLog = overrides.doorLog || [
    doorLog(early, "learnSq", 1, 17),
    doorLog(early, "shinro", familyId === "f1" ? 0 : 2, 18),
    doorLog({ ...early, money: 120 }, "sumai", 1, 20),
    doorLog({ ...early, money: 120 }, "machi", 1, 22),
    doorLog({ ...early, learn: 5, money: 60 }, "tenshoku", 2, 28),
  ];
  p.open = overrides.open ?? p.doorLog.reduce((s, e) => s + e.states.filter(x => x === "open").length, 0);
  p.locked = overrides.locked ?? p.doorLog.reduce((s, e) => s + e.states.filter(x => x === "locked").length, 0);
  p.unseen = overrides.unseen ?? p.doorLog.reduce((s, e) => s + e.states.filter(x => x === "unseen").length, 0);
  return p;
}

const preview = (message, options = {}) => ({ ...options, g: message.g, you: message.you, pid: message.pid });
const play = (game, viewerId, options = {}) => preview(createState({ game, viewerId }), { view: "play", ...options });

/* ---- 場面ごとの部品 ---- */
const four = () => [0, 1, 2, 3].map(i => createPlayer(i, { pos: [8, 10, 6, 11][i] }));
const six = () => [0, 1, 2, 3, 4, 5].map(i => createPlayer(i, { pos: [8, 8, 10, 6, 11, 13][i], money: [210, 35, 95, 60, 40, 120][i] }));
const doorFor = (key, familyId, extra = {}) => {
  const p = createPlayer(0, { familyId, pos: Math.max(1, M.SQUARES.findIndex(sq => sq.key === key)), ...extra });
  return play(createGame({ players: [p, createPlayer(1, { pos: 3 })], pending: choicePending(p, R.choiceDef(key, p, M)) }), p.id);
};
const heavyFor = (def, familyId, extra = {}) => {
  const p = createPlayer(0, { familyId, pos: 16, money: 90, learn: 3, ...extra });
  return play(createGame({ players: [p, createPlayer(1, { pos: 14 })], pending: choicePending(p, def, "heavy") }), p.id);
};
const death = { heavy: true, title: "家族が、病気で亡くなった。", body: "しばらくして、暮らしの計算が変わっていることに気づく。<br><b>【この先ずっと：仕送りがなくなる】</b>",
  opts: [
    { t: "遺族年金・給付型奨学金について調べる", d: "支えてくれる制度は、ちゃんとある", req: {}, fx: { learn: 1 }, special: "seidoSupport" },
    { t: "今は、何も考えられない", d: "それでいい。時間が必要なときもある", req: {}, fx: {}, special: "letter" },
  ] };
const quake = { heavy: true, title: "深夜、大きな地震があった。", body: "家族は無事だった。ただ、家と、親の職場は無事ではなかった。<br><b>【3ターンのあいだ：お給料 −10万】</b>",
  opts: [
    { t: "災害支援制度・義援金について調べる", d: "こういうときのための仕組みがある", req: {}, fx: { money: 30, learn: 1 } },
    { t: "貯金でしのぐ", d: "備えがあれば、乗りこえられる", req: { money: 30 }, fx: { money: -30 } },
  ] };
const worker = createPlayer(0, { familyId: "f3", pos: 10, money: 70, learn: 3, happy: 2 });
const loanWorker = createPlayer(0, { familyId: "f4", pos: 14, money: 40, learn: 5, happy: 2, loan: 30, disasterTurns: 2 });
const reviewer = createPlayer(0, { familyId: "f4", pos: 12, money: 55, learn: 5, happy: 3 });
reviewer.doorLog = [doorLog(createPlayer(0, { familyId: "f4", money: 40 }), "shinro", 2, 18), doorLog(createPlayer(0, { familyId: "f4", money: 140 }), "sumai", 1, 20)];
reviewer.open = 3; reviewer.unseen = 1;
const results = [resultPlayer(0, "f1", { happy: 7, money: 420, learn: 9 }), resultPlayer(1, "f5", { happy: 6, money: 120, learn: 8 }),
  resultPlayer(2, "f4", { happy: 3, money: 95, learn: 6 }), resultPlayer(3, "f6", { happy: 2, money: 230, learn: 5 })];
const famCard = id => {
  const me = createPlayer(0, { familyId: id, seen: false });
  return preview(createState({ game: createGame({ phase: "cards", players: [me, createPlayer(1, { familyId: id === "f1" ? "f2" : "f1" })] }) }), { view: "game", modal: "card" });
};

export const scenarios = {
  lobby: {
    initial: { view: "lobby" },
    nameEntered: { view: "lobby", name: "ありさ", code: "K7Q2MP" },
    joinError: { view: "lobby", error: "あいことばを入れてください" },
    startedError: { view: "lobby", name: "ありさ", code: "K7Q2MP", error: "このルームは、もうゲームが始まっています。とちゅうからは入れません（前に入っていた端末なら、そのまま戻れます）。" },
  },
  waiting: {
    hostSolo: preview(createState({ game: createGame({ phase: "lobby", players: [createPlayer(0)] }) }), { view: "wait" }),
    hostSix: preview(createState({ game: createGame({ phase: "lobby", players: [0, 1, 2, 3, 4, 5].map(i => createPlayer(i)) }) }), { view: "wait" }),
    guest: preview(createState({ game: createGame({ phase: "lobby", players: [createPlayer(0), createPlayer(1)] }), viewerId: PLAYER_IDS[1] }), { view: "wait" }),
    hostOffline: preview(createState({ game: createGame({ phase: "lobby", players: [createPlayer(0, { connected: false }), createPlayer(1)] }), viewerId: PLAYER_IDS[1] }), { view: "wait" }),
  },
  board: {
    checkingCards: preview(createState({ game: createGame({ phase: "cards", players: [createPlayer(0, { seen: true }), createPlayer(1, { seen: false })] }) }), { view: "game" }),
    highSchoolStep: play(createGame({ players: [createPlayer(0, { pos: 2 }), createPlayer(1, { pos: 3 })] }), PLAYER_IDS[0]),
    diceTurn: play(createGame({ players: four() }), PLAYER_IDS[0]),
    otherTurn: play(createGame({ players: four(), turn: 1 }), PLAYER_IDS[0]),
    disconnectedTurn: play(createGame({ players: four().map((p, i) => i === 1 ? { ...p, connected: false } : p), turn: 1 }), PLAYER_IDS[0]),
    sixPlayers: play(createGame({ players: six(), turn: 2 }), PLAYER_IDS[0]),
    finishedAndLeft: play(createGame({ players: [createPlayer(0, { pos: 30 }), createPlayer(1, { pos: 35, done: true }), createPlayer(2, { pos: 20, left: true, done: true }), createPlayer(3, { pos: 30, money: -20, disasterTurns: 2 })] }), PLAYER_IDS[0]),
  },
  dice: {
    rolling: play(createGame({ players: [createPlayer(0, { pos: 8 })] }), PLAYER_IDS[0], { dice: "rolling", diceValue: 4 }),
    landed: play(createGame({ players: [createPlayer(0, { pos: 8 })], dice: 5 }), PLAYER_IDS[0], { dice: "landed", diceValue: 5 }),
  },
  family: {
    f1: famCard("f1"), f2: famCard("f2"), f3: famCard("f3"), f4: famCard("f4"), f5: famCard("f5"), f6: famCard("f6"),
    waitingForOthers: preview(createState({ game: createGame({ phase: "cards", players: [createPlayer(0, { seen: true }), createPlayer(1, { seen: false }), createPlayer(2, { seen: false, connected: false })] }) }), { view: "game" }),
    review: play(createGame({ players: [reviewer, createPlayer(1, { pos: 10 })] }), reviewer.id, { modal: "card" }),
    otherPlayer: play(createGame({ players: [createPlayer(0, { pos: 9 }), createPlayer(1, { familyId: "f4", pos: 10, money: 25, learn: 3 })] }), PLAYER_IDS[0], { modal: { type: "otherCard", pid: PLAYER_IDS[1] } }),
  },
  doors: {
    shinroHidden: doorFor("shinro", "f4", { money: 40 }),
    shinroAll: doorFor("shinro", "f1", { money: 160 }),
    sumai: doorFor("sumai", "f2", { money: 60 }),
    machiRural: doorFor("machi", "f3", { money: 90 }),
    machiCity: doorFor("machi", "f1"),
    shikaku: doorFor("shikaku", "f6", { learn: 3, money: 60 }),
    tenshoku: doorFor("tenshoku", "f2", { learn: 5 }),
    kaigai: doorFor("kaigai", "f4", { money: 100, learn: 4 }),
    manabinaoshi: doorFor("manabinaoshi", "f5", { money: 60, learn: 3, seidoDiscount: true }),
    chousen: doorFor("chousen", "f1", { money: 320, learn: 6 }),
    yume: doorFor("yume", "f6", { money: 120 }),
    learning: doorFor("learnSq", "f2", { money: 20 }),
    confirmOpen: { ...doorFor("sumai", "f1", { money: 160 }), modal: { type: "choiceConfirm", index: 0 } },
    confirmLocked: { ...doorFor("shinro", "f4", { money: 40 }), modal: { type: "choiceConfirm", index: 0 } },
    confirmIncomeLimit: { ...doorFor("shinro", "f1", { money: 160 }), modal: { type: "choiceConfirm", index: 1 } },
    confirmDiscount: { ...doorFor("manabinaoshi", "f5", { money: 60, learn: 3, seidoDiscount: true }), modal: { type: "choiceConfirm", index: 0 } },
  },
  heavy: {
    loss: heavyFor(death, "f1"),
    earthquake: heavyFor(quake, "f6"),
    letter: heavyFor(R.letterDef(), "f3", { allow: 0 }),
    fair: (() => { const p = createPlayer(0, { familyId: "f4", pos: 6, money: 45 }); return play(createGame({ players: [p], pending: choicePending(p, R.fairDef(), "event") }), p.id); })(),
  },
  information: {
    firstJob: play(createGame({ players: [createPlayer(0, { pos: 1 })], pending: info(createPlayer(0, { pos: 1 }), "income", "初バイト", "はじめてのお給料！", { money: 15 }) }), PLAYER_IDS[0]),
    income: play(createGame({ players: [worker], pending: info(worker, "income", "🗂 21歳・いまの仕事：会社の一般事務", "お給料は <b>20万 ＋ まなび×10万 ＋ 仕送り5万</b><br>まなびが増えると、仕事もお給料も変わっていく", { money: 55 }) }), worker.id),
    incomeLoanDisaster: play(createGame({ players: [loanWorker], pending: info(loanWorker, "income", "💻 25歳・いまの仕事：専門職・エンジニア", `お給料は <b>20万 ＋ まなび×10万</b><br>まなびが増えると、仕事もお給料も変わっていく<br>${R.ic("bolt", "s")} 被災の影響で −10万（あと2ターン）<br>${R.ic("cap", "s")} 奨学金の返済 −6万（のこり24万）`, { money: 54 }) }), loanWorker.id),
    expense: play(createGame({ players: [worker], pending: info(worker, "cost", "急な出費…", "生きているとお金はかかる。固定費、だいじ。", { money: -30 }) }), worker.id),
    eventGood: play(createGame({ players: [worker], pending: info(worker, "event", R.EVENTS[2].t, R.EVENTS[2].d, R.EVENTS[2].fx) }), worker.id),
    eventInfoPrivate: play(createGame({ players: [worker], pending: info(worker, "event", R.EVENTS[12].t, R.EVENTS[12].d, {}, null, `${R.ic("eye", "s")} 見えていなかった選択肢が <b>2個</b>、見えるようになった！`) }), worker.id),
    resultLoan: play(createGame({ players: [worker], pending: { kind: "result", for: worker.id, type: "choice", title: "奨学金を借りて進学", body: "働きはじめたら、すこしずつ返す。制度を知っていれば、返さなくていい給付型に出会えることも", notes: [`${R.ic("cap", "s")} これは<b>貸与型</b>（総額48万）。働きはじめたら、お給料から<b>すこしずつ（−6万）</b>、45歳まで返していく。`], pnotes: [], fx: { money: -30, learn: 3, happy: 1 } } }), worker.id),
    goal: play(createGame({ players: [createPlayer(0, { pos: 35, money: 180, learn: 8, happy: 6, loan: 18 })], pending: { kind: "goal", for: PLAYER_IDS[0], rankAt: 1, loan: 18, fx: { happy: 1, money: -18 } } }), PLAYER_IDS[0]),
  },
  watching: {
    choice: play(createGame({ players: [createPlayer(1, { familyId: "f3", pos: 11 }), createPlayer(0, { pos: 9 })], turn: 0,
      pending: choicePending(createPlayer(1, { familyId: "f3", pos: 11 }), R.choiceDef("machi", createPlayer(1, { familyId: "f3" }), M)) }), PLAYER_IDS[0]),
    info: play(createGame({ players: [createPlayer(1, { pos: 6 }), createPlayer(0, { pos: 5 })], turn: 0,
      pending: info(createPlayer(1, { pos: 6 }), "event", R.EVENTS[11].t, R.EVENTS[11].d, {}, null, "見えていなかった選択肢が 1個、見えるようになった！") }), PLAYER_IDS[0]),
    result: play(createGame({ players: [createPlayer(1, { pos: 9 }), createPlayer(0, { pos: 8 })], turn: 0,
      pending: { kind: "result", for: PLAYER_IDS[1], type: "choice", title: "実家でしっかり貯金", body: "堅実もりっぱな選択", notes: [], pnotes: ["本人だけの注記"], fx: { money: 50 } } }), PLAYER_IDS[0]),
  },
  results: {
    four: preview(createState({ game: createGame({ phase: "result", players: results }) }), { view: "result" }),
    guestView: preview(createState({ game: createGame({ phase: "result", players: results }), viewerId: PLAYER_IDS[2] }), { view: "result" }),
    withLeft: preview(createState({ game: createGame({ phase: "result", players: [results[0], results[1], { ...createPlayer(2), left: true, done: true }] }) }), { view: "result" }),
    reveal: preview(createState({ game: createGame({ phase: "result", players: results }) }), { view: "result", modal: { type: "reveal", pid: PLAYER_IDS[2] } }),
    allDoors: preview(createState({ game: createGame({ phase: "result", players: results }) }), { view: "result", modal: "allDoors" }),
  },
  help: Object.fromEntries(R.RULE_PAGES.map((_, page) =>
    [`page${page + 1}`, play(createGame({ players: [createPlayer(0, { pos: 10 })] }), PLAYER_IDS[0], { modal: { type: "rules", page } })])),
  host: {
    lobby: preview(createState({ game: createGame({ phase: "lobby", players: [createPlayer(0), createPlayer(1, { connected: false })] }) }), { view: "wait", modal: "host" }),
    cards: preview(createState({ game: createGame({ phase: "cards", players: [createPlayer(0, { seen: true }), createPlayer(1, { seen: false })] }) }), { view: "game", modal: "host" }),
    play: play(createGame({ players: four().map((p, i) => i === 1 ? { ...p, connected: false } : p), turn: 1 }), PLAYER_IDS[0], { modal: "host" }),
  },
};

/* stories がいくつあるはずか（validate.mjs で数を確かめる） */
export const EXPECTED_STORIES = Object.values(scenarios).reduce((n, group) => n + Object.keys(group).length, 0);
