const MARKETS=[
  {code:'TW',name:'대만',currency:'TWD',future:false},
  {code:'SG',name:'싱가포르',currency:'SGD',future:false},
  {code:'MY',name:'말레이시아',currency:'MYR',future:false},
  {code:'TH',name:'태국',currency:'THB',future:false},
  {code:'PH',name:'필리핀',currency:'PHP',future:false},
  {code:'VN',name:'베트남',currency:'VND',future:false},
  {code:'BR',name:'브라질',currency:'BRL',future:true}
];

const $=(s)=>document.querySelector(s);
const $$=(s)=>[...document.querySelectorAll(s)];
const fmt=(n,d=0)=>Number.isFinite(Number(n))?Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d}):'-';
const moneyJpy=(n)=>Number.isFinite(Number(n))?`¥${Math.round(Number(n)).toLocaleString('ko-KR')}`:'-';
const pct=(n)=>Number.isFinite(Number(n))?`${(Number(n)*100).toFixed(1)}%`:'-';

let API_BASE=(window.JAPANOVA_API_BASE||localStorage.getItem('japanova_api_base')||'').replace(/\/$/,'');
let state={fx:null,markets:null,dashboard:null,connections:[],products:[],orders:[],profits:[]};

function setBusy(v){document.body.classList.toggle('loader',v)}
function apiUrl(path){return `${API_BASE}${path}`}
async function api(path,opts={}){
  if(!API_BASE) throw new Error('백엔드 주소가 아직 설정되지 않았습니다.');
  const r=await fetch(apiUrl(path),{
    ...opts,
    headers:{'Content-Type':'application/json',...(opts.headers||{})}
  });
  const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.message||`HTTP ${r.status}`);
  return body;
}

function backendConfigured(){return Boolean(API_BASE)}
function flash(msg,type='success'){
  const box=$('#flash');
  box.className=`callout ${type==='error'?'danger':type==='warn'?'':'success'}`;
  box.textContent=msg;
  box.hidden=false;
  clearTimeout(flash._t);
  flash._t=setTimeout(()=>box.hidden=true,5000);
}

function switchView(name){
  $$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  const titles={dashboard:['JAPANOVA 운영 대시보드','Shopee 상품 · 주문 · 정산 · 실제 순이익을 한 곳에서 관리'],products:['상품 관리','Shopee 상품과 일본 매입원가를 SKU 기준으로 연결'],orders:['주문 관리','7개국 주문과 배송상태를 한글로 확인'],profits:['수익 분석','Shopee 실제 정산액과 JAPANOVA 원가를 결합'],margin:['마진 계산기','판매 전 예상 판매가와 목표 순이익률 계산'],connections:['Shopee 연결 관리','7개국 Shop 인증 · Token 상태 · 동기화'],fx:['환율 관리','JPY 기준 7개국 환율 자동갱신과 안전마진 관리']};
  const [t,s]=titles[name]||titles.dashboard;
  $('#pageTitle').textContent=t; $('#pageSub').textContent=s;
  if(name==='products') loadProducts();
  if(name==='orders') loadOrders();
  if(name==='profits') loadProfits();
  if(name==='connections') loadConnections();
  if(name==='fx') renderFxDetail();
}

async function loadFx(force=false){
  try{
    if(API_BASE){
      state.fx=force?await api('/api/fx/refresh',{method:'POST',body:'{}'}):await api('/api/fx');
    }else{
      const r=await fetch(`../fx.json${force?'?t='+Date.now():''}`,{cache:force?'no-store':'default'});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const raw=await r.json();
      const buffer=raw.fxBufferDefault??0.02;
      state.fx={...raw,fxBuffer:buffer,priceFx:Object.fromEntries(Object.entries(raw.jpyPer||{}).map(([c,v])=>[c,Number(v)*(1-buffer)]))};
    }
    renderMarketCards(); renderFxDetail();
    const label=state.fx.status==='stale'?'환율 오래됨':state.fx.status==='warning'?'환율 주의':'환율 정상';
    $('#fxTop').textContent=`${label} · ${state.fx.provider||state.fx.source||''}`;
  }catch(e){
    $('#fxTop').textContent='환율 불러오기 실패';
    flash(`환율 오류: ${e.message}`,'error');
  }
}

async function loadMarkets(){
  if(!API_BASE){state.markets=MARKETS.map(m=>({...m,connectionStatus:m.future?'향후 입점':'미연동',connectedShops:0}));renderMarketCards();return}
  try{state.markets=await api('/api/markets');renderMarketCards()}catch(e){flash(e.message,'error')}
}

