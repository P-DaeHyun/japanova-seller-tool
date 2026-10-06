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
 "甲":["まっすぐ伸びる木のように、自分の中に軸を持ちやすい。","納得できないことまで飲み込むより、自分なりの理由を持って進む方が力が出る。"],
 "乙":["しなやかに周囲を見ながら進み方を変えられる。","柔らかく見えても、美意識や譲れない感覚ははっきりしている。"],
 "丙":["気持ちが動いた時の明るさと推進力が強い。","自分が納得して動けると周りまで温める。"],
 "丁":["大切な人や物事へ静かに熱を注ぐ。","広く目立つより、届いてほしい相手に深く届くことを大事にする。"],
 "戊":["簡単には揺れず、時間をかけて形にする。","決めるまでは慎重でも、一度腹を決めると粘り強い。"],
 "己":["相手や状況に合わせながら育てる力がある。","調整役を引き受けすぎると、自分の疲れに気づくのが遅くなる。"],
 "庚":["判断と行動をはっきりさせやすい。","曖昧な状態が続くより、答えを出して前へ進みたい。"],
 "辛":["細部や質に敏感で、自分なりの基準を大切にする。","見せる以上に内側では繊細に考えている。"],
 "壬":["視野を広く持ち、状況に応じて道を変えられる。","可能性が開いている環境ほど力を出しやすい。"],
 "癸":["雨や霧のように、静かに周囲を感じ取りながら深く考える。","相手の反応や空気まで読んでから動くことが多い。"]
};
const DOM={
 wood:"木が強め。成長や改善を考える力が出やすい。",
 fire:"火が強め。気持ちが動いた時の瞬発力と表現力が出やすい。",
 earth:"土が強め。安定や現実性、積み上げを大切にしやすい。",
 metal:"金が強め。判断基準や整理、線引きを大切にしやすい。",
 water:"水が強め。観察と思考が深く、答えを出す前に多くの情報を受け取る。"
};
const FLOW={
 "比肩":"自分で決めることがテーマになりやすい。",
 "劫財":"人との関わりや役割の入れ替わりが刺激になりやすい。",
 "食神":"急ぐより、得意なことを自然に続けるほど整いやすい。",
 "傷官":"今まで我慢できたことに違和感が出やすい。壊す前に言葉にして整理して。",
 "偏財":"人・情報・お金が動きやすい。全部に反応せず選ぶ基準を。",
 "正財":"生活や収入、現実的な安定を整えるほど安心が増える。",
 "七殺":"責任やプレッシャーが成長のきっかけになりやすい。扱える負荷を選んで。",
 "正官":"役割や信用、社会との関わりが大きくなりやすい。",
 "偏印":"今までと違う見方や学びが入りやすい。",
 "正印":"学び直し、準備、支えてくれる人との縁が力になりやすい。"
};

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
function level(n){return n>=10?"とても強い":n>=7?"強い":n>=4?"しっかり":n>=2?"ほどよい":"静か"}
function cards(c,s,dy){
 const out=(s.g["食神"]||0)+(s.g["傷官"]||0),auth=(s.g["正官"]||0)+(s.g["七殺"]||0),res=(s.g["正印"]||0)+(s.g["偏印"]||0);
 const trans=dy&&Math.abs(new Date().getFullYear()-dy.startYear)<=1?"切り替わり期":dy?"積み上げ期":"確認中";
 return[
  {label:"考える深さ",value:level((s.e.water||0)+Math.round((s.e.metal||0)/2)),note:"情報を内側で整理する力"},
  {label:"表現の力",value:level(out),note:"考えを言葉や形にする力"},
  {label:"責任感",value:level(auth),note:"役割を引き受ける力"},
  {label:"学びの力",value:level(res),note:"経験から整える力"},
  {label:"今の流れ",value:trans,note:dy?dy.ganZhi+"大運":"大運確認中"}
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
 if(t.key==="work")return{title:t.title,score:t.score,towa_line:"頑張れる仕事より、自分の判断が生きる仕事を選ぶ方が長く続きそう。",paragraphs:["考える力と結果を形にする力の両方をどう使うかがポイント。納得していない状態で、ただ指示通りに動き続けると疲れやすい。","今の"+(dy?dy.ganZhi+"大運":"流れ")+"では、肩書きだけでなく裁量・人間関係・生活リズムまで一緒に見ると判断しやすい。"],note:"向いている仕事より、長く力を出せる条件を言葉にしてみて。"};
 if(t.key==="money")return{title:t.title,score:t.score,towa_line:"お金は、増やすことより安心して使える形に整えると強い。",paragraphs:["お金を数字だけでなく、自由・安心・選択肢として感じやすい。収入が増えても先が見えないと不安が残ることがある。","固定費・貯めるお金・使っていいお金を分けて、自分が安心できる基準を作ると強い。運勢より現実の数字を主役にしてね。"],note:"今月いくら残すか、何に使うか。数字を味方につけよう。"};
 if(t.key==="love")return{title:t.title,score:t.score,towa_line:"近づきたい気持ちと、ちゃんと見極めたい気持ち。その両方を持ってる。",paragraphs:["最初から全部を見せるより、相手の反応を見ながら少しずつ距離を縮めやすい。信頼すると深く関わる。","相手の気持ちを当てようとしすぎず、『私はこう感じた』を少し早めに言葉にすると関係が楽になる。"],note:"分かってもらう前に、まず自分の気持ちを分かってあげて。"};
 return{title:t.title,score:t.score,towa_line:"人に合わせられることと、誰にでも心を開くことは別なんだよ。",paragraphs:["周囲をよく見られるぶん、場を乱さないように自分が調整することがある。続くと『本当は嫌だった』に気づくのが遅くなる。",(c.interactions||[]).length?"命式には揺れやぶつかりを示す配置もある。怖い意味ではなく、関係や環境を見直すことで成長しやすいと読める。":"誰といると自然体でいられるかを基準にすると、人間関係が整理しやすい。"],note:"優しさと我慢を同じものにしなくていい。"};
}
function reading(c,name){
 const s=stats(c),dy=currentDY(c),dm=c.dayMaster?.char||c.pillars?.day?.stem,base=CORE[dm]||["静かな基準を持つ人。","納得してから進む方が力を出しやすい。"];
 const it=(c.interactions||[]).map(x=>x.description),ny=yearGZ(TARGET_YEAR),sg=tenGod(dm,ny.stem),bg=tenGod(dm,MAIN[ny.branch]);
 const topics=scores(s,c).map(x=>topic(x,s,c,dy));const next=(c.daYun?.cycles||[]).find(x=>dy&&x.startYear>dy.startYear);
 return{
  engine:"towa-rules-v0.9",
  opening:(name?name+"、":"")+"生まれた日の暦から、変わりにくいあなたの核と、今動いている流れを重ねて見てみたよ。",
  profile_cards:cards(c,s,dy),
  core:{label:"CORE",title:"あなたの核",towa_line:"静かに見える部分の奥に、ちゃんと自分だけの基準がある。",paragraphs:[base[0]+" "+base[1],DOM[s.dom[0]]+" 反対に"+EJ[s.weak[0]]+"は控えめ。苦手を無理に増やすより、必要な時だけ補えばいい。",it.length?"命式には「"+it.slice(0,2).join("」「")+"」も見える。これは人生の中で、一度考え直して組み替える力として読める。":"自分のペースを保てる環境で力を出しやすい。"],note:"自分を変えるより、まず自分の扱い方を知ることから。"},
  flow:{label:"FLOW",title:"今のあなた",towa_line:dy?"今は「"+dy.ganZhi+"」の流れの中。前と同じ選び方がしっくりこなくても大丈夫。":"今の流れを一緒に見ていこう。",paragraphs:dy?["今の大きな流れは"+dy.ganZhi+"大運（"+dy.startYear+"〜"+dy.endYear+"）。",FLOW[dy.stemTenGod]||"自分の基準を整えながら次へ進む流れ。",dy.startYear>=new Date().getFullYear()-1?"大運が切り替わったばかり。最近の違和感は、新しい10年の基準を作る材料になる。":"これまで積み上げたものを次に何へつなげるかを見る時。"]:["大運を確認しながら見ていこう。"],note:"最近変わった違和感は、次の基準を作る材料になる。"},
  path:{label:"PATH",title:"あなたの選び方",towa_line:"全部を同じ重さで抱えなくていい。今強く出ているテーマから見よう。",ordered_topics:topics,note:"上に来たほど良い・悪いではなく、意識しやすい領域だよ。"},
  turning_point:{label:"TURNING POINT",title:"流れが変わる時",towa_line:"転機は『もう同じやり方では進めない』と気づくところから始まりやすい。",paragraphs:[dy?"今の"+dy.ganZhi+"大運は"+dy.startYear+"年から"+dy.endYear+"年まで。":"大運の節目を見ていこう。",next?"次の大きな切り替わりは"+next.startYear+"年ごろ。そこまでに何を積み上げるかが大事。":"今は目の前の選択を整える時。","転機を『必ず何かが起こる年』として怖がらなくていい。現実の状況と自分の意思で選んでいこう。"],note:"運は命令じゃなく、選択を見るための背景として使おう。"},
  next:{label:"NEXT",title:TARGET_YEAR+"年のあなた",towa_line:TARGET_YEAR+"年は"+ny.stem+ny.branch+"。あなたにとって「"+sg+"」と「"+bg+"」の要素が重なる一年。",paragraphs:["天干の"+ny.stem+"はあなたにとって"+sg+"。"+(FLOW[sg]||"新しいテーマが入りやすい。"),"地支の"+ny.branch+"は主な気で見ると"+bg+"。出来事を当てるより、どんな選択を増やす一年にするかを考えよう。","年運だけで人生は決まらない。現実の予定やお金、体調、約束を優先しながら補助線として使ってね。"],note:TARGET_YEAR+"年に一つだけ育てたいものを決めるなら、何にする？"},
  letter:{label:"LETTER",title:"TOWAからあなたへ",towa_line:"考えすぎる自分を、敵にしなくていい。",paragraphs:["あなたは、見て、感じて、比べて、それから自分なりの答えを作る人。そのぶん決めるまで時間がかかることもあるけれど、それは弱さじゃない。","答えが完璧になるまで待たなくてもいい。七割くらい納得できたら一度動いて、残りは進みながら確かめる。","また迷ったら、ここに戻ってきて。前に何を大切にしたかを見ながら、続きを一緒に考えよう。"],note:"自分のこと、ちょっと分かったかも。そう思えたら今日はそれで十分。"},
  evidence:{day_master:dm,dominant_element:EJ[s.dom[0]],weak_element:EJ[s.weak[0]],current_dayun:dy?dy.ganZhi:null,target_year:ny.stem+ny.branch,interactions:it},
  guided_topics:["work","money","love","people","now"]
 };
}
function guidance(c,k){
 const s=stats(c),dy=currentDY(c);
 if(k==="now")return{title:"今の流れ",towa_line:dy?"今は"+dy.ganZhi+"大運の中。新しい基準を作る時だよ。":"今の優先順位を見てみよう。",paragraphs:[dy?(FLOW[dy.stemTenGod]||"自分の基準を整える時。"):"焦らず一つ決めてみて。","今週・今月の現実の予定を見ながら、一つだけ優先順位を決めてみて。"],note:"運勢より、今の自分が何を減らしたいかから考えてみよう。"};
 const t=scores(s,c).find(x=>x.key===k)||scores(s,c)[0];return topic(t,s,c,dy);
}

async function register(req,res){
 try{const b=await body(req),email=String(b.email||"").trim().toLowerCase(),name=String(b.display_name||"").trim(),pw=String(b.password||"");if(!email.includes("@")||!name||pw.length<8)throw new Error("入力を確認してね。");const salt=crypto.randomBytes(16).toString("hex"),id=randomUUID();await pool.query("INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES($1,$2,$3,$4,$5)",[id,email,name,salt,pwh(pw,salt)]);const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),id]);setCookie(res,t);json(res,201,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function login(req,res){
 try{const b=await body(req),u=await one("SELECT * FROM users WHERE email=$1",[String(b.email||"").trim().toLowerCase()]);if(!u||pwh(String(b.password||""),u.password_salt)!==u.password_hash)return json(res,401,{error:"メールアドレスかパスワードが違うみたい。"});const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),u.id]);setCookie(res,t);json(res,200,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function me(req,res){
 const u=await requireUser(req,res);if(!u)return;
 const bp=await one("SELECT gender,birth_date::text,birth_time::text,birth_time_known FROM birth_profiles WHERE user_id=$1",[u.id]);
 const sp=await one("SELECT chart_json FROM saju_profiles WHERE user_id=$1",[u.id]);
 const rr=await one("SELECT report_json,model_name,created_at FROM reading_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[u.id]);
 json(res,200,{user:u,birth_profile:bp,chart:sp?.chart_json||null,latest_report:rr?{reading:rr.report_json,engine:rr.model_name,created_at:rr.created_at}:null});
}
async function makeReading(req,res){
 const u=await requireUser(req,res);if(!u)return;
 try{
  const b=await body(req),p=b.profile;
  if(!p||!["male","female"].includes(p.gender)||!/^\d{4}-\d{2}-\d{2}$/.test(p.birth_date||""))throw new Error("出生情報を確認してね。");
  const c=makeChart(p);
  await pool.query("INSERT INTO birth_profiles(user_id,gender,birth_date,birth_time,birth_time_known) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET gender=EXCLUDED.gender,birth_date=EXCLUDED.birth_date,birth_time=EXCLUDED.birth_time,birth_time_known=EXCLUDED.birth_time_known,updated_at=NOW()",[u.id,p.gender,p.birth_date,p.birth_time_known?p.birth_time:null,Boolean(p.birth_time_known)]);
  await pool.query("INSERT INTO saju_profiles(user_id,engine_version,chart_json) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET engine_version=EXCLUDED.engine_version,chart_json=EXCLUDED.chart_json,calculated_at=NOW()",[u.id,"@openfate/bazi-engine@2.0.0",JSON.stringify(c)]);
  const r=reading(c,u.display_name);
  await pool.query("INSERT INTO reading_reports(id,user_id,report_json,model_name) VALUES($1,$2,$3,$4)",[randomUUID(),u.id,JSON.stringify(r),"towa-rules-v0.9"]);
  json(res,200,{chart:c,reading:r,engine:"towa-rules-v0.9",api_cost_jpy:0});
 }catch(e){json(res,500,{error:e.message})}
}
async function guide(req,res){
 const u=await requireUser(req,res);if(!u)return;
 const b=await body(req),sp=await one("SELECT chart_json FROM saju_profiles WHERE user_id=$1",[u.id]);
 if(!sp)return json(res,400,{error:"先にTOWA MAPを作ってね。"});
 const allowed=["work","money","love","people","now"],k=allowed.includes(b.topic)?b.topic:"now";
 json(res,200,{topic:k,answer:guidance(sp.chart_json,k),engine:"towa-rules-v0.9",api_cost_jpy:0});
}
function staticFile(req,res){
 let p=new URL(req.url,"http://x").pathname;if(p==="/")p="/index.html";
 const f=path.join(publicDir,path.normalize(p).replace(/^[/\\]+/,""));
 if(!f.startsWith(publicDir))return json(res,403,{error:"forbidden"});
 fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end("Not found");return}res.writeHead(200,{"Content-Type":mime(f),"Cache-Control":f.endsWith(".html")?"no-store":"public, max-age=3600"});res.end(d)});
}
const server=http.createServer(async(req,res)=>{
 const p=new URL(req.url,"http://x").pathname;
 if(req.method==="GET"&&p==="/api/health")return json(res,200,{ok:true,version:"0.9",database_ready:dbReady,database_error:dbError,interpretation_engine:"towa-rules-v0.9",openai_required:false,api_cost_jpy:0,target_year:TARGET_YEAR});
 if(req.method==="POST"&&p==="/api/auth/register")return dbReady?register(req,res):json(res,503,{error:"DB接続待ち"});
 if(req.method==="POST"&&p==="/api/auth/login")return dbReady?login(req,res):json(res,503,{error:"DB接続待ち"});
 if(req.method==="GET"&&p==="/api/me")return me(req,res);
 if(req.method==="POST"&&p==="/api/reading")return makeReading(req,res);
 if(req.method==="POST"&&p==="/api/guidance")return guide(req,res);
 if(req.method==="GET")return staticFile(req,res);
 res.writeHead(405);res.end();
});
server.listen(PORT,()=>console.log("TOWA v0.9 listening on "+PORT+" dbReady="+dbReady+" rulesEngine=true apiCost=0"));
