/* ===== トビラ 国内版 — 共有ルールモジュール =====
   サーバー(Durable Object)とブラウザの両方から読み込む。DOMに触れない純粋なデータとロジックだけを置く。
   ルール・家庭カード・トビラ・文言は、1画面版（door-domestic-game の index.html）と同一に保つこと。
   国内版は日本語だけで遊ぶので、文言は {ja, en} ではなく素の文字列で持つ。 ===== */

/* プレイヤーの色。キャラ(CHARS)と同じ順番で対応させる */
const PCOLORS = ["#F4879F","#6FA9DD","#A98BD9","#6FC49B","#E89A5C","#57BCC9"];
const CHARS = ["p1","p2","p3","p4","p5","p6"];
/* プレイヤーの色から、わりあてられたキャラを引く（国内版はキャラを家庭で選ばず、席の色で決める） */
const charOf = p => CHARS[Math.max(0, PCOLORS.indexOf(p.color))] || CHARS[0];

/* マスの見た目。icon は描いたSVGのid、fill=面、ink=文字、chip=見出しの帯 */
const TYPE_META = {
  start:{label:"スタート", icon:"start", fill:"#F4879F", ink:"#FFFFFF", chip:"#F4879F"},
  goal:{label:"ゴール", icon:"goal", fill:"#FBD96B", ink:"#7A6320", chip:"#E0AE28"},
  income:{label:"おしごと", icon:"coin", fill:"#FCE7A6", ink:"#6B5720", chip:"#D9A32B"},
  cost:{label:"しゅっぴ", icon:"cost", fill:"#F9C9C9", ink:"#8E4A4A", chip:"#D9737B"},
  event:{label:"できごと", icon:"bolt", fill:"#DCD3F5", ink:"#54487A", chip:"#8878C4"},
  learn:{label:"まなび", icon:"book", fill:"#C6E3F7", ink:"#2F5E80", chip:"#4E8FC0"},
  choice:{label:"トビラ", icon:"door", fill:"#F7A9C4", ink:"#FFFFFF", chip:"#E4708F"},
  heavy:{label:"できごと", icon:"bolt", fill:"#E7D6C6", ink:"#6B5442", chip:"#B08968"},
  fam:{label:"家庭カード", icon:"home", fill:"#E9A87C", ink:"#FFFFFF", chip:"#D98E63"},
};
/* 家庭カードの色帯。まちごとに色を変える */
const FAM_TONE = {"都心":["#8FB8E0","#6E9BCC"], "地方":["#E9A87C","#D98E63"]};

/* 描いたアイコン（index.html の <symbol> を参照する）。
   サーバーが作る文面（お給料の内訳など）にも入るので、ここに置く */
const ic = (name, cls) => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#ic-${name}"/></svg>`;
const fm = n => `${n}万`;

/* 家庭カード(6種) hide: seido=制度 / career=しごと / global=海外 */
const FAMILIES = [
  {id:"f1", name:"都心の共働き家庭", region:"都心", money:150, allow:10, hide:[], perk:null,
   story:"「進学するのが当たり前」の空気の中で育った。お金の心配をしたことは、あまりない。",
   perkText:"とくになし"},
  {id:"f2", name:"都心のひとり親家庭", region:"都心", money:40, allow:0, hide:[], perk:"dandori",
   story:"親はいつも働いている。ごはんの支度も、手続きの書類も、気づけば自分でできるようになっていた。まちには情報だけは、たくさんある。",
   perkText:"段取り力：はじめから まなび+1／独学の効果が上がる"},
  {id:"f3", name:"地方の三世代家庭", region:"地方", money:60, allow:5, hide:["seido","career"], perk:"tsunagari",
   story:"じいちゃんの畑と、近所の顔見知り。困ったとき、頼れる人の顔がすぐ浮かぶ。ただ、進路の選択肢は、正直あまり聞いたことがない。",
   perkText:"つながり：情報が手に入るできごとの効果が2倍"},
  {id:"f4", name:"地方のひとり親家庭", region:"地方", money:40, allow:0, hide:["seido","career","global"], perk:"dandori",
   story:"親はいつも働いている。手続きの書類も、気づけば自分でできるようになっていた。このまちで見たことのある仕事は、数えるほどしかない。",
   perkText:"段取り力：はじめから まなび+1／独学の効果が上がる"},
  {id:"f5", name:"はやくに親を亡くした家庭", region:"地方", money:30, allow:0, hide:[], perk:"seidoPro",
   story:"中学のとき、父を亡くした。大変だった。でもそのとき、支えてくれる制度と人がいることを、誰よりも早く知った。",
   perkText:"制度を知っている：支援・奨学金の選択肢がすべて見えている／はじめて使うと まなび+1"},
  {id:"f6", name:"地方の自営業の家庭", region:"地方", money:80, allow:0, hide:["seido","career"], perk:"akinai",
   story:"家の店を手伝って育った。お金が「入ってきて、出ていくもの」だと肌で知っている。ただし、いい月と悪い月がある。",
   perkText:"商いの感覚：臨時収入のできごとが +10万"},
];
/* はじめの まなび。段取り力の家庭は +1 */
const startLearn = fam => 1 + (fam.perk === "dandori" ? 1 : 0);

