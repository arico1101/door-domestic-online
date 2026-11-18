/* ===== 効果音 =====
   音のファイルは持たない。鳴らすたびに WebAudio で組み立てる。
   （読みこみを増やさない・回線が細い会場でも鳴る・著作権の管理もいらない）

   ブラウザは「人が触るまで」音を出せないので、
   最初のタップで AudioContext をつなぐ（app.js の pointerdown から resume() を呼ぶ）。 */

const KEY = "tobira-se";
let on = localStorage.getItem(KEY) !== "off";
let ctx = null;

export const isOn = () => on;
export function setOn(v) {
  on = !!v;
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
  if (on) resume();
}
export function toggle() { setOn(!on); return on; }

/* 音が出せる状態の AudioContext を返す。出せないときは null（無音のまま進む） */
function ac() {
  if (!on) return null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  } catch { return null; }
}
export function resume() { ac(); }

/* ---- 音のもと ---- */
/* ひとつの音。山なりの音量にして、ブツッと切れないようにする */
function tone(c, { f, to, at = 0, dur = .12, type = "sine", vol = .16 }) {
  const t0 = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(.02, dur / 3));
  g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + .03);
}
/* ざらっとした音（サイコロのころがり、紙をめくる感じ） */
function noise(c, { at = 0, dur = .12, vol = .1, f = 1400, q = .7 }) {
  const t0 = c.currentTime + at;
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource(); src.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
  const g = c.createGain(); g.gain.value = vol;
  src.connect(bp).connect(g).connect(c.destination);
  src.start(t0);
  src.stop(t0 + dur + .02);
}
/* 音階を順に鳴らす（ファンファーレなど） */
function seq(c, notes, { dur = .13, type = "triangle", vol = .16, gap = .09 } = {}) {
  notes.forEach((f, i) => tone(c, { f, at: i * gap, dur, type, vol }));
}

/* ドレミ。数字のままだと読めないので名前で置く */
const N = { C4: 261.6, E4: 329.6, G4: 392, A4: 440, C5: 523.3, D5: 587.3, E5: 659.3,
            G5: 784, A5: 880, C6: 1046.5, E6: 1318.5, G6: 1568 };

/* ---- 場面ごとの音 ---- */
const SOUNDS = {
  /* ボタン全般。短く、じゃまにならない高さ */
  tap:   c => tone(c, { f: N.A5, dur: .06, type: "triangle", vol: .1 }),
  /* モーダルが出る */
  pop:   c => { tone(c, { f: N.D5, dur: .1, type: "triangle", vol: .13 });
                tone(c, { f: N.A5, at: .06, dur: .12, type: "triangle", vol: .12 }); },
  /* サイコロ：ころがる → 止まる */
  roll:  c => [0, .12, .24, .36].forEach(at => noise(c, { at, dur: .1, vol: .09, f: 1800 })),
  land:  c => { tone(c, { f: 180, to: 90, dur: .16, type: "square", vol: .12 });
                tone(c, { f: N.G5, at: .1, dur: .14, type: "triangle", vol: .14 }); },
  /* コマが1マスすすむ */
  step:  c => tone(c, { f: N.E5, dur: .05, type: "sine", vol: .07 }),
  /* トビラの一覧が出る（ノックのような低い2つ） */
  door:  c => { tone(c, { f: 320, dur: .08, type: "sine", vol: .13 });
                tone(c, { f: 260, at: .11, dur: .1, type: "sine", vol: .13 }); },
  /* 開けられると分かった瞬間 */
  unlock:c => { noise(c, { dur: .07, vol: .07, f: 2600 });
                seq(c, [N.E5, N.A5], { dur: .12, gap: .07, vol: .15 }); },
  /* カギが足りなかった */
  locked:c => { tone(c, { f: 210, to: 130, dur: .22, type: "sawtooth", vol: .1 });
                tone(c, { f: 150, at: .05, dur: .16, type: "square", vol: .07 }); },
  /* トビラを開けた */
  open:  c => seq(c, [N.C5, N.E5, N.G5, N.C6], { dur: .14, gap: .07, vol: .15 }),
  /* できごと：うれしい／つらい */
  good:  c => seq(c, [N.E5, N.G5, N.C6], { dur: .14, gap: .08, vol: .15 }),
  bad:   c => { tone(c, { f: N.A4, to: N.E4, dur: .26, type: "triangle", vol: .13 });
                tone(c, { f: 220, at: .12, dur: .22, type: "sine", vol: .1 }); },
  /* 家庭カードをひらく */
  card:  c => { noise(c, { dur: .16, vol: .08, f: 900, q: .5 });
                tone(c, { f: N.G4, to: N.D5, dur: .18, type: "sine", vol: .1 }); },
  /* 25歳・ゴール */
  goal:  c => seq(c, [N.C5, N.E5, N.G5, N.C6], { dur: .18, gap: .1, vol: .16 }),
  /* 結果発表 */
  result:c => { seq(c, [N.C5, N.E5, N.G5, N.C6, N.G5, N.C6], { dur: .2, gap: .12, vol: .16 });
                [N.E6, N.G6].forEach((f, i) => tone(c, { f, at: .72 + i * .1, dur: .3, type: "sine", vol: .1 })); },
};

/* 場面の名前で鳴らす。名前がなければ何も鳴らさない（音で進行を止めない） */
export function play(name) {
  const c = ac();
  const make = SOUNDS[name];
  if (!c || !make) return;
  try { make(c); } catch {}
}
