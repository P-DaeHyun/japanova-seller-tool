(function(){
'use strict';

const API='https://japanova-seller-os-api.onrender.com';
const STORAGE_KEY='japanova_candidate_products_v1';
const MARKETS=[
  {code:'TW',name:'대만',cur:'TWD',active:true},
  {code:'SG',name:'싱가포르',cur:'SGD',active:true},
  {code:'MY',name:'말레이시아',cur:'MYR',active:true},
  {code:'TH',name:'태국',cur:'THB',active:true},
  {code:'PH',name:'필리핀',cur:'PHP',active:true},
  {code:'VN',name:'베트남',cur:'VND',active:true},
  {code:'BR',name:'브라질',cur:'BRL',active:false}
];
const $=(s)=>document.querySelector(s);
const $$=(s)=>[...document.querySelectorAll(s)];
const fmt=(n,d=0)=>Number.isFinite(Number(n))?Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d}):'-';
const jpy=(n)=>Number.isFinite(Number(n))?`¥${Math.round(Number(n)).toLocaleString('ko-KR')}`:'-';
const pct=(n)=>Number.isFinite(Number(n))?`${(Number(n)*100).toFixed(1)}%`:'-';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state={candidates:[],selectedId:null,calcData:null,fx:null,dbStorage:false};
let persistTimer=null;

function uid(){return `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`.toUpperCase()}
function blankCandidate(){return {id:uid(),name:'',sourceUrl:'',supplier:'',purchaseCostJpy:0,packagingCostJpy:0,domesticShippingJpy:0,otherCostJpy:0,weightG:200,lengthCm:0,widthCm:0,heightCm:0,discountPct:0,payoneerPct:2,fxBufferPct:2,targetMarginPct:20,initialUnits:1,status:'RESEARCH',note:'',plans:{__sourceMeta:{asin:'',jan:'',brand:'',category:'',primaryMarket:'TW'}},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}
function sourceMeta(c){c.plans=c.plans||{};c.plans.__sourceMeta=c.plans.__sourceMeta||{};const s=c.plans.__sourceMeta;if(!s.primaryMarket)s.primaryMarket='TW';return s}
function parseSourceUrl(raw){
  const value=String(raw||'').trim();
  if(!value)return {url:'',supplier:'',asin:''};
  try{
    const u=new URL(value);
    const host=u.hostname.toLowerCase();
    let supplier='',asin='';
    if(host.includes('amazon.co.jp')){
      supplier='Amazon Japan';
      const m=u.pathname.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
      asin=(m?.[1]||u.searchParams.get('asin')||'').toUpperCase();
      if(asin) return {url:`https://www.amazon.co.jp/dp/${asin}`,supplier,asin};
    }else if(host.includes('rakuten.co.jp')) supplier='Rakuten Japan';
    else if(host.includes('netsea.jp')) supplier='NETSEA';
    else if(host.includes('superdelivery.com')) supplier='SUPER DELIVERY';
    else if(host.includes('yahoo.co.jp')) supplier='Yahoo! Shopping Japan';
    return {url:u.toString(),supplier,asin};
  }catch{return {url:value,supplier:'',asin:''}}
}
function analyzeSourceUrl(){
  const parsed=parseSourceUrl($('#cSource')?.value);
  if(!parsed.url)return flash('소싱 URL을 먼저 입력해줘.','warn');
  setVal('#cSource',parsed.url);
  if(parsed.supplier&&!$('#cSupplier').value.trim())setVal('#cSupplier',parsed.supplier);
  if(parsed.asin)setVal('#cAsin',parsed.asin);
  flash(parsed.asin?`Amazon URL에서 ASIN ${parsed.asin}을 찾았어. 상품명·원가·중량만 확인해서 저장하면 돼.`:'URL과 매입처를 정리했어. 이 방식은 유료 Amazon API 없이 URL/상품정보를 반자동으로 저장해.');
}
function readLocal(){try{const x=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(x)?x:[]}catch{return []}}
function saveLocal(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state.candidates))}
function selected(){return state.candidates.find(x=>x.id===state.selectedId)||null}
function num(sel){return Number($(sel)?.value||0)||0}
function setVal(sel,v){if($(sel))$(sel).value=v??''}
function flash(msg,type='ok'){const b=$('#flash');if(!b)return;b.textContent=msg;b.className=`flash ${type}`;b.hidden=false;clearTimeout(flash.t);flash.t=setTimeout(()=>b.hidden=true,4500)}
async function api(path,opts={}){const r=await fetch(`${API}${path}`,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.message||`HTTP ${r.status}`);return body}