/* 各マスの年齢（16歳→45歳の29年間） */
const AGES = [
  16,16,17,17,18,
  18,19,19,20,20,
  21,22,24,25,26,
  26,27,28,28,29,
  29,30,31,32,33,
  35,36,37,38,40,
  41,42,43,44,44,
  45,
];
/* 盤面の段＝人生の章。1章＝6マス（せかい版と同じ決めごと） */
const CHAPTERS = [
  {t:"🌱 10代 ── 旅立ちの前", note:"高校時代だけは1マスずつ。準備の時間だ"},
  {t:"🏠 20代前半 ── はじめての自立"},
  {t:"💼 20代なかば ── 道を選ぶ"},
  {t:"🚀 30歳前後 ── キャリアの分かれ道"},
  {t:"📚 30代 ── 学びなおしと挑戦"},
  {t:"🌅 40代 ── 積み重ねの先に"},
];

/* 盤面 36マス */
const SQUARES = [
  {t:"start", name:"スタート"},
  {t:"income", name:"初バイト", fixed:15, stop:true},
  {t:"event", stop:true},
  {t:"learn", stop:true},
  {t:"choice", name:"進路", key:"shinro", stop:true},
  {t:"income", name:"おしごと"},
  {t:"event"},
  {t:"cost", name:"スマホ代・こまごま", amt:20},
  {t:"learn"},
  {t:"choice", name:"住まい", key:"sumai"},
  {t:"income", name:"おしごと"},
  {t:"choice", name:"まち", key:"machi"},
  {t:"cost", name:"急な出費…", amt:30},
  {t:"choice", name:"資格", key:"shikaku"},
  {t:"income", name:"おしごと"},
  {t:"learn"},
  {t:"event"},
  {t:"choice", name:"転職", key:"tenshoku"},
  {t:"income", name:"おしごと"},
  {t:"cost", name:"引っ越し・家電", amt:40},
  {t:"event"},
  {t:"choice", name:"海外", key:"kaigai"},
  {t:"learn"},
  {t:"income", name:"おしごと"},
  {t:"choice", name:"学びなおし", key:"manabinaoshi"},
  {t:"choice", name:"挑戦", key:"chousen"},
  {t:"cost", name:"ライフイベント出費", amt:50},
  {t:"income", name:"おしごと"},
  {t:"event"},
  {t:"choice", name:"大きな夢", key:"yume"},
  {t:"learn"},
  {t:"income", name:"おしごと"},
  {t:"event"},
  {t:"cost", name:"まとまった出費", amt:60},
  {t:"income", name:"おしごと"},
  {t:"goal", name:"ゴール"},
];

/* プレイヤーの「まち」。1画面版は p.region に持っていたが、
   オンライン版は家庭カード(p.fam)から引けるようにしておく */
const regionOf = p => p.region || (p.fam && p.fam.region) || "都心";

/* トビラ定義 tag: seido/career/global は家庭カードによって？？？になる。
   m は盤面のモード。国内版は1種類だが、せかい版オンラインと同じく引数で受ける */
