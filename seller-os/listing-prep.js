(function(){
'use strict';

const API='https://japanova-seller-os-api.onrender.com';
const MARKETS=[
  {code:'TW',name:'대만',cur:'TWD',lang:'zh-hant'},
  {code:'SG',name:'싱가포르',cur:'SGD',lang:'en'},
  {code:'MY',name:'말레이시아',cur:'MYR',lang:'en'},
  {code:'TH',name:'태국',cur:'THB',lang:'en'},
  {code:'PH',name:'필리핀',cur:'PHP',lang:'en'},
  {code:'VN',name:'베트남',cur:'VND',lang:'en'},
  {code:'BR',name:'브라질',cur:'BRL',lang:'pt-br',future:true}
];
const $=(s)=>document.querySelector(s);
const $$=(s)=>[...document.querySelectorAll(s)];
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,d=0)=>Number.isFinite(Number(n))?Number(n).toLocaleString('ko-KR',{maximumFractionDigits:d}):'-';
const localPrice=(n,cur)=>Number(n)>0?`${Number(n).toLocaleString('ko-KR',{maximumFractionDigits:['SGD','MYR','BRL'].includes(cur)?2:0})} ${cur}`:'-';
let state={candidates:[],selectedId:null,market:'TW',listingStatus:{environment:'unknown',connections:[]},categoryCache:{},attributeCache:{},logisticsCache:{},busy:false};

async function api(path,opts={}){
  const r=await fetch(`${API}${path}`,{...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});
  const body=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(body.message||`HTTP ${r.status}`);
  return body;
}
function flash(msg,type='ok'){
  const b=$('#flash');if(!b)return;b.textContent=msg;b.className=`flash ${type}`;b.hidden=false;
  clearTimeout(flash.t);flash.t=setTimeout(()=>b.hidden=true,5200);
}
function market(code){return MARKETS.find(m=>m.code===code)}
function candidate(){return state.candidates.find(c=>c.id===state.selectedId)||null}
function plan(c,code){c.plans=c.plans||{};c.plans[code]=c.plans[code]||{};return c.plans[code]}
function cleanSku(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100)}
function lines(v){return String(v||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean)}
function uniq(a){return [...new Set(a)]}
function now(){return new Date().toISOString()}
function baseSku(c,code){const raw=cleanSku(c.id||c.name||'ITEM');return `JNV-${(raw||'ITEM').slice(-24)}-${code}`.slice(0,100)}
function defaultDescription(c,code){
  if(code==='TW') return `商品名稱：${c.name}\n\n日本採購商品。\n出貨地：日本\n購買前請確認商品圖片、規格、尺寸、容量與數量。\n若商品包裝或設計因製造商更新而變更，請以實際商品為準。`;
  return `Product: ${c.name}\n\nSourced in Japan.\nShips from Japan.\nPlease check the product images, specifications, size, capacity and quantity before purchase.\nPackaging or design may be updated by the manufacturer.`;
}
function draft(c,code){
  const p=plan(c,code);
  if(!p.listingDraft||typeof p.listingDraft!=='object'||Array.isArray(p.listingDraft)){
    p.listingDraft={
      enabled:p.decision==='SELL',
      title:'',description:'',sku:baseSku(c,code),priceLocal:Number(p.plannedPrice||0),
      categoryId:'',categoryName:'',brandName:'',condition:'NEW',gtin:'',initialStock:0,
      weightG:Number(c.weightG||0),lengthCm:Number(c.lengthCm||0),widthCm:Number(c.widthCm||0),heightCm:Number(c.heightCm||0),
      imageUrls:[],imageIds:[],logistics:[],attributes:[],mandatoryAttributeIds:[],
      selectedShopId:null,notes:'',updatedAt:now()
    };
  }
  const d=p.listingDraft;
  d.imageUrls=Array.isArray(d.imageUrls)?d.imageUrls:[];
  d.imageIds=Array.isArray(d.imageIds)?d.imageIds:[];
  d.logistics=Array.isArray(d.logistics)?d.logistics:[];
  d.attributes=Array.isArray(d.attributes)?d.attributes:[];
  d.mandatoryAttributeIds=Array.isArray(d.mandatoryAttributeIds)?d.mandatoryAttributeIds:[];
  return d;
}
function applySafeDefaults(c,code){
  const d=draft(c,code),p=plan(c,code);
  if(!d.title)d.title=c.name||'';
  if(!d.description)d.description=defaultDescription(c,code);
  if(!d.sku)d.sku=baseSku(c,code);
  if(!(Number(d.priceLocal)>0)&&Number(p.plannedPrice)>0)d.priceLocal=Number(p.plannedPrice);
  if(!(Number(d.weightG)>0)&&Number(c.weightG)>0)d.weightG=Number(c.weightG);
  if(!(Number(d.lengthCm)>0)&&Number(c.lengthCm)>0)d.lengthCm=Number(c.lengthCm);
  if(!(Number(d.widthCm)>0)&&Number(c.widthCm)>0)d.widthCm=Number(c.widthCm);
  if(!(Number(d.heightCm)>0)&&Number(c.heightCm)>0)d.heightCm=Number(c.heightCm);
  return d;
}
function connectionFor(code){
  const list=state.listingStatus.connections||[];
  return list.filter(x=>x.marketCode===code);
}
function gate(c,code){
  const m=market(code),p=plan(c,code),blocks=[];
  if(m?.future)blocks.push('브라질은 향후 입점 시장이라 실제 등록 준비를 잠가뒀어.');
  if(c.status!=='READY')blocks.push('후보상품 상태가 “등록 후보”가 아니야. 검증센터에서 먼저 승인해야 해.');
  if((p.regulationStatus||'UNCHECKED')!=='OK')blocks.push('국가별 규제 상태가 “판매가능”으로 확인되지 않았어.');
  if((p.decision||'AUTO')!=='SELL')blocks.push('검증센터에서 이 국가를 “판매대상”으로 확정하지 않았어.');
  return blocks;
}
function parseAttributes(text){
  const raw=String(text||'').trim();if(!raw)return [];
  const x=JSON.parse(raw);if(!Array.isArray(x))throw new Error('속성 JSON은 배열이어야 해.');return x;
}
function attrId(x){return String(x?.attribute_id??x?.attributeId??'')}
function readiness(c,code){
  const d=draft(c,code),m=market(code),contentBlocks=[...gate(c,code)],apiBlocks=[];
  const title=String(d.title||'').trim(),desc=String(d.description||'').trim(),sku=String(d.sku||'').trim();
  if(!d.enabled)contentBlocks.push('이 국가의 등록 준비 스위치가 꺼져 있어.');
  if(!title)contentBlocks.push('상품명이 비어 있어.');
  if(title.length>120)contentBlocks.push('상품명이 120자를 넘었어.');
  if(!desc)contentBlocks.push('상세설명이 비어 있어.');
  if(!sku)contentBlocks.push('SKU가 비어 있어.');
  if(sku.length>100)contentBlocks.push('SKU가 100자를 넘었어.');
  if(!(Number(d.priceLocal)>0))contentBlocks.push(`판매가(${m.cur})가 확정되지 않았어.`);
  if(!(Number(d.weightG)>0))contentBlocks.push('포장 후 중량이 필요해.');
  if(!(Number(d.categoryId)>0))contentBlocks.push('Shopee 카테고리 ID가 필요해.');
  if(!(Number(d.initialStock)>0))contentBlocks.push('실제 등록재고가 아직 확정되지 않았어.');
  if(!d.imageUrls.length&&!d.imageIds.length)contentBlocks.push('상품 이미지 계획이 하나도 없어.');
  if(d.imageUrls.length>9||d.imageIds.length>9)contentBlocks.push('메인 이미지는 최대 9개로 준비해.');
  if(!d.logistics.length)contentBlocks.push('사용할 물류 채널이 선택되지 않았어.');
  apiBlocks.push(...contentBlocks);
  if(!d.imageIds.length)apiBlocks.push('Shopee media_space 업로드 후 image_id가 필요해.');
  const present=new Set(d.attributes.map(attrId).filter(Boolean));
  const missingMandatory=d.mandatoryAttributeIds.filter(id=>!present.has(String(id)));
  if(missingMandatory.length)apiBlocks.push(`필수 카테고리 속성 ${missingMandatory.length}개가 아직 미입력이야.`);
  if(!connectionFor(code).length)apiBlocks.push('이 국가의 Production/Sandbox Shop 연결이 없어 Shopee 메타데이터 검증을 할 수 없어.');
  return {contentBlocks:uniq(contentBlocks),apiBlocks:uniq(apiBlocks),contentReady:contentBlocks.length===0,apiReady:apiBlocks.length===0};
}
function buildPackage(c,code){
  const d=draft(c,code),m=market(code),r=readiness(c,code);
  const dims=(Number(d.lengthCm)>0&&Number(d.widthCm)>0&&Number(d.heightCm)>0)?{
    package_length:Math.round(Number(d.lengthCm)),package_width:Math.round(Number(d.widthCm)),package_height:Math.round(Number(d.heightCm))
  }:undefined;
  const payload={
    item_name:String(d.title||'').trim(),
    description:String(d.description||'').trim(),
    item_sku:String(d.sku||'').trim(),
    category_id:Number(d.categoryId||0),
    original_price:Number(d.priceLocal||0),
    weight:Number(d.weightG||0)/1000,
    ...(dims?{dimension:dims}:{}),
    condition:d.condition||'NEW',
    image:{image_id_list:d.imageIds||[]},
    logistic_info:(d.logistics||[]).map(id=>({logistic_id:Number(id),enabled:true})).filter(x=>x.logistic_id>0),
    attribute_list:d.attributes||[],
    seller_stock:[{stock:Number(d.initialStock||0)}],
    item_status:'UNLIST',
    ...(String(d.gtin||'').trim()?{gtin_code:String(d.gtin).trim()}:{}),
    ...(String(d.brandName||'').trim()?{brand:{original_brand_name:String(d.brandName).trim()}}:{})
  };
  return {
    schema:'JAPANOVA_LISTING_PACKAGE_V1',generatedAt:now(),candidateId:c.id,candidateName:c.name,marketCode:code,marketName:m.name,currency:m.cur,
    source:{sourceUrl:c.sourceUrl||'',supplier:c.supplier||'',purchaseCostJpy:Number(c.purchaseCostJpy||0)},
    validation:{contentReady:r.contentReady,apiReady:r.apiReady,contentBlockers:r.contentBlocks,apiBlockers:r.apiBlocks},
    draft:{...d},
    shopee:{targetShopId:d.selectedShopId||null,mutationLocked:true,endpoint:'/api/v2/product/add_item',payloadPreview:payload},
    note:'payloadPreview는 등록 직전 검증용이며 v1.2에서는 실제 add_item을 호출하지 않습니다.'
  };
}

