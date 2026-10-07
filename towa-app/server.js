import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto,{randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import pg from "pg";
const {Pool}=pg;
import {calculateBaziChart} from "@openfate/bazi-engine";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL||"";
const COOKIE_SECURE=process.env.COOKIE_SECURE==="true";
const TARGET_YEAR=Number(process.env.TOWA_TARGET_YEAR||2027);
const PRODUCT_CODE="towa_2027_complete";
const TOWA_PRICE_JPY=Number(process.env.TOWA_PRICE_JPY||2980);
const BETA_PREMIUM_PREVIEW=process.env.TOWA_BETA_PREMIUM_PREVIEW==="true";
const publicDir=path.join(__dirname,"public");
const schema=fs.readFileSync(path.join(__dirname,"schema.sql"),"utf8");
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSLMODE==="disable"?false:{rejectUnauthorized:false},max:6}):null;
let dbReady=false,dbError=null;
if(pool){try{await pool.query(schema);dbReady=true}catch(e){dbError=e.message;console.error(e)}}

const json=(res,status,data)=>{const d=JSON.stringify(data);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(d)});res.end(d)};
const q=async(sql,p=[])=>{if(!pool||!dbReady)throw new Error("DATABASE_NOT_READY");return(await pool.query(sql,p)).rows};
const one=async(sql,p=[])=>(await q(sql,p))[0]||null;
const raw=req=>new Promise((ok,ng)=>{const a=[];req.on("data",c=>a.push(c));req.on("end",()=>ok(Buffer.concat(a)));req.on("error",ng)});
const body=async req=>{const b=await raw(req);return b.length?JSON.parse(b.toString("utf8")):{}};
const cookies=req=>Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const pwh=(p,s)=>crypto.scryptSync(p,Buffer.from(s,"hex"),64).toString("hex");
const setCookie=(res,t)=>res.setHeader("Set-Cookie",["towa_session="+encodeURIComponent(t),"HttpOnly","Path=/","SameSite=Lax","Max-Age=2592000",COOKIE_SECURE?"Secure":""].filter(Boolean).join("; "));
const mime=f=>({".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".webp":"image/webp",".png":"image/png"})[path.extname(f)]||"application/octet-stream";

async function currentUser(req){
  if(!dbReady)return null;
  const t=cookies(req).towa_session;if(!t)return null;
  return one("SELECT u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()",[sha(t)]);
}
async function requireUser(req,res){
  const u=await currentUser(req);
  if(!u){json(res,401,{error:"ログインが必要だよ。"});return null}
  return u;
}
const previewPremium=req=>BETA_PREMIUM_PREVIEW&&new URL(req.url,"http://x").searchParams.get("preview")==="premium";
async function accessFor(req,userId){
  const ent=await one("SELECT status FROM entitlements WHERE user_id=$1 AND product_code=$2 AND status='active'",[userId,PRODUCT_CODE]);
  const entitled=Boolean(ent),preview=previewPremium(req);
  return {premium:entitled||preview,entitled,preview,product_code:PRODUCT_CODE,price_jpy:TOWA_PRICE_JPY,billing:"one_time",auto_renew:false,payment_ready:false};
}
function publicReading(r,access){
 if(!r||access.premium)return r;
 const ev=r.evidence||{};
 return {
  opening:r.opening,
  profile_cards:(r.profile_cards||[]).slice(0,4),
  core:r.core,
  evidence:{day_master:ev.day_master,dominant_element:ev.dominant_element,weak_element:ev.weak_element,interactions:ev.interactions||[]}
 };
}
function makeChart(p){
  const a=p.birth_date.split("-").map(Number);
  const i={year:a[0],month:a[1],day:a[2],gender:p.gender,calendarType:"solar",timezoneId:"Asia/Tokyo",enableTrueSolarTime:false,dayBoundaryMode:"MIDNIGHT_00",daYunTimingVersion:"DAYUN_SECOND_V2"};
  if(p.birth_time_known&&p.birth_time){const t=p.birth_time.split(":").map(Number);i.hour=t[0];i.minute=t[1]}
  return calculateBaziChart(i);
}

const STEM={
 "甲":["wood","yang"],"乙":["wood","yin"],"丙":["fire","yang"],"丁":["fire","yin"],"戊":["earth","yang"],"己":["earth","yin"],"庚":["metal","yang"],"辛":["metal","yin"],"壬":["water","yang"],"癸":["water","yin"]
};
const MAIN={"子":"癸","丑":"己","寅":"甲","卯":"乙","辰":"戊","巳":"丙","午":"丁","未":"己","申":"庚","酉":"辛","戌":"戊","亥":"壬"};
const EJ={wood:"木",fire:"火",earth:"土",metal:"金",water:"水"};
const GEN={wood:"fire",fire:"earth",earth:"metal",metal:"water",water:"wood"};
const CTRL={wood:"earth",earth:"water",water:"fire",fire:"metal",metal:"wood"};
const SO=["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"],BO=["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
const CORE={
 "甲":[
  "あなたは、何となく周りに合わせているように見えても、心の奥では『自分はどうしたいか』をかなりはっきり持っている人。すぐに主張しないのは軸がないからではなく、状況を見て、今ここで言うべきかまで考えているからなんだ。",
  "一度『こっちだ』と決めると、途中で多少うまくいかなくても簡単には投げない。反対に、自分で意味を見いだせないことを長く続けると、表面上はこなせても内側では少しずつ気持ちが離れていきやすい。",
  "あなたに必要なのは、何でも我慢できる強さより、『これは自分が選んだ』と思える納得感。人の期待に応えるだけでなく、自分の成長につながっていると感じられる場所でいちばん力が出る。"
 ],
 "乙":[
  "あなたは、相手や空気に合わせながら進み方を変えられる人。柔らかく見えるけれど、実は『これは好き』『これは違う』という感覚はかなり細やかで、その基準を簡単には手放さない。",
  "正面からぶつかるより、少し角度を変えて通れる道を探すのが得意。そのぶん周囲からは器用に見られやすいけれど、本当は見えないところで何度も微調整している。",
  "無理に強く見せる必要はないよ。あなたの強さは、折れないことではなく、形を変えても自分らしさを失わないことにある。"
 ],
 "丙":[
  "あなたは、気持ちが動いた時の熱量がそのまま行動力につながりやすい人。自分が面白い、やってみたいと思えた瞬間に、周りが驚くくらい一気に進めることがある。",
  "ただし、外から与えられた目標だけでは長く燃え続けにくい。『自分が何のためにやるのか』が見えなくなると、急にエネルギーが落ちたように感じることもある。",
  "あなたにとって大切なのは、常に元気でいることではなく、心が動く対象をちゃんと選ぶこと。明るさは役割ではなく、あなたが納得している時に自然に出るものなんだ。"
 ],
 "丁":[
  "あなたは、誰にでも同じ熱量を向けるより、『大切だ』と思った人や物事に静かに深く熱を注ぐ人。派手には見えなくても、ひとつのことを長く気にかけ続ける力がある。",
  "表面では落ち着いていても、心の中ではかなり細かく感じている。言葉にしないまま抱えていると、周りからは平気そうに見えてしまうこともありそう。",
  "あなたの優しさは、何でも引き受けることじゃない。火を絶やさないためには、自分のための余白も必要だよ。"
 ],
 "戊":[
  "あなたは、簡単には結論を出さない代わりに、一度決めたことを現実の形にしていく力が強い人。周りが先に動いても、自分なりに足場を確かめてから進みたいところがある。",
  "急な変化には少し時間が必要でも、慣れてしまえば腰を据えて続けられる。だからこそ、合わない環境でも『ここまでやったから』と長く残りすぎることには注意して。",
  "続けることはあなたの強み。でも、続ける価値があるかを見直すことも同じくらい大事なんだ。"
 ],
 "己":[
  "あなたは、人や状況をよく見て、足りないところを自然に埋められる人。誰かが困っていると、自分の役割でなくても『ここはやっておこう』と動けることが多い。",
  "その調整力は大きな長所だけれど、周りがそれを当たり前だと思い始めると、あなたの負担だけが静かに増えていく。疲れてから初めて『こんなに抱えてたんだ』と気づくこともある。",
  "あなたが全部を整えなくても大丈夫。誰の課題まで自分が持つのか、その境界線を作るほど本来の優しさが長持ちするよ。"
 ],
 "庚":[
  "あなたは、曖昧なまま長く置いておくより、どこかで線を引いて前へ進みたい人。考える時は考えるけれど、決める段階ではかなり現実的になれる。",
  "筋が通っていないことや、言っていることとやっていることが違う相手には敏感。そこを我慢し続けると、ある日突然『もういい』と気持ちを切り替えることもある。",
  "強さを見せ続けなくていいよ。あなたの判断力は、誰かを切るためではなく、自分が大切にしたいものを守るために使うといちばん生きる。"
 ],
 "辛":[
  "あなたは、細部の違いや空気の変化に気づきやすく、『これくらいでいい』より『ちゃんと納得できる形にしたい』という気持ちを持ちやすい人。",
  "周りからは落ち着いて見えても、内側では何度も考え直したり、言葉を選び直したりしている。だから雑に扱われたり、曖昧な約束が続いたりすると、思っている以上に消耗しやすい。",
  "繊細さは弱さじゃない。何を大切にするかを見分けるセンサーとして使えば、あなたの質の高さになる。"
 ],
 "壬":[
  "あなたは、ひとつの正解だけを見るより、『他にも道があるかもしれない』と視野を広げられる人。環境が変わっても、全体を見ながら新しい流れをつかむ力がある。",
  "その一方で、可能性が多すぎると全部を捨てきれず、決断まで時間がかかることもある。自由が好きだからこそ、自分で選択肢を絞ることが必要になる。",
  "あなたに合うのは、閉じた場所で同じ役割だけを繰り返すことより、考え方や人との出会いが広がっていく環境。動きながら答えを見つける方が自然なんだ。"
 ],
 "癸":[
  "あなたは、迷っているように見えても、本当はずっと内側で答えを作っている人。周りの意見を聞くのは、自分の軸がないからじゃない。相手の反応、空気、先の展開まで見たうえで、自分が納得できる形にしたいからなんだ。",
  "人の表情や言葉の温度差にも気づきやすく、『今は言わない方がいい』『これは少し引っかかる』と、頭より先に感覚で受け取っていることがある。そのぶん考える材料が多くなって、決断が遅く見えることもある。",
  "でも、一度心の中で整理が終わると意外なくらい静かに決められる。あなたに必要なのは『もっと早く決めること』ではなく、考える時間に期限をつけて、十分考えたら自分の答えを信じることなんだ。"
 ]
};
const DOM={
 wood:"木の気が強めだから、現状維持より『どうしたらもっと良くなるか』を考えやすい。何かを育てたり、改善したり、昨日より前へ進んでいる感覚があると気持ちが安定する。反対に、変化も成長も感じられない環境では、理由がなくても息苦しさが出やすい。",
 fire:"火の気が強めだから、気持ちが動いた時の瞬発力と表現力が出やすい。好き嫌いや手応えがエネルギーに直結しやすく、納得できるテーマなら周りを巻き込む力にもなる。ずっと高いテンションを保つ必要はなく、熱を向ける先を選ぶことが大事。",
 earth:"土の気が強めだから、安定・現実性・積み上げを大切にしやすい。すぐ結果が出なくても、意味があると思えば続けられる。一方で、慣れた場所を離れる時には人より準備が必要になりやすいから、『変えない安心』と『変えた先の安心』を両方比べてみて。",
 metal:"金の気が強めだから、自分なりの基準、整理、線引きを大切にしやすい。曖昧な状態をそのままにするより、何が大事で何をやめるのかをはっきりさせるほど頭が軽くなる。厳しさが自分自身に向きすぎないように、完成度より前進を選ぶ日も作って。",
 water:"水の気が強めだから、観察と思考が深く、答えを出す前に多くの情報を受け取る。相手の言葉そのものより、言い方や間、状況の変化まで材料にして考えるところがある。その力は大きな長所だけれど、情報が多すぎると決断が遅くなる。考える時間と決める時間を分けると強みが生きる。"
};
const FLOW={
 "比肩":"『自分で決めたい』気持ちが強まりやすい流れ。周りと比べるより、自分が納得できる基準を作ることがテーマになる。人に任せた方が早い場面でも、最後の判断だけは自分で持っておくと後悔が少ない。",
 "劫財":"人との関わり、競争、役割の入れ替わりが刺激になりやすい流れ。誰と組むかで景色が大きく変わる時だから、勢いだけで人に合わせず、対等でいられる関係を選ぶことが大切。",
 "食神":"無理に結果を急ぐより、自分が自然に続けられることを育てるほど整いやすい流れ。生活の余白や楽しさが、結果的に仕事や人間関係の質まで底上げしてくれる。",
 "傷官":"今までなら我慢できた違和感を、そのまま飲み込みにくくなる流れ。壊したいから気になるのではなく、『もっと自分に合う形がある』と気づき始めている可能性が高い。言葉にして整理してから動くと力になる。",
 "偏財":"人・情報・お金の動きが増えやすい流れ。新しい縁や話が入りやすいぶん、全部を拾おうとすると散らかりやすい。何を増やすかより、誰と何に時間を使うかを選ぶことが運を整える。",
 "正財":"生活、収入、貯蓄、日々の安定を整えるほど安心が増える流れ。派手な変化より、毎月の固定費や働き方、続けられるペースを見直すことが、そのまま未来の余裕につながる。",
 "七殺":"責任やプレッシャーが増えやすく、『やるしかない』場面で力が出やすい流れ。ただ、強い負荷を抱え続けることが成長ではない。挑戦する価値がある負荷と、ただ消耗する負荷を分けて考えて。",
 "正官":"役割、信用、社会との関わりが大きくなりやすい流れ。きちんと形にすることが評価につながりやすい一方で、『ちゃんとしなきゃ』が強くなりすぎることも。責任を持つことと、自分を縛ることは分けていい。",
 "偏印":"今までと違う考え方や学びが入りやすい流れ。昔は興味がなかったことが急に気になったり、これまでの常識を疑いたくなったりする。結論を急がず、試してから残すものを選ぶといい。",
 "正印":"学び直し、準備、知識、人からの助けが力になりやすい流れ。すぐに成果に変わらなくても、今身につけたものがあとで土台になる。ひとりで全部解決しようとせず、頼れる場所を持つことも実力のひとつ。"
};

const MONTH_HINT={
 "比肩":"自分のペースを取り戻す月。人に合わせすぎず、自分で決める余白を残してね。",
 "劫財":"人とのやり取りが増えやすい月。競うより、対等に組める相手を選ぶと整いやすいよ。",
 "食神":"少し力を抜くほど良さが出る月。楽しさや余白を予定に入れてみて。",
 "傷官":"違和感に気づきやすい月。すぐ壊すより、まず言葉にして整理すると力になるよ。",
 "偏財":"人・情報・お金が動きやすい月。全部拾わず、誰と何に時間を使うかを選んで。",
 "正財":"暮らしとお金を整える月。固定費や予定を見直すと安心が増えやすいよ。",
 "七殺":"忙しさや責任が増えやすい月。頑張れることと、背負うべきことを分けてね。",
 "正官":"役割や信用を意識しやすい月。きちんとするほど、自分の余白も一緒に守って。",
 "偏印":"新しい考え方に惹かれやすい月。結論を急がず、まず小さく試してみて。",
 "正印":"学びや助けを受け取りやすい月。ひとりで抱えず、頼れるものを使っていいよ。"
};
const ELEMENT_STYLE={
 wood:{colors:["深いグリーン","青緑","セージ"],sub:"生成り",materials:["木","リネン","植物"],way:"服を全部変えなくていいよ。ハンカチ、スマホ背景、デスクの小物みたいな小さい面積から緑を足してみて。",sense:"伸びる余白を作る"},
 fire:{colors:["コーラル","赤","やわらかい紫"],sub:"暖色のベージュ",materials:["暖色の光","柔らかな布","あたたかい質感"],way:"強い赤を無理に着なくても大丈夫。小物や照明など『少し温度を感じる色』から取り入れてみて。",sense:"気持ちを外へ動かす"},
 earth:{colors:["サンドベージュ","黄土色","ブラウン"],sub:"アイボリー",materials:["陶器","石","コットン"],way:"毎日触るものに落ち着いた土色をひとつ置いてみて。バッグや財布、マグカップくらいで十分だよ。",sense:"足元を整える"},
 metal:{colors:["白","シルバー","ライトグレー"],sub:"淡いゴールド",materials:["金属","ガラス","すっきりした直線"],way:"アクセサリーや時計、スマホケースみたいな小物に白やシルバーを足すと取り入れやすいよ。",sense:"境界線をはっきりさせる"},
 water:{colors:["ネイビー","黒","深いブルー"],sub:"透明感のあるグレー",materials:["ガラス","水のモチーフ","落ち着いた光沢"],way:"黒一色にする必要はないよ。ネイビーの小物や背景、透明なガラス素材を少し置くくらいからで十分。",sense:"立ち止まって考える余白を作る"}
};

function monthGuide(dayMaster,year){
 const names=["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
 return names.map((label,i)=>{
  let p=null;
  try{
   const x=calculateBaziChart({year,month:i+1,day:15,hour:12,minute:0,gender:"male",calendarType:"solar",timezoneId:"Asia/Tokyo",enableTrueSolarTime:false,dayBoundaryMode:"MIDNIGHT_00",daYunTimingVersion:"DAYUN_SECOND_V2"});
   p=x?.pillars?.month||null;
  }catch{}
  const god=p?tenGod(dayMaster,p.stem):"";
  return{month:i+1,label,pillar:p?p.stem+p.branch:null,theme:god||"整える",text:MONTH_HINT[god]||"予定を詰めすぎず、今の自分に合うペースを確かめる月として使ってみて。"};
 });
}
function threeYearGuide(dayMaster){
 return [TARGET_YEAR,TARGET_YEAR+1,TARGET_YEAR+2].map(y=>{
  const gz=yearGZ(y),sg=tenGod(dayMaster,gz.stem),bg=tenGod(dayMaster,MAIN[gz.branch]);
  return{year:y,pillar:gz.stem+gz.branch,theme:sg+" × "+bg,text:(MONTH_HINT[sg]||"自分の基準を整える流れ。")+" 1年を決めつける予言ではなく、意識に上がりやすいテーマとして見てね。"};
 });
}
function actionGuide(s,c,dy){
 const weak=s.weak?.[0]||"earth",dom=s.dom?.[0]||"water",style=ELEMENT_STYLE[weak]||ELEMENT_STYLE.earth;
 return{
  towa_line:"じゃあ、今のあなたが意識するとよさそうなことを、3つずつに絞るね。",
  add:[
   {title:"自分の基準を3つ書く",text:"仕事でも人間関係でも、『これだけは守りたい』を3つだけ言葉にしてみて。迷った時の戻り場所になるよ。"},
   {title:EJ[weak]+"の感覚を少し足す",text:"命式では"+EJ[weak]+"が相対的に控えめ。日常では「"+style.sense+"」ことを意識すると、いつもの得意なやり方に別の視点を足しやすいよ。"},
   {title:"小さく試してから決める",text:dy?"今は"+dy.ganZhi+"大運の途中。大きく決める前に、1週間・1か月だけ試せる形を作ってみて。":"大きな答えを一度に出さず、まず小さく試してから残すものを選んでみて。"}
  ],
  reduce:[
   {title:"全部にすぐ答えること",text:"返事を急がなくていい場面では、一度持ち帰って考える時間を作って。"},
   {title:"違和感を小さいまま飲み込むこと",text:(c.interactions||[]).length?"命式には組み替える力も見えるよ。小さな違和感のうちに、距離や役割を調整してみて。":"『まあいいか』が続く時ほど、一度自分の本音を確認してみて。"},
   {title:EJ[dom]+"のやり方だけで押し切ること",text:"得意な力は大切。でも強い要素だけで全部を解こうとすると疲れやすい。別のやり方をひとつ混ぜてみて。"}
  ]
 };
}
function balanceStyle(s){
 const weak=s.weak?.[0]||"earth",dom=s.dom?.[0]||"water",x=ELEMENT_STYLE[weak]||ELEMENT_STYLE.earth;
 return{
  label:"BALANCE",title:"あなたを整える色とスタイル",element:EJ[weak],dominant:EJ[dom],
  towa_line:"命式のバランスを見ると、"+EJ[weak]+"を象徴する色や質感を少し足してあげるのが似合いそう。",
  colors:x.colors,sub_color:x.sub,materials:x.materials,way:x.way,
  note:"これは『この色を持てば必ず運が上がる』という意味じゃないよ。五行のバランスを日常で意識するための、小さな合図として使ってみて。"
 };
}

function tenGod(day,other){
 const a=STEM[day],b=STEM[other];if(!a||!b)return"";
 const same=a[1]===b[1];
 if(a[0]===b[0])return same?"比肩":"劫財";
 if(GEN[a[0]]===b[0])return same?"食神":"傷官";
 if(CTRL[a[0]]===b[0])return same?"偏財":"正財";
 if(CTRL[b[0]]===a[0])return same?"七殺":"正官";
 if(GEN[b[0]]===a[0])return same?"偏印":"正印";
 return"";
}
function yearGZ(y){return{year:y,stem:SO[((y-4)%10+10)%10],branch:BO[((y-4)%12+12)%12]}}
function stats(c){
 const e={wood:0,fire:0,earth:0,metal:0,water:0},g={};
 for(const k of ["year","month","day","hour"]){const p=c.pillars&&c.pillars[k];if(!p)continue;
   if(STEM[p.stem])e[STEM[p.stem][0]]+=2;if(p.branchElement)e[p.branchElement]+=2;
   if(p.stemTenGod&&p.stemTenGod!=="日主")g[p.stemTenGod]=(g[p.stemTenGod]||0)+2;
   for(const h of p.hiddenStems||[]){if(STEM[h.stem])e[STEM[h.stem][0]]++;if(h.tenGod)g[h.tenGod]=(g[h.tenGod]||0)+1}
 }
 const s=Object.entries(e).sort((a,b)=>b[1]-a[1]);return{e,g,dom:s[0],weak:s[s.length-1]};
}
function currentDY(c){
 const y=new Date().getFullYear();return(c.daYun&&c.daYun.cycles||[]).find(x=>y>=x.startYear&&y<=x.endYear)||null;
}
function profilePhrase(kind,n){
 if(kind==="thought")return n>=10?"深く考えてから決める":n>=7?"整理してから動く":n>=4?"考えながら整える":"まず動いて確かめる";
 if(kind==="expression")return n>=7?"言葉や形にして伝える":n>=4?"必要な時に伝える":"内側で熟成してから伝える";
 if(kind==="responsibility")return n>=7?"任されると最後まで背負う":n>=4?"必要な分だけ引き受ける":"自分のペースを守る";
 if(kind==="learning")return n>=7?"経験をすぐ次に生かす":n>=4?"経験を自分なりに整える":"時間をかけて腑に落とす";
 return"自分のペースで整える";
}
function cards(c,s,dy){
 const out=(s.g["食神"]||0)+(s.g["傷官"]||0),auth=(s.g["正官"]||0)+(s.g["七殺"]||0),res=(s.g["正印"]||0)+(s.g["偏印"]||0);
 const thought=(s.e.water||0)+Math.round((s.e.metal||0)/2);
 const trans=dy&&Math.abs(new Date().getFullYear()-dy.startYear)<=1?"基準が切り替わる時":dy?"積み上げを選び直す時":"今の流れを確認中";
 return[
  {label:"考え方",value:profilePhrase("thought",thought),note:"情報を受け取って答えを作る"},
  {label:"伝え方",value:profilePhrase("expression",out),note:"考えを外へ出すペース"},
  {label:"責任との距離",value:profilePhrase("responsibility",auth),note:"役割をどこまで持つか"},
  {label:"学び方",value:profilePhrase("learning",res),note:"経験を次に変える方法"},
  {label:"今の流れ",value:trans,note:dy?dy.ganZhi+"大運":"大運を確認中"}
 ];
}
function scores(s,c){
 const g=s.g,n=(c.interactions||[]).length;
 return[
  {key:"work",title:"仕事・才能",score:(g["正官"]||0)+(g["七殺"]||0)+(g["正印"]||0)+(g["偏印"]||0)+(g["食神"]||0)+(g["傷官"]||0)},
  {key:"money",title:"お金・現実",score:(g["正財"]||0)+(g["偏財"]||0)+Math.round(((g["食神"]||0)+(g["傷官"]||0))/2)},
  {key:"love",title:"恋愛・距離感",score:(g["正財"]||0)+(g["偏財"]||0)+(g["正官"]||0)+(g["七殺"]||0)+n},
  {key:"people",title:"人間関係",score:(g["比肩"]||0)+(g["劫財"]||0)+n+2}
 ].sort((a,b)=>b.score-a.score);
}
function topic(t,s,c,dy){
 const g=s.g,dyName=dy?dy.ganZhi+"大運":"今の流れ";
 if(t.key==="work")return{
  title:t.title,score:t.score,
  towa_line:"頑張れる仕事より、『自分の判断がちゃんと生きる仕事』を選ぶ方が、あなたは長く力を出せる。",
  paragraphs:[
   "仕事で大事なのは、単純に忙しいか楽かではなさそう。自分で考えたことを反映できる余地があるか、納得できる理由があるか、その二つがかなり重要になる。指示通りにこなすだけの状態が続くと、表面では問題なく働けても、内側では『ここにいる意味は何だろう』という感覚が少しずつ強くなりやすい。",
   ((g["食神"]||0)+(g["傷官"]||0))>3?"命式には、自分の考えを言葉や形にして外へ出す力も見える。企画、改善、説明、提案のように『自分なりの視点を足せる仕事』では、ただ作業する時より手応えを感じやすい。":"派手に前へ出る必要はないけれど、自分なりに工夫できる余地があるほど仕事への納得感が上がりやすい。",
   ((g["正官"]||0)+(g["七殺"]||0))>3?"一方で責任感も弱くない。任されると途中で放り出さず、期待以上にやろうとしやすい。その長所が『断れない』『自分だけが抱える』に変わると消耗するから、責任の範囲を最初に決めることが大切。":"何でも背負うより、得意な部分で信頼を積み上げる方が長く続く。",
   dyName+"では、肩書きや給料だけでなく、裁量、人間関係、生活リズムまで含めて判断してみて。転職するか残るかの二択より、『今の環境で何が変われば続けたいと思えるか』を先に書き出すと、自分の本音が見えやすい。"
  ],
  note:"向いている職業名を探すより、『どんな条件なら自分の力が長く出るか』を3つ言葉にしてみて。"
 };
 if(t.key==="money")return{
  title:t.title,score:t.score,
  towa_line:"あなたにとってお金は、ただ増やすものというより『選べる余白を守るもの』に近い。",
  paragraphs:[
   "お金への安心感は、残高の大きさだけでは決まりにくい。先の予定が見えているか、毎月どれくらい残るか、自分が使っていい範囲が分かっているか。そういう『見通し』があるほど気持ちが落ち着きやすい。",
   ((g["正財"]||0)+(g["偏財"]||0))>3?"命式では財の要素も比較的意識されやすい。稼ぐことだけでなく、何に使うか、誰と共有するかまで含めてお金を考えやすいから、収入が増えてもルールが曖昧だと安心しきれないことがある。":"大きく増やすことより、無理なく続けられる管理の形を作る方が合っている。",
   "固定費、貯めるお金、自由に使っていいお金を最初から分けると、使うたびに罪悪感を持たずに済む。逆に、全部を『なるべく使わない』で管理すると、反動で一気に使いたくなることもある。",
   "運勢を理由に投資や大きな買い物を決める必要はないよ。TOWAが見るのは、お金との付き合い方の癖まで。実際の判断は、収入・支出・契約条件・リスクを数字で確認してからにしよう。"
  ],
  note:"『いくら増やしたいか』より先に、『いくらあれば安心して選べるか』を決めてみて。"
 };
 if(t.key==="love")return{
  title:t.title,score:t.score,
  towa_line:"好きになるほど、近づきたい気持ちと『ちゃんと見極めたい』気持ちが同時に動きやすい。",
  paragraphs:[
   "最初から全部を見せて一気に距離を縮めるより、相手の反応を見ながら少しずつ心を開いていく方が自然。だから関係の始まりでは慎重に見えても、一度『この人なら大丈夫』と思うと、思っている以上に深く相手を気にかける。",
   "そのぶん、相手の言葉や態度の小さな変化にも気づきやすい。返信の速さや声の温度まで材料にして、『何か変わったのかな』と自分の中で考え続けてしまうこともありそう。でも、気づいたことが全部相手の本音とは限らない。",
   "恋愛で疲れやすいのは、相手を好きだからというより、相手の気持ちまで自分の中で先回りして考え続ける時。『私はこう感じた』『これは少し不安だった』を小さいうちに言葉にできる関係の方が、あなたは安心して長く続けられる。",
   "大切なのは、相手に合わせられるかではなく、合わせなくても嫌われないと思えるか。あなたにとって信頼は、刺激の強さより『本音を出しても関係が壊れない経験』から育っていく。"
  ],
  note:"相手の気持ちを当てるより、自分がその関係で安心できているかを先に見て。"
 };
 return{
  title:t.title,score:t.score,
  towa_line:"人に合わせられることと、誰にでも心を開くことは、あなたの中ではまったく別のこと。",
  paragraphs:[
   "周りをよく見られるから、その場がうまく回るように自分が少し引いたり、相手が言いやすい方へ合わせたりできる。外から見ると『人付き合いが上手』に見えやすいけれど、それは何も感じていないからではなく、むしろ多くを感じ取っているからできることなんだ。",
   "問題は、その調整を長く続けた時。最初は小さな違和感だったのに、ある日突然『もう無理かも』と感じることがある。突然冷めたように見えても、実際にはそこまでに何度も小さく我慢している場合が多い。",
   (c.interactions||[]).length?"命式には、関係や環境の中で『一度組み替える』力も見える。これは人間関係が悪いという意味ではないよ。合わない形を続けるより、距離や役割を調整した方が自分らしさを取り戻しやすい、という読み方ができる。":"あなたは、誰とでも同じ距離で付き合う必要はない。自然体でいられる相手と、礼儀だけで十分な相手を分けていい。",
   "人間関係を大切にすることと、自分を後回しにすることは同じじゃない。断る、返事を待つ、少し距離を置く。そういう小さな境界線を作れるほど、残したい関係はむしろ長く続きやすい。"
  ],
  note:"優しさと我慢を同じものにしなくていい。『無理をしなくても続く関係』を基準にして。"
 };
}
function reading(c,name){
 const s=stats(c),dy=currentDY(c),dm=c.dayMaster?.char||c.pillars?.day?.stem,base=CORE[dm]||["自分の内側に基準を持つ人。","納得してから進む方が力を出しやすい。","自分のペースを守ることが大切。"];
 const interactions=c.interactions||[],ny=yearGZ(TARGET_YEAR),sg=tenGod(dm,ny.stem),bg=tenGod(dm,MAIN[ny.branch]);
 const topics=scores(s,c).map(x=>topic(x,s,c,dy)),next=(c.daYun?.cycles||[]).find(x=>dy&&x.startYear>dy.startYear);
 const months=monthGuide(dm,TARGET_YEAR),years=threeYearGuide(dm),actions=actionGuide(s,c,dy),style=balanceStyle(s);
 const nowYear=new Date().getFullYear(),isShift=dy&&Math.abs(nowYear-dy.startYear)<=1;
 const interactionCopy=interactions.length
  ?"命式の中には、ものごとを一度そのまま受け入れて終わりにするより、『本当にこの形でいいのか』と考え直す動きもある。だから人生の節目では、周りがまだ続けられると思っている時でも、自分の中では先に次の形を考え始めていることがある。これは不安定さではなく、違和感を放置せず組み替える力として使える。"
  :"命式全体を見ると、急いで自分を変えるより、自分に合う環境やペースを選ぶことで本来の良さが出やすい。";
 const openingName=name&&name.length<=12&&!/@/.test(name)?name+"さん、":"";
 return{
  engine:"towa-rules-v0.14",
  opening:openingName+"生まれた日の暦から、まずは変わりにくいあなたの部分を見てみたよ。これは『あなたは絶対こういう人』と決めつける答えじゃないよ。読んでいて、妙にしっくりくるところだけ大事にしてね。",
  profile_cards:cards(c,s,dy),
  core:{
   label:"CORE",title:"あなたの核",
   towa_line:dm==="癸"?"あなたは、迷っているように見えても、本当はずっと内側で答えを作っている人。":"あなたの中には、周りからは見えにくい『自分だけの基準』がちゃんとある。",
   paragraphs:[
    base[0],
    base[1],
    base[2],
    DOM[s.dom[0]],
    "反対に、五行では"+EJ[s.weak[0]]+"の要素が相対的に控えめ。これは『欠けているから悪い』という話ではないよ。自分の得意なやり方だけで進むと偏りやすい場面で、意識して別の視点を足すとバランスが取りやすい、というヒントとして見て。",
    interactionCopy
   ],
   note:"変えるべき欠点を探すより、『自分はどういう時に力が出て、どういう時に消耗するか』を知る方がずっと役に立つ。"
  },
  flow:{
   label:"FLOW",title:"今のあなた",
   towa_line:dy?"今は「"+dy.ganZhi+"」の大きな流れの中。"+(isShift?"ちょうど選び方の基準が切り替わりやすい時期だよ。":"今まで積み上げたものを、次にどう使うかが大事になってくる。"):"今の流れを、焦らず現実と重ねて見ていこう。",
   paragraphs:dy?[
    "今の大きな流れは"+dy.ganZhi+"大運。"+dy.startYear+"年から"+dy.endYear+"年まで続く10年単位のテーマとして見るよ。大運は『この10年に必ずこうなる』という予言ではなく、どんな課題や選択を意識しやすいかを見る背景みたいなもの。",
    FLOW[dy.stemTenGod]||"今は、自分の基準を整えながら次の形へ移ることがテーマになりやすい。",
    isShift?"この大運は始まったばかり。だから最近、前なら我慢できたことが急に気になったり、今までのやり方に違和感が出たりしても不思議じゃない。環境が急に悪くなったというより、自分の側の『これから大切にしたい基準』が変わり始めている可能性がある。":"今は、何かをゼロから壊すことより、ここまで積み上げた経験の中から『次にも持っていくもの』と『もう手放していいもの』を分ける時。全部を変える必要はないよ。",
    "こういう時期は、答えを急ぐと『今すぐ辞めるか、このまま耐えるか』の二択になりやすい。でも実際には、距離を変える、役割を減らす、準備を始める、期限を決める、という中間の選択肢もある。運を見る時ほど、現実の選択肢を増やしておこう。",
    "最近繰り返し気になるテーマがあるなら、それを無視しないで。何度も戻ってくる違和感は、単なる気分ではなく、今の自分が次に必要としている条件を教えていることがある。"
   ]:["今の流れは、現実の状況と合わせて少しずつ見ていこう。"],
   note:"『何を始めるべき？』より、『もう何を無理して続けなくていい？』から考えると、今の流れが見えやすい。"
  },
  path:{
   label:"PATH",title:"あなたの選び方",
   towa_line:"人生の全部を同じ重さで抱えなくていい。今のあなたが意識しやすいテーマから、順番に見ていこう。",
   ordered_topics:topics,
   note:"この順番は良い・悪いの順位じゃないよ。命式の中で『意識に上がりやすいテーマ』を前に出しているだけ。"
  },
  turning_point:{
   label:"TURNING POINT",title:"流れが変わる時",
   towa_line:"あなたの転機は、突然何かが起こる日より、『もう同じ選び方では進めない』と自分で気づくところから始まりやすい。",
   paragraphs:[
    dy?"今の"+dy.ganZhi+"大運は"+dy.startYear+"年から"+dy.endYear+"年まで。10年全部が同じ状態になるわけではないけれど、この期間を通して繰り返し向き合いやすいテーマがある。今の選択は、その長い流れの途中にあるひとつの場面として見てみて。":"大きな節目は、ひとつの出来事だけで決まるものではないよ。",
    isShift?"特に今は大運が切り替わった直後だから、『前まではこれでよかったのに、なぜかもうしっくりこない』という感覚が出やすい。これは過去の選択が間違いだったという意味ではなく、その選択が役目を終え始めた可能性がある。":"転機は、外側の事件より先に、内側の基準が変わることから始まる場合が多い。",
    next?"次の大きな大運の切り替わりは"+next.startYear+"年ごろ。だから今すぐ人生の完成形を決めなくていい。そこまでの間に、何を経験して、何を身につけて、何を減らしておきたいか。その積み重ねの方が大切。":"今は目の前の選択を整えることを優先して。",
    interactionCopy,
    "『転機の年だから何か悪いことが起こる』という読み方はしないよ。運は命令ではなく、選択肢を見るための背景。現実の仕事、お金、家族、体調、約束をいちばん大切にしながら使ってね。"
   ],
   note:"転機は、人生が勝手に変わる時ではなく、『自分の基準を更新する時』として使うと怖くない。"
  },
  next:{
   label:"NEXT",title:TARGET_YEAR+"年のあなた",
   towa_line:TARGET_YEAR+"年は"+ny.stem+ny.branch+"。あなたにとって「"+sg+"」と「"+bg+"」のテーマが重なる一年として読むよ。",
   paragraphs:[
    "まず天干の"+ny.stem+"は、あなたにとって"+sg+"。"+(FLOW[sg]||"新しいテーマを意識しやすい。"),
    "地支の"+ny.branch+"を主な気で見ると"+bg+"。ひとつの年には複数の要素があるから、これだけで出来事を決めつけることはしない。でも、どんな場面で自分の癖が出やすいかを見るヒントにはなる。",
    sg=== "偏財"||sg==="正財"?"お金や人とのやり取りがテーマに入りやすい年だからこそ、『増やすこと』だけを目標にしなくていい。誰と組むか、どこに時間を使うか、どんな支出なら自分の未来につながるかまで一緒に見ると判断しやすい。":"一年のテーマを、目標の数ではなく『どんな選択を増やしたいか』で決めると使いやすい。",
    bg==="七殺"||bg==="正官"?"責任や役割を引き受ける場面では、期待に全部応えようとする前に、期限・範囲・見返りを確認して。頑張れることと、背負うべきことは同じじゃない。":"人の期待より、自分が続けられるペースを基準にして。",
    TARGET_YEAR+"年に向けて今からできる準備は、大きな決断を先回りすることではない。『これだけは続けたい』『これは減らしたい』『ここまでは試したい』という3つの基準を持っておくこと。それだけで流れに振り回されにくくなる。",
    "年運だけで人生は決まらないよ。仕事の条件、家計、健康、家族との予定、契約の内容。そういう現実の情報を主役にして、TOWA MAPは最後の補助線として使ってね。"
   ],
   note:TARGET_YEAR+"年の目標を10個作るより、『これだけは育てたい』をひとつ決める方が、あなたには合っているかもしれない。"
  },
  year_calendar:{
   label:"12 MONTHS",title:TARGET_YEAR+"年、12か月の流れ",
   towa_line:"一年をひとまとめにせず、月ごとに少しずつ見てみよう。予定を決める答えじゃなく、立ち止まるタイミングを作るために使ってね。",
   months,
   note:"月運は節入りで切り替わるため、ここでは各月の中頃を基準にした目安として見ているよ。"
  },
  three_years:{
   label:"3 YEARS",title:"これから3年の大きな流れ",
   towa_line:"来年だけじゃなく、少し先まで並べると『今すぐ決めなくていいこと』も見えやすくなるよ。",
   years,
   note:"年運だけで出来事は決まらないよ。大きな予定や契約は、現実の条件をいちばん大切にしてね。"
  },
  action_guide:actions,
  balance_style:style,
  letter:{
   label:"LETTER",title:"TOWAからあなたへ",
   towa_line:dm==="癸"?"考えすぎる自分を、敵にしなくていい。あなたは、考えることで自分を守り、納得できる道を探してきた人だから。":"自分のペースで答えを作ることを、弱さだと思わなくていい。",
   paragraphs:[
    dm==="癸"?"あなたは、見て、感じて、比べて、それから自分なりの答えを作る人。周りより決めるまで時間がかかる場面があっても、それは何も考えていないからじゃない。むしろ、考える材料を人より多く拾ってしまうからなんだ。":base[0],
    "たぶん今までにも、『もっと早く決めればよかった』『気にしすぎたかも』と思ったことがあるはず。でも、その慎重さのおかげで避けられたことや、守れた関係もあったと思う。だから全部を直そうとしなくていい。必要なのは、考えることをやめることではなく、考え終わるタイミングを自分で決めること。",
    dy?"今は"+dy.ganZhi+"大運の中にいる。前と同じ基準が合わなくなってきたなら、それはあなたがわがままになったからではなく、これから守りたいものが変わってきたからかもしれない。":"今の自分が何を大切にしたいかを、少しずつ確かめていけばいい。",
    "答えが100％完成するまで待たなくても大丈夫。七割くらい納得できたら小さく試して、違ったら戻って考え直す。そのくらいの進み方なら、あなたの慎重さも行動力も両方捨てずに済む。",
    "この地図は、あなたを型にはめるためのものじゃない。迷った時に『私は何を大切にしたかったんだっけ』と思い出すための場所。何かが変わったら、またここに戻ってきて。前のあなたと今のあなたを並べながら、続きを一緒に見ていこう。"
   ],
   note:"『自分のこと、ちょっと分かったかも。』今日はそれだけ持って帰ってくれたら十分だよ。"
  },
  evidence:{day_master:dm,dominant_element:EJ[s.dom[0]],weak_element:EJ[s.weak[0]],current_dayun:dy?dy.ganZhi:null,target_year:ny.stem+ny.branch,interactions:interactions.map(x=>x.description)},
  guided_topics:["work","money","love","people","now"]
 };
}
function guidance(c,k){
 const s=stats(c),dy=currentDY(c);
 if(k==="now")return{
  title:"今の流れ",
  towa_line:dy?"今は"+dy.ganZhi+"大運の中。答えを急ぐより、『今までと何が変わったか』を見る時だよ。":"今の優先順位を一緒に整理してみよう。",
  paragraphs:[
   dy?(FLOW[dy.stemTenGod]||"自分の基準を整えながら次へ進む時。"):"まずは目の前の現実をひとつずつ整理しよう。",
   dy&&Math.abs(new Date().getFullYear()-dy.startYear)<=1?"大運が切り替わったばかりだから、前まで普通にできていたことに急に違和感が出ても不思議じゃない。すぐに結論を出すより、『何が嫌になったのか』『代わりに何を大切にしたくなったのか』を分けて考えてみて。":"今の悩みを一気に解決しようとしなくていい。変えられること、まだ変えられないこと、今週だけ試せることの3つに分けると動きやすい。",
   "今週や今月の予定を見ながら、ひとつだけ減らすものと、ひとつだけ残すものを決めてみて。運を見る目的は、予定を増やすことではなく、自分の時間をどこへ戻すかを考えることだから。"
  ],
  note:"『何を始める？』より先に、『何をもう頑張らなくていい？』を考えてみて。"
 };
 const t=scores(s,c).find(x=>x.key===k)||scores(s,c)[0];
 return topic(t,s,c,dy);
}

async function register(req,res){
 try{const b=await body(req),email=String(b.email||"").trim().toLowerCase(),name=String(b.display_name||"").trim(),pw=String(b.password||"");if(!email.includes("@")||!name||pw.length<8)throw new Error("入力を確認してね。");const salt=crypto.randomBytes(16).toString("hex"),id=randomUUID();await pool.query("INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES($1,$2,$3,$4,$5)",[id,email,name,salt,pwh(pw,salt)]);const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),id]);setCookie(res,t);json(res,201,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function login(req,res){
 try{const b=await body(req),u=await one("SELECT * FROM users WHERE email=$1",[String(b.email||"").trim().toLowerCase()]);if(!u||pwh(String(b.password||""),u.password_salt)!==u.password_hash)return json(res,401,{error:"メールアドレスかパスワードが違うみたい。"});const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),u.id]);setCookie(res,t);json(res,200,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function me(req,res){
 const u=await requireUser(req,res);if(!u)return;
 const access=await accessFor(req,u.id);
 const bp=await one("SELECT gender,birth_date::text,birth_time::text,birth_time_known FROM birth_profiles WHERE user_id=$1",[u.id]);
 const sp=await one("SELECT chart_json FROM saju_profiles WHERE user_id=$1",[u.id]);
 const rr=await one("SELECT report_json,model_name,created_at FROM reading_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[u.id]);
 json(res,200,{user:u,birth_profile:bp,chart:sp?.chart_json||null,access,latest_report:rr?{reading:publicReading(rr.report_json,access),engine:rr.model_name,created_at:rr.created_at}:null});
}
async function makeReading(req,res){
 const u=await requireUser(req,res);if(!u)return;
 try{
  const b=await body(req),p=b.profile;
  if(!p||!["male","female"].includes(p.gender)||!/^\d{4}-\d{2}-\d{2}$/.test(p.birth_date||""))throw new Error("出生情報を確認してね。");
  const c=makeChart(p);
  await pool.query("INSERT INTO birth_profiles(user_id,gender,birth_date,birth_time,birth_time_known) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET gender=EXCLUDED.gender,birth_date=EXCLUDED.birth_date,birth_time=EXCLUDED.birth_time,birth_time_known=EXCLUDED.birth_time_known,updated_at=NOW()",[u.id,p.gender,p.birth_date,p.birth_time_known?p.birth_time:null,Boolean(p.birth_time_known)]);
  await pool.query("INSERT INTO saju_profiles(user_id,engine_version,chart_json) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET engine_version=EXCLUDED.engine_version,chart_json=EXCLUDED.chart_json,calculated_at=NOW()",[u.id,"@openfate/bazi-engine@2.0.0",JSON.stringify(c)]);
  const r=reading(c,u.display_name),access=await accessFor(req,u.id);
  await pool.query("INSERT INTO reading_reports(id,user_id,report_json,model_name) VALUES($1,$2,$3,$4)",[randomUUID(),u.id,JSON.stringify(r),"towa-rules-v0.14"]);
  json(res,200,{chart:c,reading:publicReading(r,access),access,engine:"towa-rules-v0.14",api_cost_jpy:0});
 }catch(e){json(res,500,{error:e.message})}
}
async function guide(req,res){
 const u=await requireUser(req,res);if(!u)return;
 const b=await body(req),sp=await one("SELECT chart_json FROM saju_profiles WHERE user_id=$1",[u.id]);
 if(!sp)return json(res,400,{error:"先にTOWA MAPを作ってね。"});
 const allowed=["work","money","love","people","now"],k=allowed.includes(b.topic)?b.topic:"now";
 const access=await accessFor(req,u.id);
 if(!access.premium)return json(res,402,{error:"もう少し深い話は、完全鑑定で一緒に見られるよ。",access});
 json(res,200,{topic:k,answer:guidance(sp.chart_json,k),access,engine:"towa-rules-v0.14",api_cost_jpy:0});
}
function staticFile(req,res){
 let p=new URL(req.url,"http://x").pathname;if(p==="/")p="/index.html";
 const f=path.join(publicDir,path.normalize(p).replace(/^[/\\]+/,""));
 if(!f.startsWith(publicDir))return json(res,403,{error:"forbidden"});
 fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end("Not found");return}res.writeHead(200,{"Content-Type":mime(f),"Cache-Control":f.endsWith(".html")?"no-store":"public, max-age=3600"});res.end(d)});
}
const server=http.createServer(async(req,res)=>{
 const p=new URL(req.url,"http://x").pathname;
 if(req.method==="GET"&&p==="/api/health")return json(res,200,{ok:true,version:"0.14",database_ready:dbReady,database_error:dbError,interpretation_engine:"towa-rules-v0.14",openai_required:false,api_cost_jpy:0,target_year:TARGET_YEAR});
 if(req.method==="GET"&&p==="/api/access"){const u=await requireUser(req,res);if(!u)return;return json(res,200,{access:await accessFor(req,u.id)});}
 if(req.method==="POST"&&p==="/api/auth/register")return dbReady?register(req,res):json(res,503,{error:"DB接続待ち"});
 if(req.method==="POST"&&p==="/api/auth/login")return dbReady?login(req,res):json(res,503,{error:"DB接続待ち"});
 if(req.method==="GET"&&p==="/api/me")return me(req,res);
 if(req.method==="POST"&&p==="/api/reading")return makeReading(req,res);
 if(req.method==="POST"&&p==="/api/guidance")return guide(req,res);
 if(req.method==="GET")return staticFile(req,res);
 res.writeHead(405);res.end();
});
server.listen(PORT,()=>console.log("TOWA v0.14 listening on "+PORT+" dbReady="+dbReady+" rulesEngine=true apiCost=0 paywall=true"));