function choiceDef(key, p, m = MODES.full){
  switch(key){
    case "shinro": return {
      title:"進路のトビラ", body:"高校を卒業。ここからの道を選ぼう。",
      opts:[
        {t:"大学・専門に進学（自費）", d:"貯金でまなぶ。世界がひろがる", req:{money:150}, fx:{money:-150, learn:3, happy:1}},
        {t:"奨学金を借りて進学", d:"働きはじめたら、すこしずつ返す。制度を知っていれば、返さなくていい給付型に出会えることも", tag:"seido", req:{maxMoney:150}, fx:{money:-30, learn:3, happy:1}, special:"shogakukin"},
        {t:"すぐに働きはじめる", d:"現場で経験を積みながら貯金する", req:{}, fx:{money:100, learn:1}},
      ]};
    case "sumai": return {
      title:"住まいのトビラ", body:"そろそろ自分の暮らしを考えたい。",
      opts:[
        {t:"ひとり暮らしを始める", d:"自由と責任。自分の生活をつくる", req:{money:100}, fx:{money:-100, learn:1, happy:2}},
        {t:"実家でしっかり貯金", d:"堅実もりっぱな選択", req:{}, fx:{money:50}},
      ]};
    case "machi":
      if(regionOf(p) === "地方") return {
        title:"まちのトビラ", variant:"地方", body:"進学・しごと・暮らし。どこで生きていく？",
        opts:[
          {t:"思いきって都会に出る", d:"生活費は上がる。でも、見える世界が変わる", req:{money:80}, fx:{money:-80, learn:1, happy:1}, special:"revealAll"},
          {t:"今のまちで暮らしつづける", d:"なじみの人と、なじみの景色。生活費は安い", req:{}, fx:{money:30, happy:1}},
        ]};
      return {
        title:"まちのトビラ", variant:"都心", body:"進学・しごと・暮らし。どこで生きていく？",
        opts:[
          {t:"都心に住みつづける", d:"情報も出会いも多い。そのぶん家賃が高い", req:{}, fx:{money:-30, happy:1}},
          {t:"家賃の安い郊外へ", d:"浮いたお金は貯金にまわす", req:{}, fx:{money:30}},
        ]};
    case "shikaku": return {
      title:"資格のトビラ", body:"キャリアの武器になる資格に興味が出てきた。",
      opts:[
        {t:"スクールで難関資格に挑戦", d:"お金と時間を集中投資", tag:"career", req:{money:50, learn:3}, fx:{money:-50, learn:2, happy:1}},
        {t:"オンラインで独学する", d:"コツコツ型。ゼロ円でも学べる", req:{}, fx:{learn:1}},
        {t:"今はやめておく", d:"タイミングも大事", req:{}, fx:{}},
      ]};
    case "tenshoku": return {
      title:"転職のトビラ", body:"憧れの会社が募集を出している！",
      opts:[
        {t:"夢だった仕事に飛びこむ", d:"まなびの蓄積が採用の決め手に", tag:"career", req:{learn:5}, fx:{learn:1, happy:2}},
        {t:"給料の高い会社へ転職", d:"スキルを高く買ってもらう", req:{learn:4}, fx:{money:100}},
        {t:"いまの仕事を続ける", d:"安定して働き、昇給ももらえた", req:{}, fx:{money:30}},
      ]};
    case "kaigai": return {
      title:"海外のトビラ", body:"世界を見てみたい気持ちがふくらむ。",
      opts:[
        {t:"留学・海外で働く", d:"人生観が変わる大きな一歩", tag:"global", req:{money:150, learn:4}, fx:{money:-150, learn:2, happy:3}},
        {t:"長めの海外旅行に行く", d:"見たことのない景色に会いに", req:{money:50}, fx:{money:-50, happy:1}},
        {t:"国内でリフレッシュ", d:"近場にもいい場所はたくさんある", req:{}, fx:{money:-10, happy:1}},
      ]};
    case "manabinaoshi": return {
      title:"学びなおしのトビラ", body:"社会人からでも、学びの扉は開けなおせる。",
      opts:[
        {t:"社会人入学・職業訓練で学びなおす", d:"一度閉じた扉も、もう一度開けられる", tag:"seido", req:{money:100, learn:2}, fx:{money:-100, learn:3, happy:1}},
        {t:"今の道をきわめる", d:"続ける力も立派なキャリア", req:{}, fx:{money:20}},
      ]};
    case "chousen": return {
      title:"挑戦のトビラ", body:"やってみたいことがある。動くなら今かも。",
      opts:[
        {t:"起業する", d:"貯金とまなびを全部つぎこんで勝負", req:{money:300, learn:6}, fx:{money:-300, learn:2, happy:3}},
        {t:"副業を始める", d:"スキルを活かして小さく試す", req:{learn:4}, fx:{money:50, happy:1}},
        {t:"今の道をきわめる", d:"続けることも立派な挑戦", req:{}, fx:{money:20}},
      ]};
    case "yume": return {
      title:"大きな夢のトビラ", body:"人生でいちばんやりたかったこと、覚えてる？",
      opts:[
        {t:"世界一周の旅に出る", d:"ずっと夢だったあの計画を実行", req:{money:200}, fx:{money:-200, happy:4}},
        {t:"大切な人との時間に投資", d:"時間はお金で少し買える", req:{money:100}, fx:{money:-100, happy:3}},
        {t:"宝くじに夢を託す", d:"……当たらなかった。でも夢は見た", req:{}, fx:{money:-10, happy:1}},
      ]};
    case "learnSq": return {
      title:"まなびのトビラ", body:"自分に投資するチャンス。どうする？",
      opts:[
        {t:"講座やスクールで学ぶ", d:"お金をかけたぶん、ぐんと伸びる", tag:"manabi", req:{money:30}, fx:{money:-30, learn:2}},
        {t:"本や動画で独学する", d:"ゼロ円でもちゃんと前に進める", req:{}, fx:{learn: p.perk==="dandori" ? 2 : 1}},
      ]};
  }
}

