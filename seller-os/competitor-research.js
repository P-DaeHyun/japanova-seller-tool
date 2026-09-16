(function(){
'use strict';

const API='https://japanova-seller-os-api.onrender.com';
const MARKETS=[
  {code:'TW',name:'대만',cur:'TWD',domain:'shopee.tw'},
  {code:'SG',name:'싱가포르',cur:'SGD',domain:'shopee.sg'},
  {code:'MY',name:'말레이시아',cur:'MYR',domain:'shopee.com.my'},
  {code:'TH',name:'태국',cur:'THB',domain:'shopee.co.th'},
  {code:'PH',name:'필리핀',cur:'PHP',domain:'shopee.ph'},
  {code:'VN',name:'베트남',cur:'VND',domain:'shopee.vn'},
  {code:'BR',name:'브라질',cur:'BRL',domain:'shopee.com.br',future:true}
];
const $=(s)=>document.querySelector(s);
const $$=(s)=>[...document.querySelectorAll(s)];
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=0)=>Number.isFinite(Number(n))?Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d}):'-';
let state={candidates:[],selectedId:null,market:'TW',providers:{},lastSearch:{},busy:false};

async function api(path,opts={}){
  const r=await fetch(`${API}${path}`,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(body.message||`HTTP ${r.status}`);
  return body;
}
function flash(msg,type='ok'){
  const b=$('#flash');if(!b)return;b.textContent=msg;b.className=`flash ${type}`;b.hidden=false;
  clearTimeout(flash.t);flash.t=setTimeout(()=>b.hidden=true,5000);
}
function market(code){return MARKETS.find(m=>m.code===code)}
function officialUrl(code,keyword){const m=market(code);return `https://${m.domain}/search?keyword=${encodeURIComponent(String(keyword||'').trim())}`}
function candidate(){return state.candidates.find(c=>c.id===state.selectedId)||null}
function plan(c,code){c.plans=c.plans||{};c.plans[code]=c.plans[code]||{};return c.plans[code]}
function items(c,code){const p=plan(c,code);p.researchItems=Array.isArray(p.researchItems)?p.researchItems:[];return p.researchItems}
function itemKey(x){return x.itemId&&x.shopId?`${x.shopId}:${x.itemId}`:(x.productUrl||`${x.title}|${x.priceLocal}`)}
function localPrice(n,cur){if(!Number.isFinite(Number(n)))return '-';const d=['SGD','MYR','BRL'].includes(cur)?2:0;return `${Number(n).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d})} ${cur}`}
function priceStats(c,code){const a=items(c,code).filter(x=>x.include!==false&&Number(x.priceLocal)>0).map(x=>Number(x.priceLocal)).sort((a,b)=>a-b);if(!a.length)return null;const i=Math.floor(a.length/2);return {count:a.length,min:a[0],median:a.length%2?a[i]:(a[i-1]+a[i])/2,max:a[a.length-1]}}

async function load(){
  const candidates=await api('/api/candidates');
  state.candidates=Array.isArray(candidates.candidates)?candidates.candidates:[];
  try{
    const providers=await api('/api/candidates/research/status');
    state.providers=Object.fromEntries((providers.markets||[]).map(x=>[x.marketCode,x]));
  }catch{
    state.providers={};
  }
  if(state.candidates.length&&!state.selectedId)state.selectedId=state.candidates[0].id;
  renderAll();
}
async function saveCandidate(c,{quiet=false}={}){
  const r=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:JSON.stringify(c)});
  const saved=r.candidate||c;const i=state.candidates.findIndex(x=>x.id===saved.id);if(i>=0)state.candidates[i]=saved;
  if(!quiet)flash('경쟁상품 조사내용을 후보상품 DB에 저장했어.');
  return saved;
}