async function load(){
  const [cands,status]=await Promise.all([
    api('/api/candidates'),
    api('/api/candidates/listing/status').catch(()=>({environment:'backend-pending',publishMutationEnabled:false,connections:[]}))
  ]);
  state.candidates=Array.isArray(cands.candidates)?cands.candidates:[];
  state.listingStatus=status||{environment:'unknown',connections:[]};
  const ready=state.candidates.find(c=>c.status==='READY');
  state.selectedId=(ready||state.candidates[0]||{}).id||null;
  renderAll();
}
async function saveCandidate(c,{quiet=false}={}){
  const r=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:JSON.stringify(c)});
  const saved=r.candidate||c;const i=state.candidates.findIndex(x=>x.id===saved.id);if(i>=0)state.candidates[i]=saved;
  if(!quiet)flash('국가별 등록 준비 초안을 후보상품 DB에 저장했어.');
  return saved;
}

function renderMetrics(){
  let readyCandidates=0,enabled=0,contentReady=0,apiReady=0;
  for(const c of state.candidates){if(c.status==='READY')readyCandidates++;for(const m of MARKETS){const d=draft(c,m.code),r=readiness(c,m.code);if(d.enabled)enabled++;if(r.contentReady)contentReady++;if(r.apiReady)apiReady++;}}
  $('#mReadyCandidates').textContent=fmt(readyCandidates);$('#mEnabledMarkets').textContent=fmt(enabled);$('#mContentReady').textContent=fmt(contentReady);$('#mApiReady').textContent=fmt(apiReady);
}
function renderCandidateSelect(){
  const el=$('#candidateSelect');
  if(!state.candidates.length){el.innerHTML='<option>후보상품 없음</option>';el.disabled=true;return}
  el.disabled=false;el.innerHTML=state.candidates.map(c=>`<option value="${esc(c.id)}" ${c.id===state.selectedId?'selected':''}>${c.status==='READY'?'✅':'⛔'} ${esc(c.name)} · ${c.status}</option>`).join('');
}
function renderMarketTabs(){
  const c=candidate();
  $('#marketTabs').innerHTML=MARKETS.map(m=>{
    const d=c?draft(c,m.code):null,r=c?readiness(c,m.code):null;
    const mark=!c?'':r.apiReady?'API 준비':r.contentReady?'콘텐츠 준비':d?.enabled?'작성중':'대기';
    return `<button class="marketTab ${state.market===m.code?'on':''}" data-market="${m.code}">${m.name}<small>${esc(mark)}${m.future?' · 향후':''}</small></button>`;
  }).join('');
  $$('#marketTabs [data-market]').forEach(b=>b.onclick=()=>{state.market=b.dataset.market;renderMarketTabs();renderEditor();renderPackageSummary()});
}
function renderHeaderStatus(){
  const env=state.listingStatus.environment||'unknown',connections=state.listingStatus.connections?.length||0;
  $('#apiStatus').textContent=`${env} · 연결 Shop ${connections} · 등록 mutation 잠금`;
  $('#apiStatus').className=`badge ${connections?'ok':'warn'}`;
}
function renderPackageSummary(){
  const c=candidate(),body=$('#packageRows');
  if(!c){body.innerHTML='<tr><td colspan="7" class="empty">후보상품이 없어.</td></tr>';return}
  body.innerHTML=MARKETS.map(m=>{const d=draft(c,m.code),r=readiness(c,m.code);const status=r.apiReady?'<span class="ok">API 준비</span>':r.contentReady?'<span class="warn">콘텐츠 준비</span>':d.enabled?'<span class="warn">작성중</span>':'대기';return `<tr><td>${m.name}</td><td>${d.enabled?'ON':'OFF'}</td><td>${esc(d.title||'-')}</td><td>${localPrice(d.priceLocal,m.cur)}</td><td>${d.categoryId||'-'}</td><td>${(d.imageIds?.length||0)}/${(d.imageUrls?.length||0)}</td><td>${status}</td></tr>`}).join('');
}
function optionConnections(code,selected){
  const list=connectionFor(code);if(!list.length)return '<option value="">연결 Shop 없음</option>';
  return `<option value="">Shop 선택</option>`+list.map(x=>`<option value="${x.shopId}" ${String(x.shopId)===String(selected||'')?'selected':''}>${esc(x.shopName||x.shopId)} (${x.shopId})</option>`).join('');
}
function mandatoryInfo(d){
  if(!d.mandatoryAttributeIds.length)return '<span class="muted">필수속성 조회 전</span>';
  const present=new Set(d.attributes.map(attrId));const missing=d.mandatoryAttributeIds.filter(id=>!present.has(String(id)));
  return missing.length?`<span class="warn">필수 ${d.mandatoryAttributeIds.length}개 중 ${missing.length}개 미입력</span>`:`<span class="ok">필수속성 입력 완료</span>`;
}
function renderEditor(){
  const c=candidate(),m=market(state.market),root=$('#editor');
  if(!c){root.innerHTML='<div class="empty">아직 후보상품이 없어. 상품 검증부터 시작해.</div>';return}
  const d=applySafeDefaults(c,state.market),p=plan(c,state.market),r=readiness(c,state.market),g=gate(c,state.market);
  const statusHtml=r.apiReady?'<span class="badge ok">API 등록 준비</span>':r.contentReady?'<span class="badge warn">콘텐츠 준비 완료 · API 준비 남음</span>':'<span class="badge warn">등록 준비 작성중</span>';
  root.innerHTML=`
    <div class="section-head"><div><h2>${esc(c.name)} · ${m.name}</h2><p>검증센터 계획가 ${Number(p.plannedPrice)>0?localPrice(p.plannedPrice,m.cur):'미확정'} · 경쟁가 ${Number(p.competitorPrice)>0?localPrice(p.competitorPrice,m.cur):'미확정'}</p></div><div class="actions">${statusHtml}<button class="btn" id="saveDraft">초안 저장</button></div></div>
    ${g.length?`<div class="gate bad"><b>등록 준비 잠금 조건</b><ul>${g.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><button class="btn ghost" id="goValidation">검증센터에서 확인</button></div>`:'<div class="gate ok"><b>검증 게이트 통과</b> · 이 국가의 등록 초안을 준비할 수 있어.</div>'}
    <div class="switchRow"><label><input type="checkbox" id="dEnabled" ${d.enabled?'checked':''} ${m.future?'disabled':''}> 이 국가 등록 준비 대상</label><span>${mandatoryInfo(d)}</span></div>
    <div class="grid2">
      <div class="cardInner"><h3>① 기본 등록정보</h3><div class="form">
        <label class="full">상품명 <span class="counter" id="titleCount"></span><input id="dTitle" class="input" maxlength="140" value="${esc(d.title||'')}"></label>
        <label class="full">상세설명<textarea id="dDescription">${esc(d.description||'')}</textarea></label>
        <label>JAPANOVA / Shopee SKU<input id="dSku" class="input" maxlength="110" value="${esc(d.sku||'')}"></label>
        <label>판매가 ${m.cur}<input id="dPrice" class="input" type="number" step="any" min="0" value="${Number(d.priceLocal||0)||''}"></label>
        <label>등록 재고<input id="dStock" class="input" type="number" min="0" step="1" value="${Number(d.initialStock||0)}"></label>
        <label>상품상태<select id="dCondition" class="select"><option value="NEW" ${d.condition==='NEW'?'selected':''}>NEW</option><option value="USED" ${d.condition==='USED'?'selected':''}>USED</option></select></label>
        <label>브랜드명(선택)<input id="dBrand" class="input" value="${esc(d.brandName||'')}"></label>
        <label>GTIN/JAN(선택)<input id="dGtin" class="input" value="${esc(d.gtin||'')}"></label>
      </div><div class="actions rowGap"><button class="btn ghost" id="generateCopy">안전한 기본 문구 생성</button><button class="btn ghost" id="pullPlanPrice">검증센터 계획가 불러오기</button></div></div>
      <div class="cardInner"><h3>② 카테고리·Shop·물류</h3><div class="form">
        <label class="full">연결 Shop<select id="dShop" class="select">${optionConnections(state.market,d.selectedShopId)}</select></label>
        <label>Shopee 카테고리 ID<input id="dCategoryId" class="input" type="number" min="0" value="${esc(d.categoryId||'')}"></label>
        <label>카테고리명 메모<input id="dCategoryName" class="input" value="${esc(d.categoryName||'')}"></label>
        <label class="full">카테고리 목록<select id="categorySelect" class="select"><option value="">API에서 불러온 뒤 선택</option></select></label>
      </div><div class="actions rowGap"><button class="btn ghost" id="loadCategories">카테고리 조회</button><button class="btn ghost" id="loadAttributes">필수속성 조회</button><button class="btn ghost" id="loadLogistics">물류채널 조회</button></div>
      <div id="metaBox" class="metaBox"><span class="muted">Shop이 연결되어 있으면 Shopee 메타데이터를 읽기 전용으로 불러올 수 있어.</span></div></div>
    </div>
    <div class="grid2 section">
      <div class="cardInner"><h3>③ 포장정보·이미지</h3><div class="form">
        <label>포장후 중량 g<input id="dWeight" class="input" type="number" min="0" value="${Number(d.weightG||0)}"></label>
        <label>가로 cm<input id="dLength" class="input" type="number" min="0" step="0.1" value="${Number(d.lengthCm||0)}"></label>
        <label>세로 cm<input id="dWidth" class="input" type="number" min="0" step="0.1" value="${Number(d.widthCm||0)}"></label>
        <label>높이 cm<input id="dHeight" class="input" type="number" min="0" step="0.1" value="${Number(d.heightCm||0)}"></label>
        <label class="full">이미지 원본/작업 URL · 한 줄에 1개 · 최대 9개<textarea id="dImageUrls" placeholder="https://...">${esc((d.imageUrls||[]).join('\n'))}</textarea></label>
        <label class="full">Shopee image_id · media_space 업로드 후 한 줄에 1개<textarea id="dImageIds" placeholder="아직 업로드 전이면 비워둬">${esc((d.imageIds||[]).join('\n'))}</textarea></label>
      </div></div>
      <div class="cardInner"><h3>④ 속성·물류 ID</h3><div class="form">
        <label class="full">사용 물류 logistic_id · 쉼표/줄바꿈<input id="dLogistics" class="input" value="${esc((d.logistics||[]).join(', '))}"></label>
        <label class="full">attribute_list JSON<textarea id="dAttributes" class="codearea" placeholder='[{"attribute_id":123,"attribute_value_list":[{"value_id":456}]}]'>${esc(JSON.stringify(d.attributes||[],null,2))}</textarea></label>
        <label class="full">등록 준비 메모<textarea id="dNotes">${esc(d.notes||'')}</textarea></label>
      </div><div id="logisticsBox" class="metaBox"><span class="muted">물류채널 조회 후 여기서 체크할 수 있어.</span></div></div>
    </div>
    <div class="section grid2">
      <div class="cardInner"><h3>⑤ 누락사항</h3><div id="blockers">${renderBlockers(r)}</div></div>
      <div class="cardInner"><div class="section-head"><div><h3>⑥ Shopee 등록 패키지</h3><p>실제 등록은 잠금. 지금은 검증·백업용 패키지만 생성.</p></div></div><div class="actions"><button class="btn" id="exportOne">이 국가 JSON 내보내기</button><button class="btn ghost" id="copyPayload">payload 미리보기 복사</button></div><pre id="payloadPreview" class="payload"></pre></div>
    </div>`;
  bindEditor(c,m,d,p);
  updateTitleCounter();updatePreview();
}
function renderBlockers(r){
  if(r.apiReady)return '<div class="ok"><b>등록 API 준비조건 충족.</b> 그래도 v1.2에서는 실제 상품등록을 실행하지 않아.</div>';
  const content=r.contentBlocks.length?`<div><b>콘텐츠/운영 준비</b><ul>${r.contentBlocks.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'<div class="ok"><b>콘텐츠 준비 완료</b></div>';
  const extra=r.apiBlocks.filter(x=>!r.contentBlocks.includes(x));
  return `${content}${extra.length?`<div class="warn"><b>API 등록 전 추가</b><ul>${extra.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:''}`;
}
function readEditor(c,code){
  const d=draft(c,code);
  d.enabled=$('#dEnabled').checked;d.title=$('#dTitle').value.trim();d.description=$('#dDescription').value.trim();d.sku=cleanSku($('#dSku').value);
  d.priceLocal=Number($('#dPrice').value||0);d.initialStock=Math.max(0,Math.floor(Number($('#dStock').value||0)));d.condition=$('#dCondition').value;
  d.brandName=$('#dBrand').value.trim();d.gtin=$('#dGtin').value.trim();d.selectedShopId=$('#dShop').value?Number($('#dShop').value):null;
  d.categoryId=$('#dCategoryId').value.trim();d.categoryName=$('#dCategoryName').value.trim();d.weightG=Number($('#dWeight').value||0);
  d.lengthCm=Number($('#dLength').value||0);d.widthCm=Number($('#dWidth').value||0);d.heightCm=Number($('#dHeight').value||0);
  d.imageUrls=uniq(lines($('#dImageUrls').value)).slice(0,20);d.imageIds=uniq(lines($('#dImageIds').value)).slice(0,20);
  d.logistics=uniq(String($('#dLogistics').value||'').split(/[\s,]+/).map(x=>x.trim()).filter(x=>/^\d+$/.test(x)));
  d.attributes=parseAttributes($('#dAttributes').value);d.notes=$('#dNotes').value.trim();d.updatedAt=now();return d;
}
async function saveEditor(c,{quiet=false}={}){
  try{readEditor(c,state.market);await saveCandidate(c,{quiet});renderAll()}catch(e){flash(e.message,'bad');throw e}
}
function updateTitleCounter(){const el=$('#titleCount');if(el)el.textContent=`${$('#dTitle').value.length}/120`}
function updatePreview(){
  const c=candidate();if(!c||!$('#payloadPreview'))return;
  try{readEditor(c,state.market);const pkg=buildPackage(c,state.market);$('#payloadPreview').textContent=JSON.stringify(pkg.shopee.payloadPreview,null,2);$('#blockers').innerHTML=renderBlockers(readiness(c,state.market))}catch(e){$('#payloadPreview').textContent=`JSON 입력 오류: ${e.message}`}
}
function downloadJson(name,data){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function copyText(text){try{await navigator.clipboard.writeText(text);flash('클립보드에 복사했어.')}catch{flash('브라우저가 클립보드 복사를 막았어.','warn')}}

async function loadCategories(c,d){
  const shopId=Number($('#dShop').value||0);if(!shopId)return flash('먼저 연결 Shop을 선택해줘.','warn');
  const key=`${shopId}:${state.market}`;try{
    const r=await api(`/api/candidates/listing/categories?shopId=${shopId}&language=${encodeURIComponent(market(state.market).lang==='zh-hant'?'zh-hant':'en')}`);
    state.categoryCache[key]=r.categoryList||[];renderCategoryOptions(state.categoryCache[key],d);flash(`Shopee 카테고리 ${state.categoryCache[key].length}개를 불러왔어.`);
  }catch(e){flash(`카테고리 API를 아직 사용할 수 없어. ID를 수동 입력해도 돼: ${e.message}`,'warn')}
}
function catName(x){return x.display_category_name||x.category_name||x.name||x.original_category_name||`Category ${x.category_id||x.categoryId||''}`}
function catId(x){return x.category_id??x.categoryId??''}
function renderCategoryOptions(list,d){
  const el=$('#categorySelect');if(!el)return;el.innerHTML='<option value="">카테고리 선택</option>'+list.map(x=>`<option value="${catId(x)}" data-name="${esc(catName(x))}" ${String(catId(x))===String(d.categoryId)?'selected':''}>${esc(catName(x))} · ${catId(x)}${x.has_children?' ▸':''}</option>`).join('');
  el.onchange=()=>{const o=el.selectedOptions[0];if(!o?.value)return;$('#dCategoryId').value=o.value;$('#dCategoryName').value=o.dataset.name||o.textContent;updatePreview()};
}
async function loadAttributes(c,d){
  const shopId=Number($('#dShop').value||0),categoryId=Number($('#dCategoryId').value||0);if(!shopId||!categoryId)return flash('Shop과 카테고리 ID를 먼저 선택해줘.','warn');
  try{
    const r=await api(`/api/candidates/listing/attributes?shopId=${shopId}&categoryId=${categoryId}&language=en`);const list=r.attributeList||[];state.attributeCache[`${shopId}:${categoryId}`]=list;
    d.mandatoryAttributeIds=(r.mandatoryAttributes||[]).map(x=>String(x.attribute_id??x.attributeId??'')).filter(Boolean);
    const mandatory=(r.mandatoryAttributes||[]).map(x=>`${x.name||x.attribute_name||'Attribute'} (${x.attribute_id??x.attributeId})`);
    $('#metaBox').innerHTML=`<b>필수속성 ${mandatory.length}개</b><div class="chips">${mandatory.length?mandatory.map(x=>`<span>${esc(x)}</span>`).join(''):'<span class="ok">필수속성 없음</span>'}</div><div class="tiny">API 원문 속성은 category별로 달라서 attribute_list JSON에 실제 값을 확정해서 넣어야 해.</div>`;
    await saveCandidate(c,{quiet:true});updatePreview();flash('카테고리 속성 트리를 불러왔어.');
  }catch(e){flash(`속성 API 조회 실패: ${e.message}`,'warn')}
}
async function loadLogistics(c,d){
  const shopId=Number($('#dShop').value||0);if(!shopId)return flash('먼저 연결 Shop을 선택해줘.','warn');
  try{
    const r=await api(`/api/candidates/listing/logistics?shopId=${shopId}`);const list=r.logisticsChannels||[];state.logisticsCache[shopId]=list;
    const selected=new Set((d.logistics||[]).map(String));$('#logisticsBox').innerHTML=list.length?`<b>Shop 물류채널</b><div class="checks">${list.map(x=>{const id=String(x.logistics_channel_id??x.logistic_id??x.channel_id??'');const name=x.logistics_channel_name||x.logistic_name||x.channel_name||`Logistic ${id}`;return `<label><input type="checkbox" data-logistic="${esc(id)}" ${selected.has(id)?'checked':''}> ${esc(name)} · ${esc(id)}</label>`}).join('')}</div>`:'<span class="warn">사용 가능한 물류채널이 반환되지 않았어.</span>';
    $$('[data-logistic]').forEach(el=>el.onchange=()=>{const ids=$$('[data-logistic]:checked').map(x=>x.dataset.logistic);$('#dLogistics').value=ids.join(', ');updatePreview()});flash(`물류채널 ${list.length}개를 불러왔어.`);
  }catch(e){flash(`물류채널 API 조회 실패: ${e.message}`,'warn')}
}
function bindEditor(c,m,d,p){
  $('#saveDraft').onclick=()=>saveEditor(c);
  $('#goValidation')?.addEventListener('click',()=>location.href='./v10.html');
  $('#generateCopy').onclick=()=>{$('#dTitle').value=c.name||'';$('#dDescription').value=defaultDescription(c,state.market);if(!$('#dSku').value)$('#dSku').value=baseSku(c,state.market);updateTitleCounter();updatePreview();flash('과장표현 없이 기본 등록문구를 만들었어.')};
  $('#pullPlanPrice').onclick=()=>{if(Number(p.plannedPrice)>0){$('#dPrice').value=Number(p.plannedPrice);updatePreview();flash('검증센터의 계획 판매가를 불러왔어.')}else flash('검증센터에 계획 판매가가 아직 없어.','warn')};
  $('#loadCategories').onclick=()=>loadCategories(c,d);$('#loadAttributes').onclick=()=>loadAttributes(c,d);$('#loadLogistics').onclick=()=>loadLogistics(c,d);
  $('#exportOne').onclick=async()=>{try{readEditor(c,state.market);await saveCandidate(c,{quiet:true});const pkg=buildPackage(c,state.market);downloadJson(`JAPANOVA_${cleanSku(c.name)||'ITEM'}_${state.market}_listing-package.json`,pkg);flash('등록 준비 패키지 JSON을 만들었어.')}catch(e){flash(e.message,'bad')}};
  $('#copyPayload').onclick=()=>{try{readEditor(c,state.market);copyText(JSON.stringify(buildPackage(c,state.market).shopee.payloadPreview,null,2))}catch(e){flash(e.message,'bad')}};
  ['dEnabled','dTitle','dDescription','dSku','dPrice','dStock','dCondition','dBrand','dGtin','dShop','dCategoryId','dCategoryName','dWeight','dLength','dWidth','dHeight','dImageUrls','dImageIds','dLogistics','dAttributes','dNotes'].forEach(id=>{const el=$(`#${id}`);if(!el)return;el.addEventListener('input',()=>{if(id==='dTitle')updateTitleCounter();updatePreview()});el.addEventListener('change',updatePreview)});
}

function renderAll(){renderHeaderStatus();renderMetrics();renderCandidateSelect();renderMarketTabs();renderEditor();renderPackageSummary()}
function exportAll(){
  const c=candidate();if(!c)return flash('후보상품이 없어.','warn');
  const packages=MARKETS.map(m=>buildPackage(c,m.code));downloadJson(`JAPANOVA_${cleanSku(c.name)||'ITEM'}_all-markets-listing-packages.json`,{schema:'JAPANOVA_MULTI_MARKET_LISTING_PACKAGE_V1',generatedAt:now(),candidateId:c.id,candidateName:c.name,packages});
}
function bindTop(){
  $('#candidateSelect').onchange=()=>{state.selectedId=$('#candidateSelect').value;renderAll()};
  $('#exportAll').onclick=exportAll;$('#navResearch').onclick=()=>location.href='./v11.html';$('#navValidation').onclick=()=>location.href='./v10.html';$('#navOps').onclick=()=>location.href='./v08.html';
}

(async function init(){
  try{await load();bindTop();$('#status').textContent='v1.2 등록 준비센터 · DB 저장';$('#status').className='badge ok'}
  catch(e){$('#status').textContent='등록 준비센터 로드 실패';$('#status').className='badge bad';$('#editor').innerHTML=`<div class="empty">${esc(e.message)}</div>`}
})();
})();