/* できごとカード。
   1画面版は「見えていない選択肢が無い家庭」には情報系のカード(info/fair)を引かせなかったが、
   それだと家庭によって、できごとの出かたが変わってしまう。オンライン版は全員が同じ山から
   同じ確率で引く。見えていない選択肢が無い人が情報カードを引いても、話を聞くだけで終わる。 */
const EVENTS = [
  {t:"友だちの紹介で単発バイト", d:"人のつながりは思わぬチャンスをくれる", fx:{money:30}},
  {t:"財布を落とした…！", d:"現金の持ちすぎには注意", fx:{money:-20}},
  {t:"SNSの投稿がプチバズり", d:"発信してみるものだ", fx:{learn:1, happy:1}},
  {t:"風邪で寝こんだ", d:"薬代と休んだぶんの出費", fx:{money:-10}},
  {t:"人生を変える本に出会う", d:"1,500円で世界の見え方が変わった", fx:{learn:1}},
  {t:"推しのライブに当選！", d:"チケット代は痛いけど最高だった", fx:{money:-15, happy:2}},
  {t:"家電がこわれた", d:"急な出費。予備のお金があると心強い", fx:{money:-25}},
  {t:"フリマアプリで断捨離", d:"使わないモノがお金に変わった", fx:{money:20}},
  {t:"臨時収入が入った", d:"がんばりが評価された！", fx:{money:40}},
  {t:"「絶対もうかる話」を断った", d:"うまい話にはウラがある。えらい！", fx:{learn:1}},
  {t:"サブスク、入りすぎでは？", d:"固定費の見直しは節約の第一歩", fx:{money:-15}},
  {kind:"info", reveal:"any", t:"親の友人が、自分の仕事の話をしてくれた", d:"知らなかった世界の入口が、少し見えた"},
  {kind:"info", reveal:"seido", t:"SNSで、同い年の投稿が流れてきた", d:"「給付型奨学金、通った！」……そんな制度、あるんだ"},
  {kind:"fair", t:"進学フェアが、となりの県まで来た", d:"交通費はかかるけど、行けば情報が手に入る"},
];

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

