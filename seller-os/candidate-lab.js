(function(){
'use strict';

const API='https://japanova-seller-os-api.onrender.com';
const STORAGE_KEY='japanova_candidate_products_v1';
const MARKET_META=[
  {code:'TW',name:'대만',cur:'TWD',active:true},
  {code:'SG',name:'싱가포르',cur:'SGD',active:true},
  {code:'MY',name:'말레이시아',cur:'MYR',active:true},
  {code:'TH',name:'태국',cur:'THB',active:true},
  {code:'PH',name:'필리핀',cur:'PHP',active:true},
  {code:'VN',name:'베트남',cur:'VND',active:true},
  {code:'BR',name:'브라질',cur:'BRL',active:false}
];
const $=(s)=>document.querySelector(s);
const fmt=(n,d=0)=>Number.isFinite(Number(n))?Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d}):'-';
const jpy=(n)=>Number.isFinite(Number(n))?`¥${Math.round(Number(n)).toLocaleString('ko-KR')}`:'-';
const pct=(n)=>Number.isFinite(Number(n))?`${(Number(n)*100).toFixed(1)}%`:'-';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
let state={candidates:[],selectedId:null,calcData:null,fx:null,dbStorage:false};

function uid(){return `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`.toUpperCase()}
function blankCandidate(){return {id:uid(),name:'',sourceUrl:'',supplier:'',purchaseCostJpy:0,packagingCostJpy:0,domesticShippingJpy:0,otherCostJpy:0,weightG:200,lengthCm:0,widthCm:0,heightCm:0,discountPct:0,payoneerPct:2,fxBufferPct:2,targetMarginPct:20,initialUnits:1,status:'RESEARCH',note:'',plans:{},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}
function readLocal(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(raw)?raw:[]}catch{return []}}
function saveLocal(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state.candidates))}
function selected(){return state.candidates.find(x=>x.id===state.selectedId)||null}
function num(id){return Number($(id)?.value||0)||0}
function setVal(id,v){if($(id))$(id).value=v??''}
function flash(msg,type='ok'){const b=$('#flash');b.textContent=msg;b.className=`flash ${type}`;b.hidden=false;clearTimeout(flash.t);flash.t=setTimeout(()=>b.hidden=true,5000)}
async function api(path,opts={}){const r=await fetch(`${API}${path}`,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.message||`HTTP ${r.status}`);return body}

async function loadReference(){
  const [calc,fx]=await Promise.all([
    fetch('../data.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('국가별 수수료/SLS 데이터를 불러오지 못했습니다.');return r.json()}),
    api('/api/fx').catch(async()=>{const r=await fetch('../fx.json',{cache:'no-store'});if(!r.ok)throw new Error('환율 데이터를 불러오지 못했습니다.');return r.json()})
  ]);
  state.calcData=calc;state.fx=fx;
  $('#dataVersion').textContent=`요금 ${calc.dataVersion||'-'} · 환율 ${fx.sourceDate||'-'}`;
}

async function persistCandidate(candidate,{silent=false}={}){
  saveLocal();
  if(!state.dbStorage)return candidate;
  try{
    const r=await api(`/api/candidates/${encodeURIComponent(candidate.id)}`,{method:'PUT',body:JSON.stringify(candidate)});
    const saved=r.candidate||candidate;
    const i=state.candidates.findIndex(x=>x.id===saved.id);if(i>=0)state.candidates[i]=saved;
    saveLocal();
    return saved;
  }catch(e){
    state.dbStorage=false;
    $('#status').textContent='분석 정상 · 로컬 백업모드';$('#status').className='badge warn';
    if(!silent)flash(`서버 저장 실패, 브라우저에 보관 중: ${e.message}`,'warn');
    return candidate;
  }
}

async function loadCandidates(){
  const cached=readLocal();
  try{
    const r=await api('/api/candidates');
    state.dbStorage=true;
    let server=Array.isArray(r.candidates)?r.candidates:[];
    if(!server.length&&cached.length){
      const migrated=[];
      for(const c of cached){
        try{const saved=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:JSON.stringify(c)});migrated.push(saved.candidate||c)}catch{migrated.push(c)}
      }
      server=migrated;
    }
    state.candidates=server;
    saveLocal();
    $('#status').textContent='분석엔진 정상 · DB 저장';$('#status').className='badge ok';
  }catch{
    state.dbStorage=false;
    state.candidates=cached;
    $('#status').textContent='분석엔진 정상 · 로컬 백업';$('#status').className='badge warn';
  }
}