async function loadReference(){
  const [calc,fx]=await Promise.all([
    fetch('../data.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('국가별 수수료/SLS 데이터를 불러오지 못했습니다.');return r.json()}),
    api('/api/fx').catch(async()=>{const r=await fetch('../fx.json',{cache:'no-store'});if(!r.ok)throw new Error('환율 데이터를 불러오지 못했습니다.');return r.json()})
  ]);
  state.calcData=calc;state.fx=fx;
  $('#dataVersion').textContent=`요금 ${calc.dataVersion||'-'} · 환율 ${fx.sourceDate||'-'}`;
}
async function loadCandidates(){
  const cached=readLocal();
  try{
    const r=await api('/api/candidates');state.dbStorage=true;let server=Array.isArray(r.candidates)?r.candidates:[];
    if(!server.length&&cached.length){const moved=[];for(const c of cached){try{const s=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:JSON.stringify(c)});moved.push(s.candidate||c)}catch{moved.push(c)}}server=moved}
    state.candidates=server;saveLocal();$('#status').textContent='반자동 소싱 · DB 저장';$('#status').className='badge ok';
  }catch{state.dbStorage=false;state.candidates=cached;$('#status').textContent='반자동 소싱 · 로컬 백업';$('#status').className='badge warn'}
}
async function persistCandidate(c,{silent=false}={}){
  c.updatedAt=new Date().toISOString();saveLocal();
  if(!state.dbStorage)return c;
  try{const r=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:JSON.stringify(c)});const saved=r.candidate||c;const i=state.candidates.findIndex(x=>x.id===saved.id);if(i>=0)state.candidates[i]=saved;saveLocal();return saved}
  catch(e){state.dbStorage=false;$('#status').textContent='반자동 소싱 · 로컬 백업';$('#status').className='badge warn';if(!silent)flash(`DB 저장 실패, 브라우저에 백업 중: ${e.message}`,'warn');return c}
}
function schedulePersist(){clearTimeout(persistTimer);persistTimer=setTimeout(async()=>{const c=selected();if(c)await persistCandidate(c,{silent:true})},500)}

function meta(code){return MARKETS.find(m=>m.code===code)}
function assumption(code){const m=meta(code);return m?state.calcData?.markets?.[m.name]||null:null}
function fx(code){const m=meta(code);return m?Number(state.fx?.jpyPer?.[m.cur]||0):0}
function marketInput(c,code,purchaseOverride){const a=assumption(code),rate=fx(code);if(!a||!rate)return null;return {market:a,baseFx:rate,buffer:Number(c.fxBufferPct||0)/100,discount:Number(c.discountPct||0)/100,payoneer:Number(c.payoneerPct||0)/100,purchaseCostJpy:purchaseOverride===undefined?Number(c.purchaseCostJpy||0):Number(purchaseOverride||0),packagingCostJpy:Number(c.packagingCostJpy||0),domesticShippingJpy:Number(c.domesticShippingJpy||0),otherCostJpy:Number(c.otherCostJpy||0),weightG:Math.max(1,Number(c.weightG||1)),dims:{lengthCm:Number(c.lengthCm||0),widthCm:Number(c.widthCm||0),heightCm:Number(c.heightCm||0)}}}
function roundLocal(v,cur){const step=['SGD','MYR','BRL'].includes(cur)?0.01:1;return Math.ceil(Number(v||0)/step)*step}
function local(v,cur){if(!Number.isFinite(Number(v)))return '-';const d=['SGD','MYR','BRL'].includes(cur)?2:0;return `${Number(v).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d})} ${cur}`}
function solve(c,code,target){const input=marketInput(c,code);if(!input)return null;try{return JAPANOVA_MARGIN.solveTarget({...input,targetMargin:target})}catch(e){return {error:e.message}}}
function evaluateAt(c,code,price,purchaseOverride){const p=Number(price||0);const input=marketInput(c,code,purchaseOverride);if(!(p>0)||!input)return null;try{return JAPANOVA_MARGIN.evaluate({...input,listedLocal:p})}catch(e){return {error:e.message}}}
function maxPurchaseAt(c,code,price,target){const e=evaluateAt(c,code,price,0);if(!e||e.error)return null;return e.profitJpy-(Number(target||0)*e.revenueJpy)}
function planOf(c,code){c.plans=c.plans||{};c.plans[code]=c.plans[code]||{};return c.plans[code]}
function regLabel(v){return ({UNCHECKED:'미확인',OK:'판매가능',CHECK:'확인필요',BLOCKED:'판매제외'})[v||'UNCHECKED']||'미확인'}
function decisionLabel(v){return ({AUTO:'자동판정',SELL:'판매대상',HOLD:'보류',EXCLUDE:'제외'})[v||'AUTO']||'자동판정'}