/* ★まなびの数（＝お給料）に応じたいまの仕事 */
function jobTitle(p){
  const L = p.learn;
  if(L <= 1) return {ic:"🍔", t:"アルバイトかけもち"};
  if(L <= 2) return {ic:"🔧", t:"工場・現場のスタッフ"};
  if(L <= 3) return {ic:"🗂", t:"会社の一般事務"};
  if(L <= 4) return {ic:"🤝", t:"営業・販売のリーダー"};
  if(L <= 5) return {ic:"💻", t:"専門職・エンジニア"};
  if(L <= 6) return {ic:"🏢", t:"大手企業の社員"};
  return {ic:"👑", t:"マネージャー・専門家"};
}

/* hidden は配列で持つ（JSONで送受信するため）。Set版のロジックをここで吸収する */
function unhideTag(p, tag){ const i = p.hidden.indexOf(tag); if(i >= 0) p.hidden.splice(i,1); }

/* 「まだ見えていない選択肢」の数。p.hidden はタグの配列なので、その長さを数えると
   実際に？？？になる選択肢の数とズレる（例：地方のひとり親はタグ3個だが選択肢は5個）。
   盤面に残っているトビラを実際に開いて、これから出会う？？？を数える。
   fromPos を渡すと、そのマスより先のトビラだけを数える（もう通りすぎた扉は数えない）。 */
function hiddenOptionCount(p, fromPos, m = MODES.full){
  let n = 0;
  m.SQUARES.forEach((sq, i) => {
    if(sq.t !== "choice" || i <= (fromPos || 0)) return;
    const def = choiceDef(sq.key, p, m);
    n += def.opts.filter(o => o.tag && p.hidden.includes(o.tag)).length;
  });
  return n;
}

/* target: "any"=優先順で / "seido"=制度を優先。見えるようにしたタグの数を返す */
function revealTags(p, target, n){
  const order = ["seido","career","global"];
  let count = 0;
  if(target !== "any" && p.hidden.includes(target)){ unhideTag(p, target); count++; n--; }
  for(const t of order){
    if(n <= 0) break;
    if(p.hidden.includes(t)){ unhideTag(p, t); count++; n--; }
  }
  return count;
}

function applyFx(p, fx){
  p.money += fx.money||0;
  p.learn += fx.learn||0;
  p.happy += fx.happy||0;
}
function effectiveMoneyReq(p, o){
  let m = o.req.money || 0;
  if(p.seidoDiscount && (o.tag === "seido" || o.tag === "manabi")) m = Math.max(0, m - 50);
  return m;
}
/* 制度サポートは、カギ（必要額）だけでなく、はらうお金も最大50万ぶん軽くする */
function effectiveMoneyFx(p, o){
  const m = o.fx.money || 0;
  if(m < 0 && p.seidoDiscount && (o.tag === "seido" || o.tag === "manabi")) return Math.min(0, m + 50);
  return m;
}
function meetsReq(p, o){
  const em = effectiveMoneyReq(p, o);
  if(em > 0 && em > p.money) return false;  /* カギなし(0円)の選択肢は借金中でも選べる */
  if(o.req.learn && p.learn < o.req.learn) return false;
  if(o.req.maxMoney != null && p.money >= o.req.maxMoney) return false;  /* 所得制限 */
  return true;
}