function marketByCode(code){return MARKET_META.find(m=>m.code===code)}
function assumptionFor(code){const m=marketByCode(code);return m?state.calcData?.markets?.[m.name]||null:null}
function baseFxFor(code){const m=marketByCode(code);return m?Number(state.fx?.jpyPer?.[m.cur]||0):0}
function marketInput(c,code){const a=assumptionFor(code),fx=baseFxFor(code);if(!a||!fx)return null;return {market:a,baseFx:fx,buffer:Number(c.fxBufferPct||0)/100,discount:Number(c.discountPct||0)/100,payoneer:Number(c.payoneerPct||0)/100,purchaseCostJpy:Number(c.purchaseCostJpy||0),packagingCostJpy:Number(c.packagingCostJpy||0),domesticShippingJpy:Number(c.domesticShippingJpy||0),otherCostJpy:Number(c.otherCostJpy||0),weightG:Number(c.weightG||1),dims:{lengthCm:Number(c.lengthCm||0),widthCm:Number(c.widthCm||0),heightCm:Number(c.heightCm||0)}}}
function roundLocal(v,cur){const step=['SGD','MYR','BRL'].includes(cur)?0.01:1;return Math.ceil(Number(v||0)/step)*step}
function local(v,cur){if(!Number.isFinite(Number(v)))return '-';const d=['SGD','MYR','BRL'].includes(cur)?2:0;return `${Number(v).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d})} ${cur}`}
function solve(c,code,target){const input=marketInput(c,code);if(!input)return null;try{return JAPANOVA_MARGIN.solveTarget({...input,targetMargin:target})}catch(e){return {error:e.message}}}
function evaluatePlan(c,code){const plan=c.plans?.[code]||{};const price=Number(plan.plannedPrice||0);if(!(price>0))return null;const input=marketInput(c,code);if(!input)return null;try{return JAPANOVA_MARGIN.evaluate({...input,listedLocal:price})}catch(e){return {error:e.message}}}
function risk(evalr,target){if(!evalr||evalr.error)return {label:'미계산',cls:'muted'};if(evalr.profitJpy<0)return {label:'적자',cls:'bad'};if(evalr.margin<0.10)return {label:'위험',cls:'bad'};if(evalr.margin<target)return {label:'저마진',cls:'warn'};return {label:'기준통과',cls:'ok'}}
function analyzeSummary(c){let pass=0,loss=0,planned=0;for(const m of MARKET_META.filter(x=>x.active)){const e=evaluatePlan(c,m.code);if(!e)continue;planned++;if(!e.error&&e.profitJpy<0)loss++;if(!e.error&&e.profitJpy>=0&&e.margin>=Number(c.targetMarginPct||20)/100)pass++}return {pass,loss,planned}}

function renderMetrics(){const total=state.candidates.length;const ready=state.candidates.filter(x=>x.status==='READY').length;let loss=0,passMarkets=0,cash=0;for(const c of state.candidates){const s=analyzeSummary(c);loss+=s.loss;passMarkets+=s.pass;cash+=Number(c.purchaseCostJpy||0)*Math.max(1,Number(c.initialUnits||1))}$('#mCandidates').textContent=fmt(total);$('#mReady').textContent=fmt(ready);$('#mLoss').textContent=fmt(loss);$('#mPass').textContent=fmt(passMarkets);$('#mCash').textContent=jpy(cash)}
function renderList(){const body=$('#candidateRows');if(!state.candidates.length){body.innerHTML='<tr><td colspan="7" class="empty">아직 후보상품이 없어. 오른쪽에서 첫 후보를 만들어도 돼.</td></tr>';return}body.innerHTML=state.candidates.map(c=>{const s=analyzeSummary(c);const status=c.status==='READY'?'<span class="ok">등록 후보</span>':c.status==='HOLD'?'<span class="warn">보류</span>':'조사중';return `<tr class="${c.id===state.selectedId?'sel':''}"><td><button class="link" data-open="${esc(c.id)}">${esc(c.name||'(이름 없음)')}</button></td><td>${jpy(c.purchaseCostJpy)}</td><td>${fmt(c.weightG)}g</td><td>${status}</td><td class="ok">${s.pass}</td><td class="${s.loss?'bad':'muted'}">${s.loss}</td><td><button class="mini" data-open="${esc(c.id)}">분석</button></td></tr>`}).join('');body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openCandidate(b.dataset.open))}

