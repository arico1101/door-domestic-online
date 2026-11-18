/* ===== トビラ 国内版 オンライン — Worker + Durable Object =====
   ゲームの判定はすべてサーバー(Room)が行う。クライアントは表示と入力だけ。
   しくみは せかい版オンライン(door-world-online)と同じ。ルールと文言は
   国内版1画面(door-domestic-game)にそろえてある（public/rules.js）。
   家庭カードの境遇は全員に見せ、「とくい」と見えない選択肢だけは本人にしか送らない。 ===== */
import * as R from "../public/rules.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response("bad room code", { status: 400 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ---------- 表示用の文字列づくり（サーバーで日英どちらも作って送る） ---------- */
const fmJa = n => `${n}万`;
const fmEn = n => `${n < 0 ? "-" : ""}¥${(Math.abs(n) * 10).toLocaleString("en-US")}k`;
const bi = (ja, en) => ({ ja, en });
const join = (a, b) => a ? bi(a.ja + "<br>" + b.ja, a.en + "<br>" + b.en) : b;

/* 家庭カードのうち、全員に見せてよい部分。ここに perk / perkText / hide を
   足すと種明かしがこわれるので、足さないこと（test/ops.mjs で確かめている） */
function publicCard(f) {
  return { id: f.id, name: f.name, region: f.region, story: f.story, allow: f.allow };
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.g = null;
    state.blockConcurrencyWhile(async () => {
      this.g = (await state.storage.get("game")) || null;
    });
  }

  /* ---------- 接続 ---------- */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const url = new URL(request.url);
    const pid = (url.searchParams.get("pid") || "").slice(0, 40) || crypto.randomUUID();
    const name = (url.searchParams.get("name") || "").slice(0, 12);
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ pid });
    this.join(pid, name);
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const { pid } = ws.deserializeAttachment() || {};
    if (!pid || !this.g) return;
    try { this.handle(pid, m); } catch (e) { console.log("handle error", e && e.stack); }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) {
    const { pid } = ws.deserializeAttachment() || {};
    const p = this.g && this.g.players.find(x => x.id === pid);
    if (p) p.connected = false;
    await this.save();
    this.broadcast();
  }

  save() { return this.state.storage.put("game", this.g); }
  cur() { return this.g.players[this.g.turn]; }
  isActor(pid) { const p = this.cur(); return p && p.id === pid; }

  join(pid, name) {
    /* mode：国内版の盤面は1つ（16〜45歳・36マス）。せかい版と仕組みをそろえるため名前だけ持つ */
    if (!this.g) this.g = { phase: "lobby", hostId: pid, players: [], turn: 0, dice: null, pending: null, heavyOn: false, mode: "full", deck: [] };
    const found = this.g.players.find(p => p.id === pid);
    if (found) { found.connected = true; if (name) found.name = name; return; }
    if (this.g.phase !== "lobby") return;              /* 開始後は新規参加できない（再接続は上で拾う） */
    if (this.g.players.length >= R.mode(this.g.mode).maxPlayers) return;
    const used = new Set(this.g.players.map(p => p.color));
    this.g.players.push({
      id: pid, name: name || `Player ${this.g.players.length + 1}`,
      color: R.PCOLORS.find(c => !used.has(c)) || R.PCOLORS[this.g.players.length % R.PCOLORS.length], connected: true,
      pos: 0, money: 0, learn: 0, happy: 0, done: false, rankAt: null, seen: false,
    });
    if (!this.g.players.some(p => p.id === this.g.hostId)) this.g.hostId = this.g.players[0].id;
  }

  /* ---------- 送信 ----------
     家庭カードの「境遇」（物語・まち・仕送り）は、配られた時点で全員に見せる
     （1画面版と同じ。「カードはみんなで見てOK」）。
     いっぽう「とくい」（perk）と、見えない選択肢のタグ（hide）は結果発表まで本人だけ。
     とくいの文面には「支援・奨学金の選択肢が、はじめから全部見えている」など
     種明かしの仕掛けがそのまま書いてあるので、ここだけは絶対に先に見せない。 */
  publicPlayer(p, reveal) {
    const o = {
      id: p.id, name: p.name, color: p.color, connected: p.connected,
      pos: p.pos, money: p.money, learn: p.learn, happy: p.happy,
      done: p.done, rankAt: p.rankAt, seen: p.seen, left: !!p.left,
    };
    if (p.fam) o.card = publicCard(p.fam);
    if (p.char) o.char = p.char;                      /* 見た目は家庭カードで決まる（R.assignChars） */
    if (reveal) {                                       /* 結果発表で全公開 */
      o.fam = p.fam; o.perk = p.perk; o.mult = p.mult;
      o.hidden = p.hidden; o.initMoney = p.initMoney; o.initLearn = p.initLearn;
      o.open = p.open; o.locked = p.locked; o.unseen = p.unseen; o.doorLog = p.doorLog;
      o.loan = p.loan;
    }
    return o;
  }
  /* 「なにが見えていて、なにが見えていないか」は本人だけのもの。
     ほかの人には、選択肢そのものと、本人だけへの注記を送らない。 */
  pendingFor(pid) {
    const pd = this.g.pending;
    if (!pd || pd.for === pid) return pd;
    const o = { ...pd };
    delete o.pnote; delete o.pnotes;
    if (pd.kind === "choice") {
      delete o.opts; delete o.states; delete o.actor;
      o.def = { title: pd.def.title, heavy: pd.def.heavy };   /* トビラの名前だけ（盤面に出ている情報） */
    }
    return o;
  }
  stateFor(pid) {
    const reveal = this.g.phase === "result";
    const me = this.g.players.find(p => p.id === pid);
    return {
      t: "state", pid,
      g: {
        phase: this.g.phase, hostId: this.g.hostId, turn: this.g.turn, dice: this.g.dice,
        pending: this.pendingFor(pid), heavyOn: this.g.heavyOn, mode: this.g.mode,
        players: this.g.players.map(p => this.publicPlayer(p, reveal)),
      },
      you: me && me.fam ? {
        fam: me.fam, hidden: me.hidden, perk: me.perk, mult: me.mult, allow: me.allow,
        loan: me.loan, seidoDiscount: me.seidoDiscount, seen: me.seen,
        /* 自分のトビラの記録。すべて本人が画面で見たことのある数なので、ここで渡してよい */
        open: me.open, locked: me.locked, unseen: me.unseen,
        /* 「じぶんが何を選んだか」だけ。えらばなかった選択肢＝？？？の中身は
           ここでも絶対に渡さない（結果発表のネタバラシまで取っておく） */
        myChoices: (me.doorLog || []).filter(e => e.chosen != null).map(e => ({
          age: e.age, door: e.title, variant: e.variant,
          t: e.opts[e.chosen].t, d: e.opts[e.chosen].d, fx: e.appliedFx || e.opts[e.chosen].fx,
        })),
      } : null,
    };
  }
  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const { pid } = ws.deserializeAttachment() || {};
      try { ws.send(JSON.stringify(this.stateFor(pid))); } catch {}
    }
  }

  /* ---------- 受信 ---------- */
  handle(pid, m) {
    const g = this.g;
    if (m.t === "setName") {
      const p = g.players.find(x => x.id === pid);
      if (p && m.name) p.name = String(m.name).slice(0, 12);
    }
    else if (m.t === "setmode" && pid === g.hostId && g.phase === "lobby" && R.MODES[m.mode]) {
      g.mode = m.mode;
      /* 短い盤面に切りかえたとき、上限より多く入っていたら後から来た人を戻す */
      const max = R.MODES[m.mode].maxPlayers;
      while (g.players.length > max) { const out = g.players.pop(); this.socks.delete(out.id); }
    }
    else if (m.t === "start" && pid === g.hostId && g.phase === "lobby" && g.players.length >= R.mode(g.mode).minStart) {
      this.deal(!!m.heavyOn);
    }
    else if (m.t === "seen" && g.phase === "cards") {
      const p = g.players.find(x => x.id === pid);
      if (p) p.seen = true;
      if (g.players.every(x => x.seen)) this.startPlay();
    }
    else if (m.t === "roll" && g.phase === "play" && !g.pending && this.isActor(pid)) {
      this.roll();
    }
    else if (m.t === "choose" && g.pending && g.pending.kind === "choice" && this.isActor(pid)) {
      this.applyChoice(m.i | 0);
    }
    else if (m.t === "ok" && g.pending && this.isActor(pid)) {
      this.confirmPending();
    }
    else if (m.t === "again" && pid === g.hostId && g.phase === "result") {
      this.toLobby();
    }
    /* ---- ここから進行役むけの操作（当日、進行が止まったときの逃げ道） ---- */
    else if (m.t === "kick" && pid === g.hostId && m.id && m.id !== g.hostId) {
      this.removePlayer(String(m.id));
    }
    else if (m.t === "skipTurn" && pid === g.hostId && g.phase === "play") {
      this.endTurn();                                  /* 手番の人が動けないとき、その番をとばす */
    }
    else if (m.t === "forceCards" && pid === g.hostId && g.phase === "cards") {
      this.startPlay();                                /* カード確認が終わらない人を待たずに始める */
    }
    else if (m.t === "passHost" && pid === g.hostId && m.id !== g.hostId) {
      const t = g.players.find(p => p.id === m.id);
      if (t && !t.left) g.hostId = t.id;
    }
    else if (m.t === "claimHost") {
      /* 進行役の端末が落ちて戻ってこないとき、残った人が引きつげる */
      const host = g.players.find(p => p.id === g.hostId);
      const me = g.players.find(p => p.id === pid);
      if (me && !me.left && (!host || !host.connected)) g.hostId = pid;
    }
    else if (m.t === "reset" && pid === g.hostId) {
      this.toLobby();                                  /* 途中でも、いつでもロビーにもどせる */
    }
  }

  /* ---------- 進行役むけの操作 ---------- */
  /* カード確認フェーズ → プレイ開始。抜けた人の番から始まらないようにする */
  startPlay() {
    const g = this.g;
    const first = g.players.findIndex(p => !p.done);
    if (first < 0) { g.phase = "result"; g.pending = null; g.dice = null; return; }
    g.phase = "play"; g.turn = first;
    this.beginTurn();
  }
  /* ロビーでは名簿から消し、始まったあとは「退出」として進行から外す */
  removePlayer(id) {
    const g = this.g;
    const i = g.players.findIndex(p => p.id === id);
    if (i < 0) return;
    if (g.phase === "lobby") {
      g.players.splice(i, 1);
      if (g.players.length && !g.players.some(p => p.id === g.hostId)) g.hostId = g.players[0].id;
      if (g.turn >= g.players.length) g.turn = 0;
      return;
    }
    const p = g.players[i];
    p.left = true; p.done = true; p.seen = true;
    if (g.phase === "cards") { if (g.players.every(x => x.seen)) this.startPlay(); return; }
    if (g.phase !== "play") return;
    if (g.players.every(x => x.done)) { g.phase = "result"; g.pending = null; g.dice = null; return; }
    if (g.turn === i) this.endTurn();                  /* 手番の人が抜けたら次の人へ */
  }
  /* 結果画面から、あるいは途中からロビーへ。退出した人は名簿から消す */
  toLobby() {
    const g = this.g;
    const rest = g.players.filter(p => !p.left);
    if (rest.length) g.players = rest;
    if (g.players.length && !g.players.some(p => p.id === g.hostId)) g.hostId = g.players[0].id;
    g.phase = "lobby"; g.turn = 0; g.dice = null; g.pending = null; g.deck = [];
    g.players.forEach(p => {
      p.seen = false; p.done = false; p.rankAt = null;
      delete p.fam; delete p.left;
    });
  }

  /* ---------- 家庭カードを配る ---------- */
  deal(heavyOn) {
    const g = this.g;
    /* 1画面版と同じく、ただ混ぜて配る（せかい版のような「必ず入る家庭」はない） */
    const famDeck = R.shuffle([...R.FAMILIES]);
    g.players.forEach((p, i) => {
      const fam = famDeck[i % famDeck.length];
      Object.assign(p, {
        fam, perk: fam.perk, hidden: [...fam.hide],
        pos: 0, money: fam.money, initMoney: fam.money, allow: fam.allow,
        learn: R.initLearnOf(fam), happy: 0, initLearn: R.initLearnOf(fam),
        mult: 10, loan: 0,                              /* お給料は全員「20万＋まなび×10万＋仕送り」 */
        open: 0, locked: 0, unseen: 0, doorLog: [],
        seidoDiscount: false, seidoUsed: false,
        hadHeavy: false, disasterTurns: 0, letterIn: null, wageShown: false,
        done: false, rankAt: null, seen: false,
      });
    });
    R.assignChars(g.players);                           /* 家庭に合った見た目と色をくばる */
    g.heavyOn = heavyOn;
    g.deck = [];
    g.phase = "cards";
  }

  /* ---------- ターンの流れ ---------- */
  beginTurn() {
    const g = this.g, p = this.cur();
    g.dice = null; g.pending = null;
    if (p.letterIn !== null && p.letterIn !== undefined) {
      p.letterIn--;
      if (p.letterIn <= 0) { p.letterIn = null; this.setChoice(R.letterDef(), "heavy", true); }
    }
  }
  roll() {
    const g = this.g, p = this.cur();
    const steps = p.pos < 4 ? 1 : 1 + Math.floor(Math.random() * 6);
    g.dice = p.pos < 4 ? null : steps;
    const M = R.mode(g.mode);
    let target = Math.min(p.pos + steps, M.SQUARES.length - 1);
    for (let i = p.pos + 1; i < target; i++) {
      if (M.SQUARES[i].stop) { target = i; break; }
    }
    p.pos = target;
    this.resolveSquare();
  }
  endTurn() {
    const g = this.g, cur = this.cur();
    if (cur.disasterTurns > 0) cur.disasterTurns--;
    g.pending = null; g.dice = null;
    if (g.players.every(x => x.done)) { g.phase = "result"; return; }
    do { g.turn = (g.turn + 1) % g.players.length; } while (g.players[g.turn].done);
    this.beginTurn();
  }

  setInfo(type, title, body, fx, note, pnote) {
    this.g.pending = {
      kind: "info", for: this.cur().id, type, title, body,
      note: note || null, pnote: pnote || null, fx: fx || {},
    };
  }
  setChoice(def, type, skipCount) {
    const p = this.cur();
    const states = def.opts.map(o => {
      if (o.tag && p.hidden.includes(o.tag)) return "unseen";
      return R.meetsReq(p, o) ? "open" : "locked";
    });
    if (!skipCount) {
      states.forEach(s => { if (s === "unseen") p.unseen++; else if (s === "open") p.open++; else p.locked++; });
      p.doorLog.push({ title: def.title, variant: def.variant, age: R.mode(this.g.mode).AGES[p.pos], opts: def.opts, states, chosen: null });
      this.g.logged = true;
    } else this.g.logged = false;
    this.g.pending = {
      kind: "choice", for: p.id, type: type || "choice", def: { title: def.title, body: def.body, variant: def.variant, heavy: !!def.heavy },
      opts: def.opts, states,
      /* カギの表示計算に使う。ここに出る値はどれも選択画面で見えているもの */
      actor: { name: p.name, money: p.money, learn: p.learn, pos: p.pos, perk: p.perk, seidoDiscount: p.seidoDiscount },
    };
  }

  resolveSquare() {
    const g = this.g, p = this.cur(), M = R.mode(g.mode), sq = M.SQUARES[p.pos];
    if (sq.t === "income") {
      if (sq.fixed != null) {
        this.setInfo("income", sq.name, bi("はじめてのお給料！", "Your first pay!"), { money: sq.fixed });
        return;
      }
      /* お給料は全員おなじ式。差がつくのは ★まなび と 仕送り（家庭カード）だけ */
      let amt = p.fam.wage + p.learn * p.mult + p.allow;
      const job = R.jobTitle(p);
      const title = `${job.ic} ${M.AGES[p.pos]}歳・いまの仕事：${job.t}`;
      const body = `お給料は <b>${fmJa(p.fam.wage)} ＋ まなび×${fmJa(p.mult)}${p.allow > 0 ? " ＋ 仕送り" + fmJa(p.allow) : ""}</b><br>まなびが増えると、仕事もお給料も変わっていく`;
      /* 毎回変わる情報（被災・返済）は、注記として出す */
      let extra = null;
      if (p.disasterTurns > 0) {
        amt -= 10;
        extra = join(extra, bi(`⚠️ 被災の影響で −10万（あと${p.disasterTurns}ターン）`, `⚠️ Disaster: −${fmEn(10)} (${p.disasterTurns} turns left)`));
      }
      if (p.loan > 0) {
        const pay = Math.min(6, p.loan);
        p.loan -= pay; amt -= pay;
        extra = join(extra, bi(`🎓 奨学金の返済 −${pay}万（のこり${p.loan}万）`, `🎓 Scholarship repayment −${fmEn(pay)} (${fmEn(p.loan)} left)`));
      }
      this.setInfo("income", title, body, { money: amt }, extra);
    }
    else if (sq.t === "cost") {
      this.setInfo("cost", sq.name, bi("生きているとお金はかかる。固定費、だいじ。", "Living costs money. Watch those fixed costs."), { money: -sq.amt });
    }
    else if (sq.t === "event") {
      /* skipCount=true：これはトビラではなくライフイベントなので、
         結果発表の「出会ったトビラ」には数えない（手紙イベントと同じ扱い） */
      if (g.heavyOn && !p.hadHeavy && p.pos >= M.heavyFrom && Math.random() < 0.3) { this.setChoice(R.heavyDef(p), "heavy", true); return; }
      this.drawEvent();
    }
    else if (sq.t === "learn") this.setChoice(R.choiceDef("learnSq", p, M), "learn");
    else if (sq.t === "choice") this.setChoice(R.choiceDef(sq.key, p, M), "choice");
    else if (sq.t === "goal") {
      p.done = true;
      p.rankAt = g.players.filter(x => x.done).length;
      /* 45歳のゴールで、のこった奨学金をここで一括清算する（1画面版と同じ） */
      g.pending = { kind: "goal", for: p.id, rankAt: p.rankAt, loan: p.loan,
                    fx: { happy: p.rankAt === 1 ? 1 : 0,
                          money: (M.settleLoan && p.loan > 0) ? -p.loan : 0 } };
    }
    else this.endTurn();
  }

  drawEvent() {
    const g = this.g, p = this.cur();
    let ev = null, guard = 0;
    while (guard++ < 40) {
      if (!g.deck.length) g.deck = R.shuffle(R.EVENTS.map((_, i) => i));
      const cand = R.EVENTS[g.deck.pop()];
      if ((cand.kind === "info" || cand.kind === "fair") && p.hidden.length === 0) continue;
      ev = cand; break;
    }
    if (!ev) return this.endTurn();
    if (ev.kind === "info") {
      /* 数えるのはタグの数ではなく、これから出会う選択肢の数。
         タグ数だと「1個見えるようになった」と言われて盤面が何も変わらないことがある */
      const before = R.hiddenOptionCount(p, p.pos, R.mode(this.g.mode));
      R.revealTags(p, ev.reveal, p.perk === "tsunagari" ? 2 : 1);
      const revealed = before - R.hiddenOptionCount(p, p.pos, R.mode(this.g.mode));
      /* 「見えていない選択肢があった」こと自体がネタバレなので、本人だけに伝える */
      const pnote = revealed > 0
        ? bi(`👁 見えていなかった選択肢が <b>${revealed}個</b>、見えるようになった！`, `👁 <b>${revealed}</b> hidden option${revealed > 1 ? "s" : ""} became visible!`)
        : null;
      this.setInfo("event", ev.t, ev.d, {}, null, pnote);
    }
    else if (ev.kind === "fair") this.setChoice(R.fairDef(), "event");
    else {
      const fx = { ...ev.fx };
      /* 商いの感覚：できごとでおかねが入るとき +10万。とくいは秘密なので、理由は本人にだけ伝える */
      let pnote = null;
      if (p.perk === "akinai" && fx.money > 0) {
        fx.money += 10;
        pnote = bi("✨ 商いの感覚で、さらに +10万", "✨ Business sense: +" + fmEn(10));
      }
      this.setInfo("event", ev.t, ev.d, fx, null, pnote);
    }
  }

  applyChoice(i) {
    const g = this.g, p = this.cur(), o = g.pending.opts[i];
    /* 開けられる扉がひとつもないときの「今回は見送る」(i=-1)。
       いまの盤面では全トビラにカギなしの選択肢があるので起きないが、
       受け口がないと、将来そうなった瞬間に進行が止まったまま動かなくなる */
    if (i < 0) {
      if (g.pending.states.includes("open")) return;   /* 開く扉があるのに見送るのは不可 */
      return this.endTurn();
    }
    if (!o || g.pending.states[i] !== "open") return;
    if (g.logged && p.doorLog.length) p.doorLog[p.doorLog.length - 1].chosen = i;
    const fx = { ...o.fx };
    const notes = [];                                  /* みんなに見せる */
    const pnotes = [];                                 /* 本人だけに見せる（見え方・家庭カードの強み） */
    if (fx.money) {
      fx.money = R.effectiveMoneyFx(p, o);
      if (fx.money !== o.fx.money && o.special !== "shogakukin") {
        notes.push(bi(`✨ 制度サポートで、はらうお金が <b>${fmJa(o.fx.money)} → ${fmJa(fx.money)}</b> に軽くなった。`,
                      `🎗 Thanks to the support, what you pay drops from <b>${fmEn(o.fx.money)} to ${fmEn(fx.money)}</b>.`));
      }
    }
    if (o.special === "revealAll" && p.hidden.length > 0) {
      p.hidden.length = 0;
      pnotes.push(bi("👁 いままで見えていなかった選択肢が、ぜんぶ見えるようになった！", "👁 Every hidden option is now visible!"));
    }
    if (o.special === "reveal2") {
      const before = R.hiddenOptionCount(p, p.pos, R.mode(this.g.mode));
      R.revealTags(p, "any", p.perk === "tsunagari" ? 4 : 2);
      const n = before - R.hiddenOptionCount(p, p.pos, R.mode(this.g.mode));   /* タグ数ではなく選択肢の数 */
      if (n > 0) pnotes.push(bi(`👁 見えていなかった選択肢が <b>${n}個</b>、見えるようになった！`, `👁 <b>${n}</b> hidden option${n > 1 ? "s" : ""} became visible!`));
    }
    if (o.special === "seidoSupport") {
      p.seidoDiscount = true;
      R.unhideTag(p, "seido");
      notes.push(bi("✨ これから先、制度・まなび系のトビラが <b>最大50万ぶん安くなる</b>。カギ（必要なお金）も、じっさいにはらうお金も。",
                    `✨ From now on, support/learning doors cost up to <b>${fmEn(50)} less</b> — both the key you need and the money you actually pay.`));
    }
    if (o.special === "letter") p.letterIn = 2;
    if (o.special === "shogakukin") {
      if (p.seidoDiscount || p.perk === "seidoPro") {
        notes.push(bi("✨ 制度を知っていたおかげで<b>給付型奨学金</b>に出会えた！学費の負担も軽くなり、返済もいらない。",
                      "✨ Because you knew the system, you found <b>a grant you never repay</b>!"));
      } else {
        p.loan = 48;
        notes.push(bi("🎓 これは<b>貸与型</b>（総額48万）。働きはじめたら、お給料から<b>すこしずつ（−6万）</b>、45歳まで返していく。",
                      `🎓 This is <b>a loan</b> (${fmEn(48)} total). Once you work, you repay <b>bit by bit (−${fmEn(6)})</b> until 45.`));
      }
    }
    if (o.tag === "seido" && p.perk === "seidoPro" && !p.seidoUsed) {
      p.seidoUsed = true;
      fx.learn = (fx.learn || 0) + 1;
      pnotes.push(bi("✨ 制度を知っている強みで まなび+1", "✨ Knowing the system: Learn +1"));
    }
    /* 本人が「じぶんの選択」を見返すための記録。実際にきいた効果のほうを残す */
    if (g.logged && p.doorLog.length) p.doorLog[p.doorLog.length - 1].appliedFx = { ...fx };
    g.pending = { kind: "result", for: p.id, type: g.pending.type, title: o.t, body: o.d, notes, pnotes, fx };
  }

  /* info / result / goal のOKで、効果を反映してターンを終える */
  confirmPending() {
    const g = this.g, p = this.cur(), pd = g.pending;
    if (pd.kind === "goal") {
      if (p.rankAt === 1) p.happy += 1;
      if (R.mode(g.mode).settleLoan && p.loan > 0) { p.money -= p.loan; p.loan = 0; }
    } else if (pd.kind === "info" || pd.kind === "result") {
      R.applyFx(p, pd.fx || {});
    } else return;                                   /* choice はボタンで決める */
    this.endTurn();
  }
}