/* 45歳のいま: 18歳の進路×♥の量でエンディングが決まる */
const ENDINGS = {
  jihi:[  /* 自費で進学できた */
    "整った道を歩いてきたはずなのに、「じぶんで選んだ」記憶は意外と少ない。扉はいつも開いていた——開けたのは、誰だったんだろう。",
    "安定した暮らし。進学で得たものは、いまも効いている。ただ、あのとき見えていなかった誰かの坂道を、最近になって知った。",
    "好きなしごとと、積み上げてきた自信。恵まれたスタートだったと、いまは素直に思える。次は、誰かの扉を開ける番かもしれない。",
  ],
  shogaku:[  /* 奨学金で進学した */
    "進学はできた。でも返済は、思ったより長い坂だった。給料日のたびに引かれていた−6万の重さを、あなたは知っている。",
    "学んだことがしごとになり、返済もようやく終わった。引き落としが消えた月の、あの身軽さは忘れない。",
    "奨学金で開けた扉の先に、いまの人生がぜんぶある。返しおえた今、「制度があったから、ここにいる」と語れる大人になった。",
  ],
  shushoku:[  /* すぐに働きはじめた */
    "現場一筋の29年。腕には自信がある。ただ、あのとき見えなかった選択肢のことを、ふと考える夜がある。",
    "早くから稼ぎ、堅実に暮らしてきた。後輩に教える立場になって、自分の経験が誰かのカギになると知った。",
    "現場からたたき上げて、気づけば頼られる存在に。学歴より、積んできた経験——あなたの人生は、あなたが選んできた。",
  ],
};
/* p は結果発表で全公開されたプレイヤー（doorLog を持つ） */
function endingText(p){
  const log = p.doorLog || [];
  const shinro = log.find(e=>e.title === "進路のトビラ");
  const sel = (shinro && shinro.chosen != null) ? shinro.opts[shinro.chosen].t : "";
  const ctx = sel.includes("自費") ? "jihi" : sel.includes("奨学金") ? "shogaku" : "shushoku";
  const tier = p.happy >= 6 ? 2 : (p.happy >= 3 ? 1 : 0);
  const job = jobTitle(p);
  let txt = `${job.ic} <b>${job.t}</b>としてはたらく45歳。${ENDINGS[ctx][tier]}`;
  const chosen = log.filter(e=>e.chosen != null).map(e=>e.opts[e.chosen].t);
  if(chosen.some(s=>s.includes("留学"))) txt += "<br>✈️ パスポートには、人生観を変えた出国スタンプが残っている。";
  else if(chosen.some(s=>s.includes("起業"))) txt += "<br>🚀 名刺には、自分の会社の名前がある。";
  else if(chosen.some(s=>s.includes("世界一周"))) txt += "<br>📷 部屋には、世界一周の写真がかざってある。";
  return txt;
}

/* ---------- 重いライフイベント（定義だけを返す。適用はサーバー側） ---------- */
function heavyDef(p){
  const canDeath = p.allow > 0;
  const type = canDeath && Math.random() < 0.6 ? "death" : "disaster";
  p.hadHeavy = true;
  if(type === "death"){
    p.allow = 0;
    return {
      heavy:true,
      title:"家族が、病気で亡くなった。",
      body:"しばらくして、暮らしの計算が変わっていることに気づく。<br><b>【この先ずっと：仕送りがなくなる】</b>",
      opts:[
        {t:"遺族年金・給付型奨学金について調べる", d:"支えてくれる制度は、ちゃんとある", req:{}, fx:{learn:1}, special:"seidoSupport"},
        {t:"今は、何も考えられない", d:"それでいい。時間が必要なときもある", req:{}, fx:{}, special:"letter"},
      ]
    };
  }
  p.disasterTurns = 3;
  return {
    heavy:true,
    title:"深夜、大きな地震があった。",
    body:"家族は無事だった。ただ、家と、親の職場は無事ではなかった。<br><b>【3ターンのあいだ：お給料 −10万】</b>",
    opts:[
      {t:"災害支援制度・義援金について調べる", d:"こういうときのための仕組みがある", req:{}, fx:{money:30, learn:1}},
      {t:"貯金でしのぐ", d:"備えがあれば、乗りこえられる", req:{money:30}, fx:{money:-30}},
    ]
  };
}
function letterDef(){
  return {
    heavy:true,
    title:"役所から、案内の封筒が届いた。",
    body:"中には、遺族年金と給付型奨学金の案内が入っていた。<br>誰かが、ちゃんと気にかけてくれている。",
    opts:[
      {t:"封筒を開けて、調べてみる", d:"支えてくれる制度は、ちゃんとある", req:{}, fx:{learn:1}, special:"seidoSupport"},
      {t:"まだ、開けられない", d:"封筒は、机の上に置いておこう", req:{}, fx:{}, special:"letter"},
    ]
  };
}
/* 進学フェア（できごとカードから開くトビラ） */
function fairDef(){
  return {
    title:"進学フェアが、となりの県まで来た",
    body:"交通費はかかるけど、行けば情報が手に入る。",
    opts:[
      {t:"電車を乗りついで行ってみる", d:"パンフレットと、話を聞ける大人がそこにいる", req:{money:5}, fx:{money:-5}, special:"reveal2"},
      {t:"今回は見送る", d:"交通費も、ばかにならないから", req:{}, fx:{}},
    ]
  };
}