function assess(c,code){
  const m=meta(code),p=planOf(c,code),target=Number(c.targetMarginPct||20)/100,reg=p.regulationStatus||'UNCHECKED',decision=p.decision||'AUTO';
  const rate=fx(code),a=assumption(code),competitor=Number(p.competitorPrice||0),planned=Number(p.plannedPrice||0);
  const compEval=competitor>0?evaluateAt(c,code,competitor):null,plannedEval=planned>0?evaluateAt(c,code,planned):null;
  const maxPurchase=competitor>0?maxPurchaseAt(c,code,competitor,target):null;
  let auto={key:'NEED_PRICE',label:'경쟁가 필요',cls:'muted'};
  if(!a||!rate)auto={key:'NO_DATA',label:'계산 보류',cls:'warn'};
  else if(reg==='BLOCKED')auto={key:'EXCLUDE',label:'규제상 제외',cls:'bad'};
  else if(reg!=='OK')auto={key:'CHECK',label:'규제 확인',cls:'warn'};
  else if(competitor>0&&Number.isFinite(maxPurchase)){
    if(maxPurchase<=0||Number(c.purchaseCostJpy)>maxPurchase)auto={key:'EXCLUDE',label:'시장가 기준 제외',cls:'bad'};
    else if(compEval&&!compEval.error&&compEval.margin>=target)auto={key:'SELL',label:'판매 후보',cls:'ok'};
    else if(compEval&&!compEval.error&&compEval.profitJpy>=0)auto={key:'HOLD',label:'저마진 검토',cls:'warn'};
    else auto={key:'EXCLUDE',label:'적자 위험',cls:'bad'};
  } else if(plannedEval&&!plannedEval.error){
    if(plannedEval.profitJpy<0)auto={key:'EXCLUDE',label:'예상가 적자',cls:'bad'};
    else if(plannedEval.margin>=target)auto={key:'SELL',label:'판매 후보',cls:'ok'};
    else auto={key:'HOLD',label:'저마진 검토',cls:'warn'};
  }
  const final=decision==='AUTO'?auto:{key:decision,label:`수동 · ${decisionLabel(decision)}`,cls:decision==='SELL'?'ok':decision==='EXCLUDE'?'bad':'warn'};
  return {m,p,target,reg,decision,competitor,planned,compEval,plannedEval,maxPurchase,headroom:Number.isFinite(maxPurchase)?maxPurchase-Number(c.purchaseCostJpy||0):null,auto,final};
}
function candidateStats(c){const rows=MARKETS.filter(m=>m.active).map(m=>assess(c,m.code));return {sell:rows.filter(x=>x.final.key==='SELL').length,hold:rows.filter(x=>x.final.key==='HOLD').length,exclude:rows.filter(x=>x.final.key==='EXCLUDE').length,pending:rows.filter(x=>['CHECK','NEED_PRICE','NO_DATA'].includes(x.final.key)).length,rows}}
function unitCost(c){return Number(c.purchaseCostJpy||0)+Number(c.packagingCostJpy||0)+Number(c.domesticShippingJpy||0)+Number(c.otherCostJpy||0)}
function exposureLabel(c){const s=candidateStats(c),n=Math.max(1,Number(c.initialUnits||1));if(!s.sell)return {label:'매입 전 검증필요',cls:'bad'};if(n<=2)return {label:'테스트 수량',cls:'ok'};if(n<=5)return {label:'소량 노출',cls:'warn'};return {label:'재고노출 큼',cls:'bad'}}

