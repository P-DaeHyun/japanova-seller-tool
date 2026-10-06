import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto,{randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {Pool} from "pg";
import Stripe from "stripe";
import {calculateBaziChart} from "@openfate/bazi-engine";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL||"";
const OPENAI_API_KEY=process.env.OPENAI_API_KEY||"";
const OPENAI_MODEL=process.env.OPENAI_MODEL||"gpt-6.1-sol";
const APP_BASE_URL=(process.env.APP_BASE_URL||("http://localhost:"+PORT)).replace(/\/+$/,"");
const STRIPE_SECRET_KEY=process.env.STRIPE_SECRET_KEY||"";
const STRIPE_WEBHOOK_SECRET=process.env.STRIPE_WEBHOOK_SECRET||"";
const COOKIE_SECURE=process.env.COOKIE_SECURE==="true";
const FREE_CHAT_LIMIT=3;
const PRODUCT={code:"annual_2027",name:"2027年完全鑑定",price_jpy:1480,price_label:"¥1,480"};
const publicDir=path.join(__dirname,"public");
const schema=fs.readFileSync(path.join(__dirname,"schema.sql"),"utf8");
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSLMODE==="disable"?false:{rejectUnauthorized:false},max:6}):null;
const stripe=STRIPE_SECRET_KEY?new Stripe(STRIPE_SECRET_KEY):null;
let dbReady=false,dbError=null;
if(pool){try{await pool.query(schema);dbReady=true}catch(e){dbError=e.message;console.error(e)}}

const systemPrompt="You are TOWA（トワ）, a calm warm Japanese AI 四柱推命 guide using soft タメ口. Interpret only deterministic chart data supplied by the app. Never invent chart facts, never frighten the user, never make deterministic predictions. Explain plainly.";
const chapter={type:"object",additionalProperties:false,properties:{title:{type:"string"},towa_line:{type:"string"},explanation:{type:"string"},real_life_example:{type:"string"},summary:{type:"string"},confidence:{type:"string",enum:["high","medium","limited"]}},required:["title","towa_line","explanation","real_life_example","summary","confidence"]};
const readingSchema={type:"object",additionalProperties:false,properties:{opening:{type:"string"},chapters:{type:"object",additionalProperties:false,properties:{self:chapter,love:chapter,talent:chapter,money:chapter,turning_point:chapter,year:chapter},required:["self","love","talent","money","turning_point","year"]},suggested_questions:{type:"array",items:{type:"string"}},closing:{type:"string"}},required:["opening","chapters","suggested_questions","closing"]};

const json=(res,status,body)=>{const d=JSON.stringify(body);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(d)});res.end(d)};
const q=async(sql,p=[])=>{if(!pool||!dbReady)throw new Error("DATABASE_NOT_READY");return(await pool.query(sql,p)).rows};
const one=async(sql,p=[])=>(await q(sql,p))[0]||null;
const raw=req=>new Promise((resolve,reject)=>{const a=[];req.on("data",c=>a.push(c));req.on("end",()=>resolve(Buffer.concat(a)));req.on("error",reject)});
const body=async req=>{const b=await raw(req);return b.length?JSON.parse(b.toString("utf8")):{}};
const cookies=req=>Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return[decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}));
const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
const pwh=(p,s)=>crypto.scryptSync(p,Buffer.from(s,"hex"),64).toString("hex");
const setCookie=(res,t)=>res.setHeader("Set-Cookie",["towa_session="+encodeURIComponent(t),"HttpOnly","Path=/","SameSite=Lax","Max-Age=2592000",COOKIE_SECURE?"Secure":""].filter(Boolean).join("; "));
const mime=f=>({".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8"})[path.extname(f)]||"application/octet-stream";