/* ---------- あそびかた（1画面版の4ページ＋オンラインで遊ぶときの1項目） ---------- */
const RULE_PAGES = [
  {type:"goal", tag:"めざすもの", title:"順位を決めるのは ♥ハッピー", items:[
    ["die","これは<b>16歳から45歳までの29年間</b>をたどる人生すごろく。サイコロを回して、みんなでゴールをめざそう。"],
    ["walk","<b>高校時代（16〜18歳）はサイコロを使わず、1マスずつ</b>進む。進路を選ぶ前の、準備の時間だ。"],
    ["heart","最後の順位は、おかねの多さじゃなく <b>♥ハッピーの数</b>で決まる！"],
    ["door","♥は、人生の選択「<b>トビラ</b>」を開けるともらえる。<b>♥の数＝じぶんの意思で選べた数</b>だ。"],
  ]},
  {type:"choice", tag:"トビラとカギ", title:"いい選択には「カギ」がいる", items:[
    ["door","<b>光るトビラのマス</b>に止まると、人生の選択がやってくる。"],
    ["star",`選択肢には<b>カギ</b>（必要な${ic("coin","s")}おかね・★まなび）があるものも。`],
    ["lock","カギが足りないと、そのトビラは開けられない…！"],
    ["people","えらぶ前に、<b>「なぜそれを選ぶのか」をひとこと</b>みんなに話してから決めよう。"],
  ]},
  {type:"learn", tag:"まなびとおかね", title:"★まなびは、未来のカギ", items:[
    ["book",`<b>まなびマス</b>やトビラ、${ic("bolt","s")}できごとで★まなびが貯まる。`],
    ["coin","お給料は「<b>20万＋★×10万</b>」。★が多いほど、たくさん稼げる！"],
    ["bolt","<b>できごとマス</b>では、ラッキーもアクシデントも起こる。"],
  ]},
  {type:"fam", tag:"さいごに", title:"スタート地点は、人それぞれ", items:[
    ["home","はじめに引く<b>家庭カード</b>で、持ちものやまちが変わる。"],
    ["card","家庭カードは<b>みんなに見えている</b>。上の名前を押すと、その人のカードが開く。<b>「とくい」だけは結果発表まで本人だけ</b>。"],
    ["eye","とちゅうで「？？？」の選択肢に出会うかも。それが何なのかは——遊びおわってからのお楽しみ。"],
    ["people","全員ゴールしたら<b>ふりかえりタイム</b>。感じたことを話してみよう。"],
  ]},
];

/* ══ モード ══
   盤面と、長さで変わる決めごとをひとまとめにして持つ。国内版の盤面は1種類だけだが、
   せかい版オンラインと同じ形にしておく（あとから盤面を足すときに、ここへ並べるだけで済む）。
   サーバーは1つの isolate で複数のルームを動かすので、
   「いま選ばれているモード」をモジュール変数に置いてはいけない。必ず引数で渡す（R.mode(g.mode)）。 */
const MODES = {
  full: {
    key:"full",
    label:"16〜45歳・36マス／25分ぐらい",
    SQUARES, AGES, CHAPTERS, ENDINGS,
    maxPlayers:6, minStart:2,
    heavyFrom:8,        /* 重いライフイベントが起こりうるマス */
    settleLoan:true,    /* 45歳のゴールで奨学金の残額を一括清算する */
  },
};
const mode = k => MODES[k] || MODES.full;

export {
  PCOLORS, CHARS, charOf, TYPE_META, FAM_TONE, ic, fm, FAMILIES, startLearn,
  AGES, CHAPTERS, SQUARES, EVENTS, ENDINGS, RULE_PAGES, MODES, mode, regionOf,
  choiceDef, shuffle, jobTitle, unhideTag, hiddenOptionCount, revealTags, applyFx,
  effectiveMoneyReq, effectiveMoneyFx, meetsReq, endingText, heavyDef, letterDef, fairDef,
};