function renderMetrics(){let sell=0,exclude=0,pending=0,cash=0;for(const c of state.candidates){const s=candidateStats(c);sell+=s.sell;exclude+=s.exclude;pending+=s.pending;cash+=unitCost(c)*Math.max(1,Number(c.initialUnits||1))}$('#mCandidates').textContent=fmt(state.candidates.length);$('#mSellMarkets').textContent=fmt(sell);$('#mExcludeMarkets').textContent=fmt(exclude);$('#mPendingMarkets').textContent=fmt(pending);$('#mCash').textContent=jpy(cash)}
function renderList(){const body=$('#candidateRows');if(!state.candidates.length){body.innerHTML='<tr><td colspan="8" class="empty">아직 후보상품이 없어. 실제로 조사한 첫 상품부터 넣으면 돼.</td></tr>';return}body.innerHTML=state.candidates.map(c=>{const s=candidateStats(c),ex=exposureLabel(c);const status=c.status==='READY'?'<span class="ok">등록 후보</span>':c.status==='HOLD'?'<span class="warn">보류</span>':'조사중';return `<tr class="${c.id===state.selectedId?'sel':''}"><td><button class="link" data-open="${esc(c.id)}">${esc(c.name||'(이름 없음)')}</button></td><td>${jpy(c.purchaseCostJpy)}</td><td>${jpy(unitCost(c))}</td><td>${status}</td><td class="ok">${s.sell}</td><td class="bad">${s.exclude}</td><td class="${ex.cls}">${ex.label}</td><td><button class="mini" data-open="${esc(c.id)}">검증</button></td></tr>`}).join('');body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openCandidate(b.dataset.open))}

function fillForm(c){const x=c||blankCandidate(),s=sourceMeta(x);$('#formTitle').textContent=c?'후보상품 편집':'새 후보상품';setVal('#cName',x.name);setVal('#cSource',x.sourceUrl);setVal('#cSupplier',x.supplier);setVal('#cAsin',s.asin);setVal('#cJan',s.jan);setVal('#cBrand',s.brand);setVal('#cCategory',s.category);setVal('#cPrimaryMarket',s.primaryMarket||'TW');setVal('#cPurchase',x.purchaseCostJpy);setVal('#cPack',x.packagingCostJpy);setVal('#cDomestic',x.domesticShippingJpy);setVal('#cOther',x.otherCostJpy);setVal('#cWeight',x.weightG);setVal('#cUnits',x.initialUnits);setVal('#cL',x.lengthCm);setVal('#cW',x.widthCm);setVal('#cH',x.heightCm);setVal('#cDiscount',x.discountPct);setVal('#cPayoneer',x.payoneerPct);setVal('#cFxBuffer',x.fxBufferPct);setVal('#cTarget',x.targetMarginPct);setVal('#cStatus',x.status||'RESEARCH');setVal('#cNote',x.note);$('#candidateId').value=c?.id||''}
function readForm(){const old=selected(),id=$('#candidateId').value||uid(),plans=old?.plans||{};plans.__sourceMeta={...(plans.__sourceMeta||{}),asin:$('#cAsin').value.trim().toUpperCase(),jan:$('#cJan').value.trim(),brand:$('#cBrand').value.trim(),category:$('#cCategory').value.trim(),primaryMarket:$('#cPrimaryMarket').value||'TW'};const parsed=parseSourceUrl($('#cSource').value);return {...(old||{}),id,name:$('#cName').value.trim(),sourceUrl:parsed.url||$('#cSource').value.trim(),supplier:$('#cSupplier').value.trim()||parsed.supplier,purchaseCostJpy:num('#cPurchase'),packagingCostJpy:num('#cPack'),domesticShippingJpy:num('#cDomestic'),otherCostJpy:num('#cOther'),weightG:Math.max(1,num('#cWeight')),initialUnits:Math.max(1,num('#cUnits')),lengthCm:num('#cL'),widthCm:num('#cW'),heightCm:num('#cH'),discountPct:num('#cDiscount'),payoneerPct:num('#cPayoneer'),fxBufferPct:num('#cFxBuffer'),targetMarginPct:num('#cTarget'),status:$('#cStatus').value,note:$('#cNote').value.trim(),plans,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()}}
async function saveCandidate({quiet=false}={}){const c=readForm();if(!c.name){flash('후보상품 이름을 입력해줘.','warn');return null}if(!(c.purchaseCostJpy>0)){flash('매입원가는 0보다 커야 해.','warn');return null}const i=state.candidates.findIndex(x=>x.id===c.id);if(i>=0)state.candidates[i]=c;else state.candidates.unshift(c);state.selectedId=c.id;const saved=await persistCandidate(c);state.selectedId=saved.id;renderAll();fillForm(saved);if(!quiet)flash(state.dbStorage?'후보상품과 검증조건을 DB에 저장했어.':'후보상품을 로컬 백업에 저장했어.');return saved}
async function autoTargetPrices(){
  const saved=await saveCandidate({quiet:true});if(!saved)return;
  const target=Number(saved.targetMarginPct||20)/100;let count=0;
  for(const m of MARKETS.filter(x=>x.active)){
    const solved=solve(saved,m.code,target);
    if(solved&&!solved.error&&Number(solved.listedLocal)>0){
      const p=planOf(saved,m.code);p.plannedPrice=roundLocal(solved.listedLocal,m.cur);count++;
    }
  }
  await persistCandidate(saved,{silent:true});renderAll();fillForm(saved);
  flash(count?`목표마진 ${saved.targetMarginPct}% 기준 판매가를 ${count}개 시장에 자동 계산했어. 경쟁가와 규제 상태를 확인해줘.`:'계산 가능한 시장이 없어. 환율·중량·원가 데이터를 확인해줘.',count?'ok':'warn');
}
async function saveAndOpenListing(){
  let saved=await saveCandidate({quiet:true});if(!saved)return;
  const stats=candidateStats(saved);
  if(!stats.sell)return flash('아직 판매 후보로 확정된 국가가 없어. 최소 한 국가에서 규제=판매가능 후 경쟁가/판매가를 검증해줘.','warn');
  if(saved.status!=='READY'){saved.status='READY';saved=await persistCandidate(saved,{silent:true})}
  const preferred=sourceMeta(saved).primaryMarket||'TW';
  const sellCodes=stats.rows.filter(x=>x.final.key==='SELL').map(x=>x.m.code);
  const code=sellCodes.includes(preferred)?preferred:sellCodes[0];
  location.href=`./latest.html?candidateId=${encodeURIComponent(saved.id)}&market=${encodeURIComponent(code)}`;
}
function newCandidate(){state.selectedId=null;fillForm(null);$('#validation').innerHTML='<div class="empty">후보상품을 저장하면 국가별 검증표가 만들어져.</div>';$('#capitalBox').innerHTML='<div class="empty">후보상품을 선택해.</div>'}
function openCandidate(id){state.selectedId=id;fillForm(selected());renderList();renderValidation();renderCapital()}
async function deleteCandidate(){const c=selected();if(!c)return;if(!confirm(`“${c.name}” 후보를 삭제할까?`))return;if(state.dbStorage){try{await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'DELETE'})}catch(e){return flash(`DB 삭제 실패: ${e.message}`,'bad')}}state.candidates=state.candidates.filter(x=>x.id!==c.id);state.selectedId=null;saveLocal();renderAll();newCandidate();flash('후보상품을 삭제했어.')}