async function currentUser(req){
 if(!dbReady)return null;const t=cookies(req).towa_session;if(!t)return null;
 return one("SELECT u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()",[sha(t)])
}
async function requireUser(req,res){if(!dbReady){json(res,503,{error:"DB接続待ち"});return null}const u=await currentUser(req);if(!u){json(res,401,{error:"ログインが必要だよ。"});return null}return u}
async function openai(payload){
 if(!OPENAI_API_KEY)throw new Error("OPENAI_NOT_CONFIGURED");
 const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:"Bearer "+OPENAI_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({store:false,...payload})});
 const d=await r.json();if(!r.ok)throw new Error(d?.error?.message||"OpenAI error");
 const parts=[];for(const it of d.output||[])for(const c of it.content||[])if(c.type==="output_text")parts.push(c.text);return parts.join("\n")
}
function chart(p){
 const[y,m,d]=p.birth_date.split("-").map(Number);const i={year:y,month:m,day:d,gender:p.gender,calendarType:"solar",timezoneId:"Asia/Tokyo",enableTrueSolarTime:false,dayBoundaryMode:"MIDNIGHT_00",daYunTimingVersion:"DAYUN_SECOND_V2"};
 if(p.birth_time_known&&p.birth_time){const[h,mi]=p.birth_time.split(":").map(Number);i.hour=h;i.minute=mi}return calculateBaziChart(i)
}
async function premium(uid){return Boolean(await one("SELECT 1 FROM entitlements WHERE user_id=$1 AND product_code=$2 AND status='active'",[uid,PRODUCT.code]))}

