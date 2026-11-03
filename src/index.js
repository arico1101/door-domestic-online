/* ===== トビラ 国内版 オンライン — Worker + Durable Object =====
   ゲームの判定・乱数・進行はすべてサーバー(Room)が行う。クライアントは表示と入力だけ。
   家庭カードの境遇はみんなに見せるが、「とくい」と見えない選択肢のタグは
   結果発表まで持ち主の接続にしか送らない。 ===== */
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

const fm = R.fm, ic = R.ic;

/* 家庭カードのうち、全員に見せてよい部分。ここに perk / perkText / hide を
   足すと種明かしがこわれるので、足さないこと（test/ops.mjs で確かめている） */
function publicCard(f) {
  return { id: f.id, name: f.name, region: f.region, story: f.story, money: f.money, allow: f.allow };
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
    const denied = this.join(pid, name);
    if (denied) {
      /* 開始後の新しい人・満員のときは、席を作らずに理由だけ伝えて切る */
      pair[1].accept();
      pair[1].send(JSON.stringify({ t: "denied", reason: denied }));
      pair[1].close(4001, denied);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ pid });
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
    /* 同じ人が別の接続で戻ってきているときは、切断あつかいにしない */
    const still = this.state.getWebSockets().some(x => x !== ws && (x.deserializeAttachment() || {}).pid === pid);
    const p = this.g && this.g.players.find(x => x.id === pid);
    if (p && !still) p.connected = false;
    await this.save();
    this.broadcast();
  }

  save() { return this.state.storage.put("game", this.g); }
  cur() { return this.g.players[this.g.turn]; }
  isActor(pid) { const p = this.cur(); return p && p.id === pid; }

  /* 参加。入れないときは理由（"started" / "full"）を返す */
  join(pid, name) {
    if (!this.g) this.g = { phase: "lobby", hostId: pid, players: [], turn: 0, dice: null, pending: null, heavyOn: false, mode: "full", deck: [] };
    const found = this.g.players.find(p => p.id === pid);
    if (found) { found.connected = true; if (name) found.name = name; return null; }   /* 再接続は同じ席へ */
    if (this.g.phase !== "lobby") return "started";     /* 開始後は新規参加できない */
    if (this.g.players.length >= R.mode(this.g.mode).maxPlayers) return "full";
    const used = new Set(this.g.players.map(p => p.color));
    this.g.players.push({
      id: pid, name: name || `プレイヤー${this.g.players.length + 1}`,
      color: R.PCOLORS.find(c => !used.has(c)) || R.PCOLORS[this.g.players.length % R.PCOLORS.length], connected: true,
      pos: 0, money: 0, learn: 0, happy: 0, done: false, rankAt: null, seen: false,
    });
    if (!this.g.players.some(p => p.id === this.g.hostId)) this.g.hostId = this.g.players[0].id;
    return null;
  }

  /* ---------- 送信 ----------
     家庭カードの境遇（名前・まち・物語・仕送り）は、配られた時点で全員に見せる。
     1画面版でも「カードは見せ合ってOK。でも『とくい』だけは本人だけの秘密」というルール。
     「とくい」（perk）と、見えない選択肢のタグ（hide / hidden）、見えなかった数（unseen）は、
     結果発表まで本人だけに送る。 */
  publicPlayer(p, reveal) {
    const o = {
      id: p.id, name: p.name, color: p.color, connected: p.connected,
      pos: p.pos, money: p.money, learn: p.learn, happy: p.happy,
      done: p.done, rankAt: p.rankAt, seen: p.seen, left: !!p.left,
    };
    if (p.fam) { o.card = publicCard(p.fam); o.allow = p.allow; o.disasterTurns = p.disasterTurns || 0; }
    if (reveal && p.fam) {                              /* 結果発表で全公開 */
      o.fam = p.fam; o.perk = p.perk; o.hidden = p.hidden;
      o.initMoney = p.initMoney; o.initLearn = p.initLearn;
      o.open = p.open; o.locked = p.locked; o.unseen = p.unseen; o.doorLog = p.doorLog;
      o.loan = p.loan; o.seidoDiscount = p.seidoDiscount;
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
    const g = this.g;
    const reveal = g.phase === "result";
    const me = g.players.find(p => p.id === pid);
    return {
      t: "state", pid,
      g: {
        phase: g.phase, hostId: g.hostId, turn: g.turn, dice: g.dice,
        pending: this.pendingFor(pid), heavyOn: g.heavyOn, mode: g.mode,
        players: g.players.map(p => this.publicPlayer(p, reveal)),
      },
      you: me && me.fam ? {
        fam: me.fam, hidden: me.hidden, perk: me.perk, allow: me.allow,
        loan: me.loan, seidoDiscount: me.seidoDiscount, seen: me.seen,
        /* これから先のマスで「？？？」になる選択肢の数（家庭カードに出す） */
        hiddenN: R.hiddenOptionCount(me, me.pos, R.mode(g.mode)),
        /* 自分のトビラの記録。すべて本人が画面で見たことのある数なので、ここで渡してよい */
        open: me.open, locked: me.locked, unseen: me.unseen,
        /* 「じぶんが何を選んだか」だけ。えらばなかった選択肢＝？？？の中身は
           ここでも渡さない（結果発表のネタバラシまで取っておく） */
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
      /* 上限の小さい盤面に切りかえたとき、入りきらない人は後から来た順に戻す */
      const max = R.MODES[m.mode].maxPlayers;
      while (g.players.length > max) g.players.pop();
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
      p.seen = false; p.done = false; p.rankAt = null; p.pos = 0;
      delete p.fam; delete p.left;
    });
  }

  /* ---------- 家庭カードを配る ----------
     1画面版と同じく、6枚をよく切って上から順に配る（7人目以降はないが、念のため一巡させる） */
  deal(heavyOn) {
    const g = this.g;
    const famDeck = R.shuffle([...R.FAMILIES]);
    g.players.forEach((p, i) => {
      const fam = famDeck[i % famDeck.length];
      const lv = R.startLearn(fam);
      Object.assign(p, {
        fam, region: fam.region, perk: fam.perk, hidden: [...fam.hide],
        pos: 0, money: fam.money, initMoney: fam.money, allow: fam.allow,
        learn: lv, initLearn: lv, happy: 0, loan: 0,
        open: 0, locked: 0, unseen: 0, doorLog: [],
        seidoDiscount: false, seidoUsed: false,
        hadHeavy: false, disasterTurns: 0, letterIn: null,
        done: false, rankAt: null, seen: false,
      });
    });
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
    const g = this.g, p = this.cur(), M = R.mode(g.mode);
    /* 高校時代(進路の手前まで)はサイコロを使わず1マスずつ */
    const steps = p.pos < 4 ? 1 : 1 + Math.floor(Math.random() * 6);
    g.dice = p.pos < 4 ? null : steps;
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
  /* skipCount=true：トビラではないライフイベント（死別・被災・案内の封筒）。
     結果発表の「出会ったトビラ」には数えない */
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
      kind: "choice", for: p.id, type: type || "choice",
      def: { title: def.title, body: def.body, variant: def.variant, heavy: !!def.heavy },
      opts: def.opts, states,
      /* カギの表示計算に使う。ここに出る値はどれも選択画面で本人に見えているもの */
      actor: { name: p.name, money: p.money, learn: p.learn, pos: p.pos, perk: p.perk, seidoDiscount: p.seidoDiscount },
    };
  }

  resolveSquare() {
    const g = this.g, p = this.cur(), M = R.mode(g.mode), sq = M.SQUARES[p.pos];
    if (sq.t === "income") {
      if (sq.fixed != null) {
        this.setInfo("income", sq.name || "おしごと", "はじめてのお給料！", { money: sq.fixed });
        return;
      }
      let amt = 20 + p.learn * 10 + p.allow;
      const job = R.jobTitle(p);
      const title = `${job.ic} ${M.AGES[p.pos]}歳・いまの仕事：${job.t}`;
      let note = `お給料は <b>20万 ＋ まなび×10万${p.allow > 0 ? " ＋ 仕送り" + p.allow + "万" : ""}</b><br>まなびが増えると、仕事もお給料も変わっていく`;
      if (p.disasterTurns > 0) { amt -= 10; note += `<br>${ic("bolt", "s")} 被災の影響で −10万（あと${p.disasterTurns}ターン）`; }
      if (p.loan > 0) {
        const pay = Math.min(6, p.loan);
        p.loan -= pay; amt -= pay;
        note += `<br>${ic("cap", "s")} 奨学金の返済 −${pay}万（のこり${p.loan}万）`;
      }
      this.setInfo("income", title, note, { money: amt });
    }
    else if (sq.t === "cost") {
      this.setInfo("cost", sq.name, "生きているとお金はかかる。固定費、だいじ。", { money: -sq.amt });
    }
    else if (sq.t === "event") {
      /* 重いライフイベントが起きる確率は、家庭によらず全員おなじ（30%） */
      if (g.heavyOn && !p.hadHeavy && p.pos >= M.heavyFrom && Math.random() < 0.3) { this.setChoice(R.heavyDef(p), "heavy", true); return; }
      this.drawEvent();
    }
    else if (sq.t === "learn") this.setChoice(R.choiceDef("learnSq", p, M), "learn");
    else if (sq.t === "choice") this.setChoice(R.choiceDef(sq.key, p, M), "choice");
    else if (sq.t === "goal") {
      p.done = true;
      p.rankAt = g.players.filter(x => x.done && !x.left).length;
      /* 45歳のゴールで、のこった奨学金をここで一括清算する */
      g.pending = { kind: "goal", for: p.id, rankAt: p.rankAt, loan: p.loan,
                    fx: { happy: p.rankAt === 1 ? 1 : 0,
                          money: (M.settleLoan && p.loan > 0) ? -p.loan : 0 } };
    }
    else this.endTurn();
  }

  /* できごと。全員が同じ山から、同じ確率で引く（家庭によって山を変えない） */
  drawEvent() {
    const g = this.g, p = this.cur(), M = R.mode(g.mode);
    if (!g.deck || !g.deck.length) g.deck = R.shuffle(R.EVENTS.map((_, i) => i));
    const ev = R.EVENTS[g.deck.pop()];
    if (ev.kind === "info") {
      /* 数えるのはタグの数ではなく、これから出会う選択肢の数。
         タグ数だと「1個見えるようになった」と言われて盤面が何も変わらないことがある */
      const before = R.hiddenOptionCount(p, p.pos, M);
      R.revealTags(p, ev.reveal, p.perk === "tsunagari" ? 2 : 1);
      const revealed = before - R.hiddenOptionCount(p, p.pos, M);
      /* 「見えていない選択肢があった」こと自体がネタバレなので、本人だけに伝える */
      const pnote = revealed > 0 ? `${ic("eye", "s")} 見えていなかった選択肢が <b>${revealed}個</b>、見えるようになった！` : null;
      this.setInfo("event", ev.t, ev.d, {}, null, pnote);
    }
    else if (ev.kind === "fair") this.setChoice(R.fairDef(), "event");
    else {
      const fx = { ...ev.fx };
      if (p.perk === "akinai" && fx.money > 0) fx.money += 10;   /* 商いの感覚 */
      this.setInfo("event", ev.t, ev.d, fx);
    }
  }

  applyChoice(i) {
    const g = this.g, p = this.cur(), o = g.pending.opts[i], M = R.mode(g.mode);
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
    const pnotes = [];                                 /* 本人だけに見せる（見え方・家庭カードのとくい） */
    /* 制度サポートは、はらうお金にも効く */
    if (fx.money) {
      fx.money = R.effectiveMoneyFx(p, o);
      if (fx.money !== o.fx.money && o.special !== "shogakukin") {
        notes.push(`${ic("spark", "s")} 制度サポートで、はらうお金が <b>${o.fx.money}万 → ${fx.money}万</b> に軽くなった。`);
      }
    }
    if (o.special === "revealAll" && p.hidden.length > 0) {
      p.hidden.length = 0;
      pnotes.push(`${ic("eye", "s")} いままで見えていなかった選択肢が、ぜんぶ見えるようになった！`);
    }
    if (o.special === "reveal2") {
      const before = R.hiddenOptionCount(p, p.pos, M);
      R.revealTags(p, "any", p.perk === "tsunagari" ? 4 : 2);
      const n = before - R.hiddenOptionCount(p, p.pos, M);   /* タグ数ではなく選択肢の数 */
      if (n > 0) pnotes.push(`${ic("eye", "s")} 見えていなかった選択肢が <b>${n}個</b>、見えるようになった！`);
    }
    if (o.special === "seidoSupport") {
      p.seidoDiscount = true;
      R.unhideTag(p, "seido");
      notes.push(`${ic("spark", "s")} これから先、制度・まなび系のトビラが <b>最大50万ぶん安くなる</b>。カギ（必要なお金）も、じっさいにはらうお金も。`);
    }
    if (o.special === "letter") p.letterIn = 2;
    if (o.special === "shogakukin") {
      if (p.seidoDiscount || p.perk === "seidoPro") {
        const msg = `${ic("spark", "s")} 制度を知っていたおかげで<b>給付型奨学金</b>に出会えた！学費の負担も軽くなり、返済もいらない。`;
        /* 制度サポート（みんなの前で起きたできごと）が理由なら全員に。
           「制度を知っている」とくいが理由なら、とくいが分かってしまうので本人だけに */
        (p.seidoDiscount ? notes : pnotes).push(msg);
      } else {
        p.loan = 48;
        notes.push(`${ic("cap", "s")} これは<b>貸与型</b>（総額48万）。働きはじめたら、お給料から<b>すこしずつ（−6万）</b>、45歳まで返していく。`);
      }
    }
    if (o.tag === "seido" && p.perk === "seidoPro" && !p.seidoUsed) {
      p.seidoUsed = true;
      fx.learn = (fx.learn || 0) + 1;
      pnotes.push(`${ic("spark", "s")} 制度を知っている強みで まなび+1`);
    }
    /* 本人が「じぶんの選択」を見返すための記録。実際にきいた効果のほうを残す */
    if (g.logged && p.doorLog.length) p.doorLog[p.doorLog.length - 1].appliedFx = { ...fx };
    g.pending = { kind: "result", for: p.id, type: g.pending.type, heavy: !!g.pending.def.heavy, title: o.t, body: o.d, notes, pnotes, fx };
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