function zoneText(c,code){const m=meta(code),b0=solve(c,code,0),b10=solve(c,code,.10),bt=solve(c,code,Number(c.targetMarginPct||20)/100),b30=solve(c,code,.30);if(!m||!b0||b0.error)return '-';return `<span class="bad">적자 &lt; ${local(roundLocal(b0.listedLocal,m.cur),m.cur)}</span><br><span class="warn">안전 ${local(roundLocal(b10.listedLocal,m.cur),m.cur)}+</span><br><span class="ok">목표 ${local(roundLocal(bt?.listedLocal,m.cur),m.cur)}+</span><br><span class="muted">30% ${local(roundLocal(b30?.listedLocal,m.cur),m.cur)}+</span>`}
function renderValidation(){
  const c=selected();if(!c){$('#validation').innerHTML='<div class="empty">후보상품을 선택해.</div>';return}
  const rows=MARKETS.map(m=>{const a=assess(c,m.code),rate=fx(m.code),hasData=assumption(m.code)&&rate;const compProfit=a.compEval&&!a.compEval.error?a.compEval.profitJpy:null;const compMargin=a.compEval&&!a.compEval.error?a.compEval.margin:null;const plannedProfit=a.plannedEval&&!a.plannedEval.error?a.plannedEval.profitJpy:null;return `<tr>
    <td><b>${m.name}</b><div class="muted">${m.code} · ${m.cur}</div></td>
    <td>${rate?fmt(rate,rate<0.1?6:4):'-'}</td>
    <td><select class="marketSel reg" data-code="${m.code}"><option value="UNCHECKED" ${a.reg==='UNCHECKED'?'selected':''}>미확인</option><option value="OK" ${a.reg==='OK'?'selected':''}>판매가능</option><option value="CHECK" ${a.reg==='CHECK'?'selected':''}>확인필요</option><option value="BLOCKED" ${a.reg==='BLOCKED'?'selected':''}>판매제외</option></select></td>
    <td><input class="plan" data-code="${m.code}" data-field="competitorPrice" type="number" step="any" value="${esc(a.p.competitorPrice||'')}" placeholder="경쟁가"></td>
    <td class="${Number.isFinite(a.headroom)?(a.headroom>=0?'ok':'bad'):'muted'}">${hasData&&a.competitor>0&&Number.isFinite(a.maxPurchase)?`${jpy(a.maxPurchase)}<div class="tiny">현재 대비 ${a.headroom>=0?'+':''}${jpy(a.headroom)}</div>`:'-'}</td>
    <td>${hasData?zoneText(c,m.code):'<span class="warn">데이터 대기</span>'}</td>
    <td>${a.competitor>0&&compProfit!==null?`${jpy(compProfit)}<div class="${compMargin>=a.target?'ok':compProfit<0?'bad':'warn'}">${pct(compMargin)}</div>`:'-'}</td>
    <td><input class="plan" data-code="${m.code}" data-field="plannedPrice" type="number" step="any" value="${esc(a.p.plannedPrice||'')}" placeholder="내 판매가"></td>
    <td>${plannedProfit!==null?`${jpy(plannedProfit)}<div>${pct(a.plannedEval.margin)}</div>`:'-'}</td>
    <td><select class="marketSel decision" data-code="${m.code}"><option value="AUTO" ${a.decision==='AUTO'?'selected':''}>자동판정</option><option value="SELL" ${a.decision==='SELL'?'selected':''}>판매대상</option><option value="HOLD" ${a.decision==='HOLD'?'selected':''}>보류</option><option value="EXCLUDE" ${a.decision==='EXCLUDE'?'selected':''}>제외</option></select><div class="${a.final.cls} verdict">${a.final.label}</div></td>
  </tr>`}).join('');
  $('#validation').innerHTML=`<div class="analysisHead"><div><h3>${esc(c.name)}</h3><div class="muted">목표마진 ${fmt(c.targetMarginPct)}% · 매입가 ${jpy(c.purchaseCostJpy)} · 단위원가 ${jpy(unitCost(c))}</div></div><div class="chips"><span>FX 버퍼 ${fmt(c.fxBufferPct)}%</span><span>Payoneer ${fmt(c.payoneerPct)}%</span><span>할인 ${fmt(c.discountPct)}%</span></div></div><div class="tablewrap"><table><thead><tr><th>국가</th><th>환율</th><th>규제</th><th>경쟁가</th><th>최대 매입가능가</th><th>판매가 안전구간</th><th>경쟁가 수익</th><th>내 판매가</th><th>예상 수익</th><th>판매판정</th></tr></thead><tbody>${rows}</tbody></table></div><div class="legend">최대 매입가능가는 입력한 경쟁가에서 현재 목표마진을 지킬 수 있는 일본 매입원가 상한이야. 규제 상태가 ‘판매가능’이 아니면 수익성이 좋아도 자동으로 판매 후보 처리하지 않아.</div>`;
  $$('.plan').forEach(el=>el.onchange=()=>updateMarketField(el.dataset.code,el.dataset.field,el.value));
  $$('.reg').forEach(el=>el.onchange=()=>updateMarketField(el.dataset.code,'regulationStatus',el.value));
  $$('.decision').forEach(el=>el.onchange=()=>updateMarketField(el.dataset.code,'decision',el.value));
}
function updateMarketField(code,field,value){const c=selected();if(!c)return;const p=planOf(c,code);p[field]=['competitorPrice','plannedPrice'].includes(field)?(value===''?'':Number(value)):value;c.updatedAt=new Date().toISOString();saveLocal();renderValidation();renderCapital();renderMetrics();renderList();renderComparison();schedulePersist()}