async function register(req,res){
 try{const b=await body(req),email=String(b.email||"").trim().toLowerCase(),name=String(b.display_name||"").trim(),pw=String(b.password||"");if(!email.includes("@")||!name||pw.length<8)throw new Error("入力を確認してね。");const salt=crypto.randomBytes(16).toString("hex"),id=randomUUID();await pool.query("INSERT INTO users(id,email,display_name,password_salt,password_hash) VALUES($1,$2,$3,$4,$5)",[id,email,name,salt,pwh(pw,salt)]);const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),id]);setCookie(res,t);json(res,201,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function login(req,res){
 try{const b=await body(req),u=await one("SELECT * FROM users WHERE email=$1",[String(b.email||"").trim().toLowerCase()]);if(!u||pwh(String(b.password||""),u.password_salt)!==u.password_hash)return json(res,401,{error:"メールアドレスかパスワードが違うみたい。"});const t=crypto.randomBytes(32).toString("base64url");await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+interval '30 days')",[sha(t),u.id]);setCookie(res,t);json(res,200,{ok:true})}catch(e){json(res,400,{error:e.message})}
}
async function me(req,res){
 const u=await requireUser(req,res);if(!u)return;const bp=await one("SELECT gender,birth_date::text,birth_time::text,birth_time_known FROM birth_profiles WHERE user_id=$1",[u.id]);const sp=await one("SELECT chart_json FROM saju_profiles WHERE user_id=$1",[u.id]);const rr=await one("SELECT report_json FROM reading_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",[u.id]);const mem=await q("SELECT id,category,fact,importance FROM memories WHERE user_id=$1 ORDER BY created_at DESC",[u.id]);json(res,200,{user:u,birth_profile:bp,chart:sp?.chart_json||null,latest_report:rr?.report_json||null,memories:mem,entitlement:{premium:await premium(u.id)},product:PRODUCT})
}
async function reading(req,res){
 const u=await requireUser(req,res);if(!u)return;try{const b=await body(req),p=b.profile,c=chart(p);await pool.query("INSERT INTO birth_profiles(user_id,gender,birth_date,birth_time,birth_time_known) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET gender=EXCLUDED.gender,birth_date=EXCLUDED.birth_date,birth_time=EXCLUDED.birth_time,birth_time_known=EXCLUDED.birth_time_known,updated_at=NOW()",[u.id,p.gender,p.birth_date,p.birth_time_known?p.birth_time:null,Boolean(p.birth_time_known)]);await pool.query("INSERT INTO saju_profiles(user_id,engine_version,chart_json) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET chart_json=EXCLUDED.chart_json,calculated_at=NOW()",[u.id,"@openfate/bazi-engine@2.0.0",JSON.stringify(c)]);const txt=await openai({model:OPENAI_MODEL,reasoning:{effort:"low"},input:[{role:"system",content:systemPrompt},{role:"user",content:"この確定命式から6話を作って。章は self/love/talent/money/turning_point/year。\n"+JSON.stringify(c)}],text:{format:{type:"json_schema",name:"towa_reading",strict:true,schema:readingSchema}},max_output_tokens:5000});const r=JSON.parse(txt);await pool.query("INSERT INTO reading_reports(id,user_id,report_json,model_name) VALUES($1,$2,$3,$4)",[randomUUID(),u.id,JSON.stringify(r),OPENAI_MODEL]);json(res,200,{chart:c,reading:r,product:PRODUCT})}catch(e){json(res,500,{error:e.message==="OPENAI_NOT_CONFIGURED"?"AI設定がまだ完了していないよ。":e.message})}
}

async function checkout(req,res){
 const u=await requireUser(req,res);if(!u)return;if(!stripe||!STRIPE_WEBHOOK_SECRET)return json(res,503,{error:"Stripe未接続"});const pid=randomUUID();await pool.query("INSERT INTO purchases(id,user_id,product_code,amount_jpy,status) VALUES($1,$2,$3,$4,'creating')",[pid,u.id,PRODUCT.code,PRODUCT.price_jpy]);const s=await stripe.checkout.sessions.create({mode:"payment",customer_email:u.email,line_items:[{price_data:{currency:"jpy",unit_amount:PRODUCT.price_jpy,product_data:{name:PRODUCT.name}},quantity:1}],success_url:APP_BASE_URL+"/?checkout=success",cancel_url:APP_BASE_URL+"/?checkout=cancel",metadata:{user_id:u.id,purchase_id:pid,product_code:PRODUCT.code}});await pool.query("UPDATE purchases SET status='pending',stripe_checkout_session_id=$1 WHERE id=$2",[s.id,pid]);json(res,200,{url:s.url})
}
async function webhook(req,res){
 if(!stripe||!STRIPE_WEBHOOK_SECRET)return json(res,503,{error:"Stripe未接続"});try{const b=await raw(req),ev=stripe.webhooks.constructEvent(b,req.headers["stripe-signature"],STRIPE_WEBHOOK_SECRET);if(await one("SELECT 1 FROM stripe_webhook_events WHERE event_id=$1",[ev.id]))return json(res,200,{ok:true});if(ev.type==="checkout.session.completed"&&ev.data.object.payment_status==="paid"){const s=ev.data.object;await pool.query("UPDATE purchases SET status='paid',paid_at=NOW() WHERE id=$1",[s.metadata.purchase_id]);await pool.query("INSERT INTO entitlements(user_id,product_code,status) VALUES($1,$2,'active') ON CONFLICT(user_id,product_code) DO UPDATE SET status='active',revoked_at=NULL",[s.metadata.user_id,PRODUCT.code])}await pool.query("INSERT INTO stripe_webhook_events(event_id,event_type) VALUES($1,$2)",[ev.id,ev.type]);json(res,200,{ok:true})}catch(e){json(res,400,{error:e.message})}
}

function staticFile(req,res){let p=new URL(req.url,"http://x").pathname;if(p==="/")p="/index.html";const f=path.join(publicDir,path.normalize(p).replace(/^[/\\]+/,""));if(!f.startsWith(publicDir))return json(res,403,{error:"forbidden"});fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end("Not found");return}res.writeHead(200,{"Content-Type":mime(f)});res.end(d)})}

const server=http.createServer(async(req,res)=>{const u=new URL(req.url,"http://x"),p=u.pathname;if(req.method==="POST"&&p==="/api/stripe/webhook")return webhook(req,res);if(req.method==="GET"&&p==="/api/health")return json(res,200,{ok:true,version:"0.8",database_ready:dbReady,database_error:dbError,openai_configured:Boolean(OPENAI_API_KEY),stripe_configured:Boolean(stripe&&STRIPE_WEBHOOK_SECRET),product:PRODUCT});if(req.method==="POST"&&p==="/api/auth/register")return dbReady?register(req,res):json(res,503,{error:"DB接続待ち"});if(req.method==="POST"&&p==="/api/auth/login")return dbReady?login(req,res):json(res,503,{error:"DB接続待ち"});if(req.method==="GET"&&p==="/api/me")return me(req,res);if(req.method==="POST"&&p==="/api/reading")return reading(req,res);if(req.method==="POST"&&p==="/api/checkout/create")return checkout(req,res);if(req.method==="GET")return staticFile(req,res);res.writeHead(405);res.end()});
server.listen(PORT,()=>console.log("TOWA v0.8 listening on "+PORT+" dbReady="+dbReady));