function renderCandidateSelect(){
  const sel=$('#candidateSelect');
  if(!state.candidates.length){sel.innerHTML='<option value="">후보상품 없음</option>';sel.disabled=true;return}
  sel.disabled=false;sel.innerHTML=state.candidates.map(c=>`<option value="${esc(c.id)}" ${c.id===state.selectedId?'selected':''}>${esc(c.name)}</option>`).join('');
}
function renderMarketTabs(){
  $('#marketTabs').innerHTML=MARKETS.map(m=>`<button class="marketTab ${state.market===m.code?'on':''}" data-market="${m.code}">${m.name}<small>${state.providers[m.code]?.automaticSearch?'자동API':'검색보조'}${m.future?' · 향후':''}</small></button>`).join('');
  $$('#marketTabs [data-market]').forEach(b=>b.onclick=()=>{state.market=b.dataset.market;renderMarketTabs();renderResearch()});
}
function renderMetrics(){
  let collected=0,priced=0;for(const c of state.candidates){for(const m of MARKETS){collected+=items(c,m.code).length;if(Number(plan(c,m.code).competitorPrice)>0)priced++}}
  $('#mCandidates').textContent=fmt(state.candidates.length);
  $('#mAuto').textContent=fmt(Object.values(state.providers).filter(x=>x.automaticSearch).length);
  $('#mCollected').textContent=fmt(collected);$('#mPriced').textContent=fmt(priced);
}
function renderProvider(){
  const m=market(state.market),p=state.providers[state.market],b=$('#providerBadge');
  if(p?.automaticSearch){b.textContent=`${m.name} · Affiliate API 자동검색`;b.className='badge ok'}
  else{b.textContent=`${m.name} · 공식검색 보조`;b.className='badge warn'}
}
function renderResearch(){
  const c=candidate(),m=market(state.market);renderProvider();
  if(!c){$('#researchBody').innerHTML='<div class="empty">아직 후보상품이 없어. 검증센터에서 실제 조사할 상품을 먼저 후보로 만들어줘.</div>';return}
  const p=plan(c,state.market),arr=items(c,state.market),stats=priceStats(c,state.market),provider=state.providers[state.market],keyword=p.researchKeyword||c.name||'',last=state.lastSearch[state.market];
  $('#researchBody').innerHTML=`
    <div class="toolbar"><label>검색어<input id="keyword" class="input" value="${esc(keyword)}" placeholder="상품명 / 모델명 / 브랜드"></label><label>정렬<select id="sortType" class="select"><option value="1">관련도</option><option value="2">판매량</option><option value="4">낮은 가격</option><option value="3">높은 가격</option></select></label><div class="actions"><button class="btn" id="searchOne">${provider?.automaticSearch?'자동검색':'Shopee 검색 열기'}</button><button class="btn ghost" id="openShopee">공식검색 새 창</button><button class="btn ghost" id="searchAll">6개국 조사 준비</button></div></div>
    <div class="summaryGrid"><div class="summary"><span>수집 경쟁상품</span><b>${fmt(arr.length)}</b></div><div class="summary"><span>가격사용 상품</span><b>${stats?fmt(stats.count):'0'}</b></div><div class="summary"><span>최저가</span><b>${stats?localPrice(stats.min,m.cur):'-'}</b></div><div class="summary target"><span>대표 경쟁가 후보</span><b>${stats?localPrice(stats.median,m.cur):'-'}</b></div><div class="summary"><span>현재 검증센터 경쟁가</span><b>${Number(p.competitorPrice)>0?localPrice(p.competitorPrice,m.cur):'-'}</b></div></div>
    ${last?.message?`<div class="researchNote ${last.mode==='AUTO'?'ok':'warn'}">${esc(last.message)}</div>`:''}
    <div class="section-head"><div><h3>수집된 경쟁상품</h3><p>가격사용 체크된 상품만 대표 경쟁가 중앙값에 들어가.</p></div><div class="actions"><button class="btn" id="applyMedian" ${stats?'':'disabled'}>대표 경쟁가 반영</button><button class="btn red" id="clearMarket" ${arr.length?'':'disabled'}>이 국가 조사 초기화</button></div></div>
    <div class="tablewrap"><table><thead><tr><th>가격사용</th><th>상품</th><th>가격</th><th>판매</th><th>평점</th><th>출처</th><th>작업</th></tr></thead><tbody>${arr.length?arr.map((x,i)=>`<tr><td><input type="checkbox" data-include="${i}" ${x.include!==false?'checked':''}></td><td>${x.productUrl?`<a class="link" href="${esc(x.productUrl)}" target="_blank" rel="noopener">${esc(x.title||'상품')}</a>`:esc(x.title||'상품')}</td><td><b>${localPrice(x.priceLocal,m.cur)}</b>${x.priceMaxLocal&&Number(x.priceMaxLocal)!==Number(x.priceLocal)?`<div class="tiny">~ ${localPrice(x.priceMaxLocal,m.cur)}</div>`:''}</td><td>${x.sales==null?'-':fmt(x.sales)}</td><td>${x.rating==null?'-':fmt(x.rating,1)}</td><td>${x.source==='SHOPEE_AFFILIATE_OPEN_API'?'자동 API':'수동'}</td><td><button class="mini red" data-remove="${i}">삭제</button></td></tr>`).join(''):'<tr><td colspan="7" class="empty">아직 수집된 경쟁상품이 없어.</td></tr>'}</tbody></table></div>
    <div class="manual cardInner"><div class="section-head"><div><h3>수동 경쟁상품 추가</h3><p>공식 Shopee 검색에서 확인한 비교상품을 저장해. 자동 API가 붙으면 이 목록에 자동으로 들어와.</p></div></div><div class="manualGrid"><input id="manualTitle" class="input" placeholder="경쟁상품명"><input id="manualPrice" class="input" type="number" step="any" min="0" placeholder="가격 ${m.cur}"><input id="manualUrl" class="input" placeholder="Shopee 상품 URL"><input id="manualSales" class="input" type="number" min="0" placeholder="판매량(선택)"><input id="manualRating" class="input" type="number" step="0.1" min="0" max="5" placeholder="평점(선택)"><button class="btn" id="addManual">추가</button></div></div>`;
  bind(c,m,p,provider);
}
function bind(c,m,p,provider){
  $('#keyword').onchange=async()=>{p.researchKeyword=$('#keyword').value.trim();await saveCandidate(c,{quiet:true})};
  $('#searchOne').onclick=()=>runSearch(state.market);
  $('#openShopee').onclick=()=>openOfficial(state.market,$('#keyword').value.trim());
  $('#searchAll').onclick=runAll;
  $('#applyMedian').onclick=async()=>{const s=priceStats(c,state.market);if(!s)return;p.competitorPrice=s.median;p.competitorPriceSource='RESEARCH_MEDIAN';p.researchUpdatedAt=new Date().toISOString();await saveCandidate(c,{quiet:true});renderAll();flash(`${m.name} 대표 경쟁가 ${localPrice(s.median,m.cur)}를 검증센터에 반영했어.`)};
  $('#clearMarket').onclick=async()=>{if(!confirm(`${m.name} 경쟁상품 조사자료를 초기화할까?`))return;p.researchItems=[];p.researchUpdatedAt=new Date().toISOString();await saveCandidate(c,{quiet:true});renderAll()};
  $$('[data-include]').forEach(el=>el.onchange=async()=>{items(c,state.market)[Number(el.dataset.include)].include=el.checked;await saveCandidate(c,{quiet:true});renderAll()});
  $$('[data-remove]').forEach(el=>el.onclick=async()=>{items(c,state.market).splice(Number(el.dataset.remove),1);await saveCandidate(c,{quiet:true});renderAll()});
  $('#addManual').onclick=async()=>{const price=Number($('#manualPrice').value||0),title=$('#manualTitle').value.trim();if(!title||!(price>0))return flash('경쟁상품명과 가격을 입력해줘.','warn');items(c,state.market).push({title,priceLocal:price,priceMinLocal:price,priceMaxLocal:price,currency:m.cur,productUrl:$('#manualUrl').value.trim()||null,sales:$('#manualSales').value===''?null:Number($('#manualSales').value),rating:$('#manualRating').value===''?null:Number($('#manualRating').value),source:'MANUAL',include:true,addedAt:new Date().toISOString()});p.researchUpdatedAt=new Date().toISOString();await saveCandidate(c,{quiet:true});renderAll();flash('경쟁상품을 조사자료에 추가했어.')};
}
function openOfficial(code,keyword){const q=String(keyword||candidate()?.name||'').trim();if(!q)return flash('검색어를 입력해줘.','warn');window.open(officialUrl(code,q),'_blank','noopener')}
async function runSearch(code,{quiet=false}={}){
  const c=candidate();if(!c)return null;const p=plan(c,code),q=(code===state.market?$('#keyword')?.value:p.researchKeyword)||c.name;p.researchKeyword=String(q||'').trim();if(!p.researchKeyword){if(!quiet)flash('검색어를 입력해줘.','warn');return null}
  if(!state.providers[code]?.automaticSearch){state.lastSearch[code]={mode:'ASSISTED',message:'공식 Shopee 검색 보조모드 · 비교할 상품을 확인한 뒤 아래에 추가해줘.',searchUrl:officialUrl(code,p.researchKeyword)};await saveCandidate(c,{quiet:true});if(!quiet)openOfficial(code,p.researchKeyword);renderAll();return state.lastSearch[code]}
  try{
    const r=await api('/api/candidates/research/search',{method:'POST',body:JSON.stringify({marketCode:code,keyword:p.researchKeyword,sortType:code===state.market?Number($('#sortType')?.value||1):1,limit:12})});
    state.lastSearch[code]={mode:r.mode,message:r.mode==='AUTO'?`${r.results?.length||0}개 자동 수집 완료`:'공식 Shopee 검색 보조모드',searchUrl:r.searchUrl||officialUrl(code,p.researchKeyword)};
    if(r.mode==='AUTO'&&Array.isArray(r.results)){const arr=items(c,code),seen=new Set(arr.map(itemKey));for(const x of r.results){const k=itemKey(x);if(!seen.has(k)){seen.add(k);arr.push({...x,include:true,addedAt:new Date().toISOString()})}}}
    p.researchUpdatedAt=new Date().toISOString();await saveCandidate(c,{quiet:true});if(!quiet)flash(r.mode==='AUTO'?`${market(code).name} 경쟁상품을 자동 수집했어.`:`${market(code).name} 공식검색 보조모드야.` ,r.mode==='AUTO'?'ok':'warn');renderAll();return r;
  }catch(e){state.providers[code]={automaticSearch:false};state.lastSearch[code]={mode:'ASSISTED',message:'자동 API가 아직 라이브되지 않아 공식 Shopee 검색 보조모드로 전환했어.',searchUrl:officialUrl(code,p.researchKeyword)};await saveCandidate(c,{quiet:true});if(!quiet)openOfficial(code,p.researchKeyword);renderAll();return state.lastSearch[code]}
}
async function runAll(){if(state.busy)return;const c=candidate();if(!c)return;state.busy=true;try{for(const m of MARKETS.filter(x=>!x.future))await runSearch(m.code,{quiet:true});flash('6개국 조사 준비를 끝냈어. 자동 API 연결국은 수집하고, 나머지는 공식검색 보조 상태로 준비했어.')}finally{state.busy=false;renderAll()}}
function renderAll(){renderCandidateSelect();renderMarketTabs();renderMetrics();renderResearch()}

$('#candidateSelect').onchange=()=>{state.selectedId=$('#candidateSelect').value||null;renderAll()};
$('#openValidation').onclick=()=>location.href='./v10.html';
$('#navValidation').onclick=()=>location.href='./v10.html';
$('#navOps').onclick=()=>location.href='./v08.html';
(async()=>{try{await load();$('#status').textContent='v1.1 조사센터 · DB 연결';$('#status').className='badge ok'}catch(e){$('#status').textContent='조사센터 오류';$('#status').className='badge bad';flash(e.message,'bad')}})();
})();