function renderCapital(){const c=selected();if(!c){$('#capitalBox').innerHTML='<div class="empty">후보상품을 선택해.</div>';return}const s=candidateStats(c),u=unitCost(c),ex=exposureLabel(c);const quantities=[1,2,5,10,Math.max(1,Number(c.initialUnits||1))].filter((v,i,a)=>a.indexOf(v)===i);const cards=quantities.map(q=>`<div class="riskCard"><div class="muted">${q===Number(c.initialUnits)?'현재 계획 · ':''}${q}개</div><strong>${jpy(u*q)}</strong><div class="tiny">매입·포장·국내배송·기타비 포함</div></div>`).join('');$('#capitalBox').innerHTML=`<div class="analysisHead"><div><h3>초기 매입 노출</h3><div class="${ex.cls}">${ex.label}</div></div><div class="chips"><span>판매후보 ${s.sell}개국</span><span>제외 ${s.exclude}개국</span><span>검증대기 ${s.pending}개국</span></div></div><div class="riskGrid">${cards}</div><div class="legend">이 표는 자금 노출액을 보여주는 안전장치야. 실제 판매량을 예측하는 기능은 아니며, 검증되지 않은 후보의 대량매입을 막기 위한 참고값으로 사용해.</div>`}

function renderComparison(){const body=$('#compareRows');if(!state.candidates.length){body.innerHTML='<tr><td colspan="10" class="empty">후보상품이 생기면 여기서 한 번에 비교할 수 있어.</td></tr>';return}body.innerHTML=state.candidates.map(c=>{const s=candidateStats(c),gaps=s.rows.map(x=>x.headroom).filter(Number.isFinite),bestGap=gaps.length?Math.max(...gaps):null,ex=exposureLabel(c);return `<tr><td><button class="link" data-compare-open="${esc(c.id)}">${esc(c.name)}</button></td><td>${jpy(c.purchaseCostJpy)}</td><td>${jpy(unitCost(c))}</td><td>${fmt(c.weightG)}g</td><td class="ok">${s.sell}</td><td class="warn">${s.hold}</td><td class="bad">${s.exclude}</td><td>${s.pending}</td><td class="${bestGap===null?'muted':bestGap>=0?'ok':'bad'}">${bestGap===null?'-':`${bestGap>=0?'+':''}${jpy(bestGap)}`}</td><td class="${ex.cls}">${ex.label}</td></tr>`}).join('');$$('[data-compare-open]').forEach(b=>b.onclick=()=>{showView('lab');openCandidate(b.dataset.compareOpen)})}