function renderMarketCards(){
  const list=state.markets||MARKETS.map(m=>({...m,connectionStatus:m.future?'향후 입점':'미연동'}));
  const byCode=Object.fromEntries(list.map(m=>[m.code,m]));
  $('#markets').innerHTML=MARKETS.map(m=>{
    const server=byCode[m.code]||m;
    const rate=Number(state.fx?.jpyPer?.[m.currency]||0)||null;
    const pfx=Number(state.fx?.priceFx?.[m.currency]||0)||null;
    const st=server.connectionStatus|| (m.future?'향후 입점':'미연동');
    const cls=st==='연결됨'?'on':m.future?'future':'';
    return `<div class="card market"><div><span class="name">${m.name}</span><span class="code">${m.code} · ${m.currency}</span></div><span class="status ${cls}">${st}</span><div class="fx"><div class="fxline"><span>기준 환율</span><strong>${rate?`1 ${m.currency} = ${fmt(rate,rate<0.1?6:4)} JPY`:'자동갱신 대기'}</strong></div><div class="buffer">판매가 계산환율: ${pfx?fmt(pfx,pfx<0.1?6:4)+' JPY':'-'} · 안전마진 ${((state.fx?.fxBuffer??0.02)*100).toFixed(0)}%</div></div></div>`
  }).join('');
}

async function loadDashboard(){
  if(!API_BASE){renderDashboard(null);return}
  try{state.dashboard=await api('/api/dashboard');renderDashboard(state.dashboard)}catch(e){flash(e.message,'error')}
}
function renderDashboard(d){
  $('#mOrders').textContent=d?fmt(d.todayOrders):'-';
  $('#mSales').textContent=d?moneyJpy(d.todaySalesJpy):'-';
  $('#mProfit').textContent=d?moneyJpy(d.profit30DaysJpy):'-';
  $('#mShops').textContent=d?`${d.connectedShops} / 7`:'0 / 7';
}

async function loadConnections(){
  if(!API_BASE){renderConnections([]);return}
  try{const d=await api('/api/shopee/connections');state.connections=d.connections||[];renderConnections(state.connections)}catch(e){flash(e.message,'error')}
}
function renderConnections(rows){
  const box=$('#connectionRows');
  if(!rows.length){box.innerHTML='<div class="empty">아직 연결된 Production Shop이 없어. Sandbox 검증은 완료됐고, Go-Live 후 실제 Shop을 연결하면 여기에 표시돼.</div>';return}
  box.innerHTML=rows.map(r=>`<div class="row"><div><b>${r.market_code||'미확인'} · ${r.shop_name||r.shop_id}</b><div class="muted">Shop ID ${r.shop_id} · Merchant ${r.merchant_id||'-'}</div></div><span class="ok">${r.status==='CONNECTED'?'연결됨':r.status}</span></div>`).join('');
}

async function loadProducts(){
  if(!API_BASE){renderProducts([]);return}
  try{const d=await api('/api/products');state.products=d.products||[];renderProducts(state.products)}catch(e){flash(e.message,'error')}
}
function renderProducts(rows){
  const body=$('#productsBody');
  if(!rows.length){body.innerHTML='<tr><td colspan="8" class="empty">동기화된 상품이 없어.</td></tr>';return}
  body.innerHTML=rows.map(p=>`<tr><td>${p.market_code||'-'}</td><td>${p.item_sku||'-'}</td><td>${p.item_id}</td><td>${p.item_name||'(상품 상세정보 동기화 전)'}</td><td>${p.item_status||'-'}</td><td class="num">${p.purchase_cost_jpy==null?'-':moneyJpy(p.purchase_cost_jpy)}</td><td class="num">${p.packaging_cost_jpy==null?'-':moneyJpy(p.packaging_cost_jpy)}</td><td>${p.synced_at?new Date(p.synced_at).toLocaleString('ko-KR'):'-'}</td></tr>`).join('');
}

async function loadOrders(){
  if(!API_BASE){renderOrders([]);return}
  try{const d=await api('/api/orders?limit=300');state.orders=d.orders||[];renderOrders(state.orders)}catch(e){flash(e.message,'error')}
}
function renderOrders(rows){
  const body=$('#ordersBody');
  if(!rows.length){body.innerHTML='<tr><td colspan="8" class="empty">동기화된 주문이 없어.</td></tr>';return}
  body.innerHTML=rows.map(o=>`<tr><td>${o.market_code||'-'}</td><td>${o.order_sn}</td><td><span class="pill">${o.order_status_ko||o.order_status||'-'}</span></td><td>${o.currency||'-'}</td><td class="num">${fmt(o.total_amount,2)}</td><td class="num">${o.fx_jpy_per?fmt(o.fx_jpy_per,6):'-'}</td><td class="num">${o.total_amount&&o.fx_jpy_per?moneyJpy(Number(o.total_amount)*Number(o.fx_jpy_per)):'-'}</td><td>${o.created_time_shopee?new Date(o.created_time_shopee).toLocaleString('ko-KR'):'-'}</td></tr>`).join('');
}