function fillForm(c){$('#formTitle').textContent=c?'후보상품 편집':'새 후보상품';const x=c||blankCandidate();setVal('#cName',x.name);setVal('#cSource',x.sourceUrl);setVal('#cSupplier',x.supplier);setVal('#cPurchase',x.purchaseCostJpy);setVal('#cPack',x.packagingCostJpy);setVal('#cDomestic',x.domesticShippingJpy);setVal('#cOther',x.otherCostJpy);setVal('#cWeight',x.weightG);setVal('#cL',x.lengthCm);setVal('#cW',x.widthCm);setVal('#cH',x.heightCm);setVal('#cDiscount',x.discountPct);setVal('#cPayoneer',x.payoneerPct);setVal('#cFxBuffer',x.fxBufferPct);setVal('#cTarget',x.targetMarginPct);setVal('#cUnits',x.initialUnits);setVal('#cNote',x.note);setVal('#cStatus',x.status||'RESEARCH');$('#candidateId').value=c?.id||''}
function readForm(){const existing=selected();const id=$('#candidateId').value||uid();return {...(existing||{}),id,name:$('#cName').value.trim(),sourceUrl:$('#cSource').value.trim(),supplier:$('#cSupplier').value.trim(),purchaseCostJpy:num('#cPurchase'),packagingCostJpy:num('#cPack'),domesticShippingJpy:num('#cDomestic'),otherCostJpy:num('#cOther'),weightG:Math.max(1,num('#cWeight')),lengthCm:num('#cL'),widthCm:num('#cW'),heightCm:num('#cH'),discountPct:num('#cDiscount'),payoneerPct:num('#cPayoneer'),fxBufferPct:num('#cFxBuffer'),targetMarginPct:num('#cTarget'),initialUnits:Math.max(1,num('#cUnits')),status:$('#cStatus').value,note:$('#cNote').value.trim(),plans:existing?.plans||{},createdAt:existing?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()}}
async function saveCandidate(){const c=readForm();if(!c.name){flash('후보상품 이름을 입력해줘.','warn');return}if(!(c.purchaseCostJpy>0)){flash('매입원가는 0보다 커야 해.','warn');return}const i=state.candidates.findIndex(x=>x.id===c.id);if(i>=0)state.candidates[i]=c;else state.candidates.unshift(c);state.selectedId=c.id;saveLocal();const saved=await persistCandidate(c);state.selectedId=saved.id;renderAll();fillForm(saved);flash(state.dbStorage?'후보상품을 DB에 저장하고 분석했어.':'후보상품을 로컬에 저장하고 분석했어.')}
function newCandidate(){state.selectedId=null;fillForm(null);$('#analysis').innerHTML='<div class="empty">후보상품을 저장하면 7개국 분석표가 만들어져.</div>'}
function openCandidate(id){state.selectedId=id;fillForm(selected());renderList();renderAnalysis()}
async function deleteCandidate(){const c=selected();if(!c)return;if(!confirm(`“${c.name}” 후보를 삭제할까?`))return;if(state.dbStorage){try{await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'DELETE'})}catch(e){flash(`DB 삭제 실패: ${e.message}`,'bad');return}}state.candidates=state.candidates.filter(x=>x.id!==c.id);state.selectedId=null;saveLocal();renderAll();newCandidate();flash('후보상품을 삭제했어.')}