function renderAll(){renderMetrics();renderList();renderComparison();if(selected()){renderValidation();renderCapital()}}
function showView(name){$('#labView').hidden=name!=='lab';$('#compareView').hidden=name!=='compare';$('#opsView').hidden=name!=='ops';$('#navLab').classList.toggle('on',name==='lab');$('#navCompare').classList.toggle('on',name==='compare');$('#navOps').classList.toggle('on',name==='ops');if(name==='compare')renderComparison()}
function exportCandidates(){const blob=new Blob([JSON.stringify({version:'1.0',exportedAt:new Date().toISOString(),candidates:state.candidates},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`JAPANOVA_candidates_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function importCandidates(file){try{const raw=JSON.parse(await file.text());const list=Array.isArray(raw)?raw:raw.candidates;if(!Array.isArray(list))throw new Error('후보상품 배열을 찾을 수 없어.');state.candidates=list;saveLocal();if(state.dbStorage){for(const c of list)await persistCandidate(c,{silent:true})}state.selectedId=list[0]?.id||null;renderAll();if(state.selectedId)openCandidate(state.selectedId);flash(`${list.length}개 후보상품을 복원했어.`)}catch(e){flash(`복원 실패: ${e.message}`,'bad')}}

async function boot(){
  try{await loadReference();await loadCandidates();renderAll();if(state.candidates.length)openCandidate(state.candidates[0].id);else newCandidate()}
  catch(e){$('#status').textContent='소싱 초기화 오류';$('#status').className='badge bad';flash(e.message,'bad')}
}
$('#navLab').onclick=()=>showView('lab');$('#navCompare').onclick=()=>showView('compare');$('#navListing').onclick=()=>location.href='./latest.html';$('#navOps').onclick=()=>showView('ops');$('#newCandidate').onclick=newCandidate;$('#analyzeSource').onclick=analyzeSourceUrl;$('#autoTargetPrices').onclick=autoTargetPrices;$('#saveAndListing').onclick=saveAndOpenListing;$('#saveCandidate').onclick=()=>saveCandidate();$('#deleteCandidate').onclick=deleteCandidate;$('#exportCandidates').onclick=exportCandidates;$('#importFile').onchange=e=>{if(e.target.files?.[0])importCandidates(e.target.files[0])};
boot();
})();