async function loadProfits(){
  if(!API_BASE){renderProfits([]);return}
  try{const d=await api('/api/profits');state.profits=d.profits||[];renderProfits(state.profits)}catch(e){flash(e.message,'error')}
}
function renderProfits(rows){
  const body=$('#profitsBody');
  if(!rows.length){body.innerHTML='<tr><td colspan="8" class="empty">계산된 실제 순이익이 없어. 상품 원가를 저장하고 주문/정산 동기화를 하면 계산돼.</td></tr>';return}
  body.innerHTML=rows.map(p=>`<tr><td>${p.market_code||'-'}</td><td>${p.order_sn}</td><td class="num">${moneyJpy(p.shopee_settlement_jpy)}</td><td class="num">${moneyJpy(p.purchase_cost_jpy)}</td><td class="num">${moneyJpy(p.packaging_cost_jpy)}</td><td class="num">${moneyJpy(p.domestic_shipping_jpy)}</td><td class="num money ${Number(p.actual_profit_jpy)>=0?'positive':'negative'}">${moneyJpy(p.actual_profit_jpy)}</td><td class="num">${pct(p.actual_margin)}</td></tr>`).join('');
}

function renderFxDetail(){
  const box=$('#fxRows');
  if(!state.fx){box.innerHTML='<div class="empty">환율을 불러오는 중이야.</div>';return}
  box.innerHTML=MARKETS.map(m=>{const r=state.fx.jpyPer?.[m.currency];const p=state.fx.priceFx?.[m.currency];return `<div class="row"><div><b>${m.name} · ${m.currency}</b><div class="muted">1 ${m.currency} = ${r?fmt(r,r<0.1?6:4):'-'} JPY</div></div><span>판매가 계산 ${p?fmt(p,p<0.1?6:4):'-'} JPY</span></div>`}).join('');
  const warning=[...(state.fx.warnings||[]),...(state.fx.errors||[])];
  $('#fxWarnings').innerHTML=warning.length?warning.map(v=>`<div>• ${v}</div>`):'환율 소스 간 큰 차이 없음';
  $('#fxMeta').textContent=`출처: ${state.fx.provider||state.fx.source||'-'} · 기준일: ${state.fx.sourceDate||'-'} · 안전마진 ${((state.fx.fxBuffer??0.02)*100).toFixed(1)}%`;
}

async function syncAll(){
  if(!API_BASE){flash('먼저 백엔드 주소를 설정해줘.','warn');return}
  setBusy(true);
  try{const r=await api('/api/shopee/sync-all',{method:'POST',body:JSON.stringify({days:7})});const ok=(r.results||[]).filter(x=>x.ok).length;flash(`전체 동기화 완료: ${ok}/${(r.results||[]).length} Shop`);await Promise.all([loadDashboard(),loadMarkets(),loadProducts(),loadOrders(),loadProfits(),loadConnections()])}catch(e){flash(e.message,'error')}finally{setBusy(false)}
}

function saveApiBase(){
  const v=$('#apiBaseInput').value.trim().replace(/\/$/,'');
  API_BASE=v;
  if(v)localStorage.setItem('japanova_api_base',v);else localStorage.removeItem('japanova_api_base');
  $('#backendState').textContent=v?'백엔드 주소 저장됨':'백엔드 미설정';
  flash(v?'백엔드 주소를 저장했어. 연결 상태를 확인할게.':'백엔드 주소를 비웠어.','success');
  bootData();
}

async function testBackend(){
  if(!API_BASE){flash('백엔드 주소를 입력해줘.','warn');return}
  try{const d=await api('/api/health');flash(`백엔드 정상 · DB ${d.database} · Shopee ${d.shopeeEnvironment}`);$('#backendState').textContent=`백엔드 정상 · DB ${d.database}`}catch(e){flash(`백엔드 연결 실패: ${e.message}`,'error')}
}

async function bootData(){
  setBusy(true);
  try{await Promise.all([loadFx(false),loadMarkets(),loadDashboard(),loadConnections()])}finally{setBusy(false)}
}

window.addEventListener('DOMContentLoaded',()=>{
  $$('.nav button').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  $('#refreshFx').addEventListener('click',()=>loadFx(true));
  $('#syncAll').addEventListener('click',syncAll);
  $('#saveApiBase').addEventListener('click',saveApiBase);
  $('#testBackend').addEventListener('click',testBackend);
  $('#apiBaseInput').value=API_BASE;
  $('#backendState').textContent=API_BASE?'백엔드 주소 설정됨':'백엔드 미설정';
  $('#openMargin').addEventListener('click',()=>location.href='../index.html');
  renderMarketCards(); renderDashboard(null); renderFxDetail(); bootData();
});