function renderAnalysis(){const c=selected();if(!c){$('#analysis').innerHTML='<div class="empty">왼쪽 후보상품을 선택해.</div>';return}const target=Number(c.targetMarginPct||20)/100;const rows=MARKET_META.map(m=>{const a=assumptionFor(m.code),fx=baseFxFor(m.code);const plan=c.plans?.[m.code]||{};if(!a||!fx){return `<tr><td>${m.name}<div class="muted">${m.code} · ${m.cur}</div></td><td>${fx?fmt(fx,6):'-'}</td><td colspan="5" class="warn">수수료/SLS 기준 미확정 · 계산 보류</td><td><input class="plan" data-code="${m.code}" data-field="competitorPrice" type="number" step="any" value="${esc(plan.competitorPrice||'')}" placeholder="경쟁가"></td><td colspan="3" class="muted">브라질은 확정 데이터가 생기면 자동 계산 대상에 포함</td></tr>`}const b0=solve(c,m.code,0),b10=solve(c,m.code,.10),b20=solve(c,m.code,.20),b30=solve(c,m.code,.30),ev=evaluatePlan(c,m.code),rk=risk(ev,target);const shipping=(!b20||b20.error)?'-':jpy(b20.shippingJpy);return `<tr><td><b>${m.name}</b><div class="muted">${m.code} · ${m.cur}</div></td><td>${fmt(fx,fx<0.1?6:4)}</td><td>${shipping}</td><td>${b0?.error?'<span class="bad">오류</span>':local(roundLocal(b0?.listedLocal,m.cur),m.cur)}</td><td>${b10?.error?'-':local(roundLocal(b10?.listedLocal,m.cur),m.cur)}</td><td class="target">${b20?.error?'-':local(roundLocal(b20?.listedLocal,m.cur),m.cur)}</td><td>${b30?.error?'-':local(roundLocal(b30?.listedLocal,m.cur),m.cur)}</td><td><input class="plan" data-code="${m.code}" data-field="competitorPrice" type="number" step="any" value="${esc(plan.competitorPrice||'')}" placeholder="경쟁가"></td><td><input class="plan" data-code="${m.code}" data-field="plannedPrice" type="number" step="any" value="${esc(plan.plannedPrice||'')}" placeholder="내 판매가"></td><td class="${ev&&!ev.error&&ev.profitJpy<0?'bad':'money'}">${ev&&!ev.error?jpy(ev.profitJpy):'-'}</td><td class="${rk.cls}">${ev&&!ev.error?pct(ev.margin):'-'}<div>${rk.label}</div></td></tr>`}).join('');const totalCost=Number(c.purchaseCostJpy)+Number(c.packagingCostJpy)+Number(c.domesticShippingJpy)+Number(c.otherCostJpy);const cash=Number(c.purchaseCostJpy||0)*Math.max(1,Number(c.initialUnits||1));$('#analysis').innerHTML=`<div class="analysisHead"><div><h3>${esc(c.name)}</h3><div class="muted">단위원가 ${jpy(totalCost)} · 예상 초기매입 ${fmt(c.initialUnits)}개 = ${jpy(cash)} · 목표마진 ${fmt(c.targetMarginPct)}%</div></div><div class="chips"><span>FX 버퍼 ${fmt(c.fxBufferPct)}%</span><span>Payoneer ${fmt(c.payoneerPct)}%</span><span>예상 할인 ${fmt(c.discountPct)}%</span></div></div><div class="tablewrap"><table><thead><tr><th>국가</th><th>1통화=JPY</th><th>20%시 SLS</th><th>손익분기</th><th>10%</th><th>20% 목표</th><th>30%</th><th>경쟁가</th><th>예상 판매가</th><th>예상 이익</th><th>판정</th></tr></thead><tbody>${rows}</tbody></table></div><div class="legend"><span class="bad">적자/위험</span> · <span class="warn">목표마진 미달</span> · <span class="ok">목표마진 이상</span> · 판매가가 비어 있으면 손익분기/목표가격만 참고하면 돼.</div>`;$('#analysis').querySelectorAll('.plan').forEach(inp=>inp.onchange=async()=>{const cur=selected();if(!cur)return;cur.plans=cur.plans||{};cur.plans[inp.dataset.code]=cur.plans[inp.dataset.code]||{};cur.plans[inp.dataset.code][inp.dataset.field]=Number(inp.value||0)||0;cur.updatedAt=new Date().toISOString();saveLocal();await persistCandidate(cur,{silent:true});renderAnalysis();renderMetrics();renderList()})}

function renderAll(){renderMetrics();renderList();renderAnalysis()}
function exportJson(){const blob=new Blob([JSON.stringify({version:2,storage:state.dbStorage?'postgresql':'local-cache',exportedAt:new Date().toISOString(),candidates:state.candidates},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`JAPANOVA_candidates_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
function importJson(file){const r=new FileReader();r.onload=async()=>{try{const d=JSON.parse(r.result);const arr=Array.isArray(d)?d:d.candidates;if(!Array.isArray(arr))throw new Error('candidates 배열이 없습니다.');state.candidates=arr;state.selectedId=null;saveLocal();if(state.dbStorage){for(const c of arr){await persistCandidate(c,{silent:true})}}renderAll();newCandidate();flash(`${arr.length}개 후보상품을 복원했어.`)}catch(e){flash(`복원 실패: ${e.message}`,'bad')}};r.readAsText(file)}
function openOperations(){document.body.classList.add('ops');$('#labView').hidden=true;$('#opsView').hidden=false;$('#navLab').classList.remove('on');$('#navOps').classList.add('on')}
function openLab(){document.body.classList.remove('ops');$('#opsView').hidden=true;$('#labView').hidden=false;$('#navOps').classList.remove('on');$('#navLab').classList.add('on')}

async function boot(){
  newCandidate();
  try{await loadReference()}catch(e){$('#status').textContent='분석데이터 오류';$('#status').className='badge bad';flash(e.message,'bad')}
  await loadCandidates();
  renderAll();
  $('#saveCandidate').onclick=saveCandidate;$('#newCandidate').onclick=newCandidate;$('#deleteCandidate').onclick=deleteCandidate;$('#exportCandidates').onclick=exportJson;$('#importFile').onchange=(e)=>{if(e.target.files?.[0])importJson(e.target.files[0]);e.target.value=''};$('#navLab').onclick=openLab;$('#navOps').onclick=openOperations;
}
boot();
})();