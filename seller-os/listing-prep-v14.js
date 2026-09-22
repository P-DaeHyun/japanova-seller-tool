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
const now=()=>new Date().toISOString();
const uniq=(a)=>[...new Set(a)];
const arr=(v)=>Array.isArray(v)?v:[];
let state={candidates:[],selectedId:null,market:'TW',listingStatus:{environment:'unknown',connections:[]},categoryCache:{},attributeCache:{},logisticsCache:{},busy:false};

async function api(path,opts={}){
  const headers={...(opts.headers||{})};
  let body=opts.body;
  if(body&&!(body instanceof FormData)){
    headers['Content-Type']='application/json';
    if(typeof body!=='string') body=JSON.stringify(body);
  }
  const r=await fetch(`${API}${path}`,{...opts,headers,body});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.message||`HTTP ${r.status}`);
  return data;
}
function flash(msg,type='ok'){
  const b=$('#flash');if(!b)return;b.textContent=msg;b.className=`flash ${type}`;b.hidden=false;
  clearTimeout(flash.t);flash.t=setTimeout(()=>b.hidden=true,5600);
}
function market(code){return MARKETS.find(x=>x.code===code)}
function candidate(){return state.candidates.find(c=>c.id===state.selectedId)||null}
function plan(c,code){c.plans=c.plans||{};c.plans[code]=c.plans[code]||{};return c.plans[code]}
function cleanSku(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100)}
function baseSku(c,code){const raw=cleanSku(c.id||c.name||'ITEM');return `JNV-${(raw||'ITEM').slice(-24)}-${code}`.slice(0,100)}
function defaultDescription(c,code){
  if(code==='TW') return `商品名稱：${c.name}\n\n日本採購商品。\n出貨地：日本\n購買前請確認商品圖片、規格、尺寸、容量與數量。\n若商品包裝或設計因製造商更新而變更，請以實際商品為準。`;
  return `Product: ${c.name}\n\nSourced in Japan.\nShips from Japan.\nPlease check the product images, specifications, size, capacity and quantity before purchase.\nPackaging or design may be updated by the manufacturer.`;
}
function draft(c,code){
  const p=plan(c,code);
  if(!p.listingDraft||typeof p.listingDraft!=='object'||Array.isArray(p.listingDraft)) p.listingDraft={};
  const d=p.listingDraft;
  if(d.enabled===undefined)d.enabled=p.decision==='SELL';
  if(!d.title)d.title='';
  if(!d.description)d.description='';
  if(!d.sku)d.sku=baseSku(c,code);
  if(!(Number(d.priceLocal)>0)&&Number(p.plannedPrice)>0)d.priceLocal=Number(p.plannedPrice);
  if(d.initialStock===undefined)d.initialStock=0;
  if(d.weightG===undefined)d.weightG=Number(c.weightG||0);
  if(d.lengthCm===undefined)d.lengthCm=Number(c.lengthCm||0);
  if(d.widthCm===undefined)d.widthCm=Number(c.widthCm||0);
  if(d.heightCm===undefined)d.heightCm=Number(c.heightCm||0);
  if(!d.condition)d.condition='NEW';
  d.imageUrls=arr(d.imageUrls);
  d.imageIds=arr(d.imageIds);
  d.imageUploads=arr(d.imageUploads);
  d.logistics=arr(d.logistics).map(Number).filter(Boolean);
  d.attributes=arr(d.attributes);
  d.mandatoryAttributeIds=arr(d.mandatoryAttributeIds).map(String);
  if(!d.attributeValues||typeof d.attributeValues!=='object'||Array.isArray(d.attributeValues))d.attributeValues={};
  if(!d.updatedAt)d.updatedAt=now();
  return d;
}
function applyDefaults(c,code){
  const d=draft(c,code);
  if(!d.title)d.title=c.name||'';
  if(!d.description)d.description=defaultDescription(c,code);
  return d;
}
function touch(d){d.updatedAt=now();d.preflight=null;}
function connectionsFor(code){
  return arr(state.listingStatus.connections)
    .filter(x=>String(x.marketCode||'').toUpperCase()===code)
    .sort((a,b)=>new Date(b.updatedAt||b.lastSyncAt||0)-new Date(a.updatedAt||a.lastSyncAt||0));
}
function selectedShop(d,code){return connectionsFor(code).find(x=>Number(x.shopId)===Number(d.selectedShopId))||null}
function localPrice(n,cur){if(!(Number(n)>0))return '-';const decimals=['SGD','MYR','BRL'].includes(cur)?2:0;return `${Number(n).toLocaleString('ko-KR',{maximumFractionDigits:decimals})} ${cur}`}

function attrId(a){return String(a?.attribute_id??a?.attributeId??'')}
function attrName(a){return String(a?.display_attribute_name??a?.attribute_name??a?.name??`속성 ${attrId(a)}`)}
function attrMandatory(a){return Boolean(a?.mandatory??a?.is_mandatory??a?.isMandatory)}
function attrInputType(a){return String(a?.input_type??a?.attribute_input_type??a?.input_type_name??'').toUpperCase()}
function attrOptions(a){return arr(a?.attribute_value_list||a?.value_list||a?.values||a?.attribute_values)}
function optionId(v){return String(v?.value_id??v?.id??'0')}
function optionName(v){return String(v?.display_value_name??v?.value_name??v?.original_value_name??v?.name??optionId(v))}
function isMultiAttr(a){return attrInputType(a).includes('MULTIPLE')||attrInputType(a).includes('MULTI_SELECT')}
function attrCacheKey(d){return `${Number(d.selectedShopId)||0}:${Number(d.categoryId)||0}`}
function logisticId(v){return Number(v?.logistic_id??v?.logistics_channel_id??v?.channel_id??v?.logistic_channel_id??0)}
function logisticName(v){return String(v?.logistics_channel_name??v?.logistic_name??v?.channel_name??v?.name??`물류 ${logisticId(v)}`)}
function categoryId(v){return Number(v?.category_id??v?.id??0)}
function categoryName(v){return String(v?.display_category_name??v?.original_category_name??v?.category_name??v?.name??`카테고리 ${categoryId(v)}`)}
function categoryHasChildren(v){return Boolean(v?.has_children??v?.hasChildren)}

function gate(c,code){
  const p=plan(c,code),m=market(code),blocks=[];
  if(m?.future)blocks.push('브라질은 향후 입점 시장이라 실제 등록 준비를 잠가뒀어.');
  if(c.status!=='READY')blocks.push('후보상품 상태가 등록 후보(READY)가 아니야.');
  if((p.regulationStatus||'UNCHECKED')!=='OK')blocks.push('국가별 규제 상태가 판매가능(OK)이 아니야.');
  if((p.decision||'AUTO')!=='SELL')blocks.push('검증센터에서 이 국가를 판매대상(SELL)으로 확정하지 않았어.');
  return blocks;
}
function rebuildAttributes(d,metadata){
  const out=[];
  for(const meta of arr(metadata)){
    const id=attrId(meta);if(!id)continue;
    const saved=d.attributeValues[id]||{};
    const values=[];
    const options=attrOptions(meta);
    const selected=arr(saved.valueIds).map(String).filter(Boolean);
    for(const valueId of selected){
      const opt=options.find(o=>optionId(o)===valueId);
      values.push({value_id:Number(valueId)||0,original_value_name:opt?optionName(opt):String(saved.text||'')});
    }
    const text=String(saved.text||'').trim();
    if(!selected.length&&text) values.push({value_id:0,original_value_name:text,...(saved.unit?{value_unit:String(saved.unit)}:{})});
    if(values.length) out.push({attribute_id:Number(id)||id,attribute_value_list:values});
  }
  d.attributes=out;
  d.mandatoryAttributeIds=arr(metadata).filter(attrMandatory).map(attrId).filter(Boolean);
  return out;
}
function clientReadiness(c,code){
  const d=draft(c,code),m=market(code),blocks=[...gate(c,code)],warnings=[];
  if(!d.enabled)blocks.push('등록 준비 스위치가 꺼져 있어.');
  if(!String(d.title||'').trim())blocks.push('상품명이 비어 있어.');
  if(String(d.title||'').trim().length>120)blocks.push('상품명이 120자를 넘었어.');
  if(!String(d.description||'').trim())blocks.push('상세설명이 비어 있어.');
  if(!String(d.sku||'').trim())blocks.push('SKU가 비어 있어.');
  if(!(Number(d.priceLocal)>0))blocks.push(`판매가(${m.cur})가 필요해.`);
  if(!(Number(d.initialStock)>0))blocks.push('등록재고가 1개 이상이어야 해.');
  if(!(Number(d.weightG)>0))blocks.push('포장 후 중량이 필요해.');
  if(!(Number(d.categoryId)>0))blocks.push('Shopee 카테고리를 선택해야 해.');
  if(!d.selectedShopId)blocks.push('등록 대상 Shopee Shop을 선택해야 해.');
  if(!d.imageIds.length)blocks.push('Shopee image_id가 하나 이상 필요해.');
  if(d.imageIds.length>9)blocks.push('상품 이미지는 최대 9개까지만 준비해.');
  if(!d.logistics.length)blocks.push('물류 채널을 하나 이상 선택해야 해.');
  const present=new Set(d.attributes.map(attrId).filter(Boolean));
  const missing=d.mandatoryAttributeIds.filter(id=>!present.has(String(id)));
  if(missing.length)blocks.push(`필수속성 ${missing.length}개가 아직 미입력이야.`);
  if(!(Number(d.lengthCm)>0&&Number(d.widthCm)>0&&Number(d.heightCm)>0))warnings.push('포장 3변 치수가 완성되지 않았어.');
  return {ready:blocks.length===0,blocks:uniq(blocks),warnings:uniq(warnings)};
}
function buildPackage(c,code){
  const d=draft(c,code),m=market(code),r=clientReadiness(c,code);
  const dims=(Number(d.lengthCm)>0&&Number(d.widthCm)>0&&Number(d.heightCm)>0)?{
    package_length:Math.round(Number(d.lengthCm)),package_width:Math.round(Number(d.widthCm)),package_height:Math.round(Number(d.heightCm))
  }:undefined;
  const payload={
    item_name:String(d.title||'').trim(),description:String(d.description||'').trim(),item_sku:String(d.sku||'').trim(),
    category_id:Number(d.categoryId||0),original_price:Number(d.priceLocal||0),weight:Number(d.weightG||0)/1000,
    ...(dims?{dimension:dims}:{}),condition:d.condition||'NEW',image:{image_id_list:d.imageIds},
    logistic_info:d.logistics.map(id=>({logistic_id:Number(id),enabled:true})).filter(x=>x.logistic_id>0),
    attribute_list:d.attributes,seller_stock:[{stock:Number(d.initialStock||0)}],item_status:'UNLIST'
  };
  return {schema:'JAPANOVA_LISTING_PACKAGE_V2',generatedAt:now(),candidateId:c.id,candidateName:c.name,marketCode:code,marketName:m.name,currency:m.cur,
    validation:{clientReady:r.ready,clientBlockers:r.blocks,clientWarnings:r.warnings,serverPreflight:d.preflight||null},
    draft:{...d},shopee:{targetShopId:d.selectedShopId||null,mutationLocked:!state.listingStatus.publishMutationEnabled,endpoint:'/api/v2/product/add_item',payloadPreview:payload},
    note:state.listingStatus.environment==='sandbox'&&state.listingStatus.sandboxPublishEnabled
      ?'v1.4 Sandbox에서는 최종검사 통과 후 UNLIST 테스트 상품을 명시적 확인으로 생성할 수 있습니다. Production은 계속 잠겨 있습니다.'
      :'상품 생성 mutation은 서버 안전스위치가 켜진 환경에서만 사용할 수 있습니다.'};
}

async function load(){
  const [cands,status]=await Promise.all([
    api('/api/candidates'),api('/api/candidates/listing/status').catch(()=>({environment:'backend-pending',publishMutationEnabled:false,connections:[]}))
  ]);
  state.candidates=arr(cands.candidates);state.listingStatus=status||{};
  const ready=state.candidates.find(c=>c.status==='READY');state.selectedId=(ready||state.candidates[0]||{}).id||null;
  renderAll();
}
async function seedSandboxCandidate(){
  if(state.busy)return;
  if(state.listingStatus.environment!=='sandbox')return flash('Sandbox 환경에서만 테스트 후보를 만들 수 있어.','warn');
  state.busy=true;
  try{
    const r=await api('/api/candidates/listing/sandbox-test-candidate',{method:'POST'});
    flash(r.message||'Sandbox 테스트 후보를 준비했어.');
    await load();
    if(r.candidate?.id){state.selectedId=r.candidate.id;state.market='TW';renderAll()}
  }catch(e){flash(e.message,'bad')}finally{state.busy=false}
}

async function saveCandidate(c,{quiet=false}={}){
  const r=await api(`/api/candidates/${encodeURIComponent(c.id)}`,{method:'PUT',body:c});
  const saved=r.candidate||c;const i=state.candidates.findIndex(x=>x.id===saved.id);if(i>=0)state.candidates[i]=saved;
  if(!quiet)flash('등록 준비 초안을 DB에 저장했어.');return saved;
}
function saveBlob(name,obj){
  const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function renderMetrics(){
  let readyCandidates=0,enabled=0,attrsDone=0,preflight=0;
  for(const c of state.candidates){if(c.status==='READY')readyCandidates++;for(const m of MARKETS){const d=draft(c,m.code),r=clientReadiness(c,m.code);if(d.enabled)enabled++;if(d.mandatoryAttributeIds.length&&!r.blocks.some(x=>x.includes('필수속성')))attrsDone++;if(d.preflight?.ready)preflight++;}}
  $('#mReadyCandidates').textContent=fmt(readyCandidates);$('#mEnabledMarkets').textContent=fmt(enabled);$('#mAttributesReady').textContent=fmt(attrsDone);$('#mPreflight').textContent=fmt(preflight);
}
function renderCandidateSelect(){
  const el=$('#candidateSelect');if(!state.candidates.length){el.innerHTML='<option>후보상품 없음</option>';el.disabled=true;return}
  el.disabled=false;el.innerHTML=state.candidates.map(c=>`<option value="${esc(c.id)}" ${c.id===state.selectedId?'selected':''}>${c.status==='READY'?'✅':'⛔'} ${esc(c.name)} · ${esc(c.status)}</option>`).join('');
}
function renderHeader(){
  const env=state.listingStatus.environment||'unknown',conns=arr(state.listingStatus.connections).length;
  const sandboxOn=env==='sandbox'&&state.listingStatus.sandboxPublishEnabled;
  const publishLabel=sandboxOn?'Sandbox add_item ON':state.listingStatus.productionPublishEnabled?'Production add_item ON':'add_item 잠금';
  $('#apiStatus').textContent=`${env} · 연결 Shop ${conns} · ${publishLabel}`;
  $('#apiStatus').className=`badge ${conns?(sandboxOn?'warn':'ok'):'warn'}`;
  if($('#seedSandbox')) $('#seedSandbox').disabled=env!=='sandbox';
}
function renderMarketTabs(){
  const c=candidate();$('#marketTabs').innerHTML=MARKETS.map(m=>{const d=c?draft(c,m.code):null;const r=c?clientReadiness(c,m.code):null;let label='대기';if(d?.preflight?.ready)label='최종검사 통과';else if(r?.ready)label='검사 가능';else if(d?.enabled)label='작성중';return `<button class="marketTab ${state.market===m.code?'on':''}" data-market="${m.code}">${m.name}<small>${label}${m.future?' · 향후':''}</small></button>`}).join('');
  $$('#marketTabs [data-market]').forEach(b=>b.onclick=()=>{state.market=b.dataset.market;renderMarketTabs();renderEditor();renderSummary()});
}
function renderAttributeFields(d){
  const metadata=state.attributeCache[attrCacheKey(d)]||[];
  if(!metadata.length)return '<div class="empty smallEmpty">카테고리 선택 후 “속성 불러오기”를 눌러줘.</div>';
  const sorted=[...metadata].sort((a,b)=>Number(attrMandatory(b))-Number(attrMandatory(a))||attrName(a).localeCompare(attrName(b)));
  return `<div class="attrGrid">${sorted.map(meta=>{
    const id=attrId(meta),saved=d.attributeValues[id]||{},options=attrOptions(meta),required=attrMandatory(meta),multi=isMultiAttr(meta);
    const selected=new Set(arr(saved.valueIds).map(String));
    let field='';
    if(options.length){
      field=`<select class="select attrSelect" data-attr-id="${esc(id)}" ${multi?'multiple size="5"':''}><option value="">${multi?'복수 선택 가능':'선택 안 함'}</option>${options.map(o=>`<option value="${esc(optionId(o))}" ${selected.has(optionId(o))?'selected':''}>${esc(optionName(o))}</option>`).join('')}</select>`;
    }else field=`<input class="input attrText" data-attr-id="${esc(id)}" value="${esc(saved.text||'')}" placeholder="속성값 입력">`;
    return `<div class="attrCard ${required?'required':''}"><div class="attrHead"><b>${esc(attrName(meta))}</b><span>${required?'필수':'선택'} · ID ${esc(id)}</span></div>${field}<div class="tiny">${esc(attrInputType(meta)||'자유입력/선택')}</div></div>`;
  }).join('')}</div>`;
}
function renderImages(d){
  const uploads=d.imageUploads.length?d.imageUploads.map((x,i)=>`<div class="imageChip"><div><b>${esc(x.fileName||`이미지 ${i+1}`)}</b><small>${esc(x.imageId||'')}</small></div><button class="mini red" data-remove-image="${i}">삭제</button></div>`).join(''):'<div class="muted">아직 Shopee Media에 업로드된 이미지가 없어.</div>';
  return `<div class="uploadBox"><input id="imageFiles" class="input fileInput" type="file" accept="image/jpeg,image/png" multiple><button class="btn" id="uploadImages" ${d.selectedShopId?'':'disabled'}>선택 이미지 Shopee에 업로드</button><div class="tiny">JPG/JPEG/PNG · 파일당 최대 10MB · 전체 상품이미지 최대 9개. 업로드는 버튼을 눌렀을 때만 실행돼.</div></div><div class="imageList">${uploads}</div>`;
}
function renderLogistics(d){
  const channels=state.logisticsCache[String(d.selectedShopId||'')]||[];
  if(!channels.length)return '<div class="empty smallEmpty">Shop 선택 후 “물류 불러오기”를 눌러줘.</div>';
  return `<div class="checks">${channels.map(x=>{const id=logisticId(x);if(!id)return '';return `<label><input type="checkbox" class="logisticCheck" value="${id}" ${d.logistics.includes(id)?'checked':''}><span>${esc(logisticName(x))} <small>#${id}</small></span></label>`}).join('')}</div>`;
}
function renderPreflight(d){
  const p=d.preflight;if(!p)return '<div class="preflight idle"><b>서버 최종검사 미실행</b><p>초안을 저장한 뒤 Shopee 현재 카테고리 필수속성과 물류채널을 서버에서 다시 확인해.</p></div>';
  const sandboxReady=state.listingStatus.environment==='sandbox'&&state.listingStatus.sandboxPublishEnabled;
  const cls=p.ready?'ok':'bad';return `<div class="preflight ${cls}"><b>${p.ready?'✅ 최종검사 통과':'⛔ 최종검사 차단'}</b><p>${esc(p.checkedAt||'')}</p>${arr(p.blockers).length?`<ul>${p.blockers.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${arr(p.warnings).length?`<div class="warnList">${p.warnings.map(x=>`⚠ ${esc(x)}`).join('<br>')}</div>`:''}<div class="tiny">${sandboxReady?'Sandbox에서는 아래 테스트 등록 버튼이 열려 있어. Production 등록은 잠금 상태야.':'상품 생성 add_item은 현재 잠금 상태야.'}</div></div>`;
}

function renderSandboxPublish(c,code,d){
  const isSandbox=state.listingStatus.environment==='sandbox';
  const enabled=isSandbox&&state.listingStatus.sandboxPublishEnabled;
  const ready=Boolean(d.preflight?.ready);
  const receipt=d.publishReceipt;
  if(receipt?.itemId){
    return `<section class="cardInner"><div class="section-head"><div><h3>7. Sandbox 테스트 등록</h3><p>이 초안은 이미 등록 완료됐어.</p></div></div><div class="preflight ok"><b>✅ Sandbox item_id ${esc(receipt.itemId)}</b><p>상태: ${esc(receipt.itemStatus||'UNLIST')} · Shop ${esc(receipt.shopId||'')}</p></div></section>`;
  }
  const phrase=`SANDBOX PUBLISH ${code}`;
  return `<section class="cardInner"><div class="section-head"><div><h3>7. Sandbox 테스트 등록</h3><p>Shopee Sandbox에 미게시(UNLIST) 테스트 상품 1개를 실제 생성해 API 흐름을 검증해.</p></div></div>
    <div class="gate ${enabled?'':'bad'}">${enabled?'<b>Sandbox add_item 안전스위치 ON</b> · Production에는 절대 등록되지 않아.':'<b>Sandbox add_item 잠금</b> · 서버 안전스위치가 꺼져 있어.'}</div>
    <label>최종 확인문구<input id="sandboxConfirm" class="input" placeholder="${esc(phrase)}" autocomplete="off"></label>
    <div class="tiny rowGap">정확히 <b>${esc(phrase)}</b> 를 입력해야 버튼이 활성화돼. 서버 최종검사를 통과한 초안만 등록 가능하고, 중복 등록 방지 원장도 적용돼.</div>
    <div class="actions rowGap"><button class="btn" id="sandboxPublish" disabled>대만 Sandbox에 UNLIST 테스트 상품 등록</button></div>
    <div class="tiny">현재 환경: ${esc(state.listingStatus.environment||'unknown')} · 최종검사: ${ready?'통과':'미통과'}</div>
  </section>`;
}
function renderEditor(){
  const c=candidate(),root=$('#editor');if(!c){root.innerHTML='<div class="empty">아직 후보상품이 없어.</div>';return}
  const code=state.market,m=market(code),p=plan(c,code),d=applyDefaults(c,code),g=gate(c,code),conns=connectionsFor(code),cats=state.categoryCache[String(d.selectedShopId||'')]||[];
  if(!d.selectedShopId&&conns.length)d.selectedShopId=conns[0].shopId;
  const r=clientReadiness(c,code);
  root.innerHTML=`
    <div class="gate ${g.length?'bad':''}">${g.length?`<b>등록 준비 잠금</b><ul>${g.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:`<b>검증 게이트 통과</b> · 이제 등록정보를 완성하고 최종검사를 실행할 수 있어.`}</div>
    <div class="switchRow"><div><b>${m.name} 등록 준비 대상</b><div class="tiny">실제 등록이 아니라 초안 준비 스위치야.</div></div><label><input id="enabled" type="checkbox" ${d.enabled?'checked':''}> 준비 ON</label></div>
    <div class="grid2">
      <section class="cardInner"><h3>1. 기본 등록정보</h3><div class="form">
        <label class="full">상품명 <span class="counter">${String(d.title||'').length}/120</span><input id="title" class="input" value="${esc(d.title)}"></label>
        <label>SKU<input id="sku" class="input" value="${esc(d.sku)}"></label><label>판매가 ${m.cur}<input id="price" class="input" type="number" step="any" min="0" value="${esc(d.priceLocal||'')}"></label>
        <label>등록재고<input id="stock" class="input" type="number" min="0" value="${esc(d.initialStock||0)}"></label><label>포장중량 g<input id="weight" class="input" type="number" min="1" value="${esc(d.weightG||'')}"></label>
        <label>가로 cm<input id="length" class="input" type="number" step="any" min="0" value="${esc(d.lengthCm||'')}"></label><label>세로 cm<input id="width" class="input" type="number" step="any" min="0" value="${esc(d.widthCm||'')}"></label>
        <label>높이 cm<input id="height" class="input" type="number" step="any" min="0" value="${esc(d.heightCm||'')}"></label><label>브랜드<input id="brand" class="input" value="${esc(d.brandName||'')}"></label>
        <label class="full">GTIN / JAN / EAN<input id="gtin" class="input" value="${esc(d.gtin||'')}"></label>
        <label class="full">상세설명<textarea id="description">${esc(d.description)}</textarea></label>
      </div></section>
      <section class="cardInner"><h3>2. Shop · 카테고리</h3><div class="form">
        <label class="full">등록 대상 Shop<select id="shop" class="select"><option value="">선택</option>${conns.map(x=>`<option value="${x.shopId}" ${Number(d.selectedShopId)===Number(x.shopId)?'selected':''}>${esc(x.shopName||'Shop')} · ${x.shopId}</option>`).join('')}</select></label>
        <label>카테고리 ID<input id="categoryId" class="input" type="number" min="1" value="${esc(d.categoryId||'')}"></label><label>카테고리명<input id="categoryName" class="input" value="${esc(d.categoryName||'')}"></label>
        <div class="full actions"><button class="btn ghost" id="loadCategories" ${d.selectedShopId?'':'disabled'}>카테고리 목록 불러오기</button><button class="btn ghost" id="loadAttributes" ${(d.selectedShopId&&d.categoryId)?'':'disabled'}>속성 불러오기</button><button class="btn ghost" id="loadLogistics" ${d.selectedShopId?'':'disabled'}>물류 불러오기</button></div>
        ${cats.length?`<label class="full">불러온 카테고리<select id="categoryPick" class="select"><option value="">선택</option>${cats.map(x=>`<option value="${categoryId(x)}">${categoryHasChildren(x)?'▶ 하위 있음':'✓ 최종'} · ${esc(categoryName(x))} · ${categoryId(x)}</option>`).join('')}</select><span class="tiny">▶ 항목은 최종 카테고리가 아니야. 선택하면 하위 카테고리를 다시 불러와. ✓ 최종 항목을 골라야 속성을 불러올 수 있어.</span></label>`:''}
      </div><div class="metaBox">현재 환경: <b>${esc(state.listingStatus.environment||'unknown')}</b><br>이 화면은 카테고리/속성/물류 조회와 이미지 Media 업로드만 하고 상품 생성은 하지 않아.</div></section>
    </div>
    <div class="section grid2">
      <section class="cardInner"><div class="section-head"><div><h3>3. 카테고리 속성</h3><p>필수속성을 위로 정렬해. 선택형은 Shopee 옵션을 사용하고 자유입력형은 value_id=0으로 준비해.</p></div></div>${renderAttributeFields(d)}</section>
      <section class="cardInner"><div class="section-head"><div><h3>4. 물류 채널</h3><p>현재 연결 Shop에서 사용할 채널만 선택해.</p></div></div>${renderLogistics(d)}</section>
    </div>
    <div class="section grid2">
      <section class="cardInner"><div class="section-head"><div><h3>5. 상품 이미지</h3><p>로컬 파일을 Shopee Media에 먼저 업로드해 image_id를 확보해.</p></div></div>${renderImages(d)}<label class="rowGap">이미지 원본 URL 메모<textarea id="imageUrls" placeholder="한 줄에 하나씩">${esc(d.imageUrls.join('\n'))}</textarea></label><div class="chips">${d.imageIds.map(id=>`<span>${esc(id)}</span>`).join('')}</div></section>
      <section class="cardInner"><div class="section-head"><div><h3>6. 등록 직전 최종검사</h3><p>클라이언트 체크 후 서버가 Shopee 현재 메타데이터를 다시 대조해.</p></div></div><div class="readiness ${r.ready?'ok':'bad'}"><b>${r.ready?'클라이언트 검사 통과':'아직 검사 전 단계'}</b>${r.blocks.length?`<ul>${r.blocks.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</div>${renderPreflight(d)}<div class="actions rowGap"><button class="btn" id="runPreflight" ${r.ready?'':'disabled'}>서버 최종검사 실행</button><button class="btn ghost" id="saveDraft">초안 저장</button><button class="btn ghost" id="exportOne">이 국가 패키지 JSON</button></div></section>
    </div>
    <div class="section">${renderSandboxPublish(c,code,d)}</div>`;
  bindEditor(c,code,d);
}

function bindEditor(c,code,d){
  const bind=(id,key,parser=v=>v)=>{const el=$(`#${id}`);if(!el)return;el.onchange=async()=>{d[key]=parser(el.value);touch(d);await saveCandidate(c,{quiet:true});renderAll()}};
  $('#enabled').onchange=async e=>{d.enabled=e.target.checked;touch(d);await saveCandidate(c,{quiet:true});renderAll()};
  bind('title','title');bind('sku','sku',cleanSku);bind('price','priceLocal',Number);bind('stock','initialStock',v=>Math.max(0,Math.floor(Number(v)||0)));bind('weight','weightG',Number);bind('length','lengthCm',Number);bind('width','widthCm',Number);bind('height','heightCm',Number);bind('brand','brandName');bind('gtin','gtin');bind('description','description');
  $('#shop').onchange=async e=>{d.selectedShopId=e.target.value?Number(e.target.value):null;d.categoryId='';d.categoryName='';d.logistics=[];d.attributes=[];d.mandatoryAttributeIds=[];d.attributeValues={};touch(d);await saveCandidate(c,{quiet:true});renderAll()};
  bind('categoryId','categoryId',v=>Number(v)||'');bind('categoryName','categoryName');
  $('#imageUrls').onchange=async e=>{d.imageUrls=String(e.target.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(0,9);touch(d);await saveCandidate(c,{quiet:true});renderAll()};
  $('#loadCategories')?.addEventListener('click',()=>loadCategories(d));
  $('#loadAttributes')?.addEventListener('click',()=>loadAttributes(c,code,d));
  $('#loadLogistics')?.addEventListener('click',()=>loadLogistics(d));
  $('#categoryPick')?.addEventListener('change',async e=>{
    const id=Number(e.target.value||0);if(!id)return;
    const x=(state.categoryCache[String(d.selectedShopId)]||[]).find(v=>categoryId(v)===id);
    if(x&&categoryHasChildren(x)){
      d.categoryId='';d.categoryName='';d.attributes=[];d.mandatoryAttributeIds=[];d.attributeValues={};touch(d);
      await saveCandidate(c,{quiet:true});
      return loadCategories(d,id);
    }
    d.categoryId=id;d.categoryName=x?categoryName(x):'';d.attributes=[];d.mandatoryAttributeIds=[];d.attributeValues={};touch(d);
    await saveCandidate(c,{quiet:true});renderAll();flash(`최종 카테고리 “${d.categoryName}”를 선택했어. 이제 속성 불러오기를 눌러줘.`);
  });
  $$('.attrSelect').forEach(el=>el.onchange=async()=>{const id=String(el.dataset.attrId);const meta=(state.attributeCache[attrCacheKey(d)]||[]).find(x=>attrId(x)===id);const vals=[...el.selectedOptions].map(o=>o.value).filter(Boolean);d.attributeValues[id]={valueIds:isMultiAttr(meta)?vals:vals.slice(0,1),text:''};rebuildAttributes(d,state.attributeCache[attrCacheKey(d)]||[]);touch(d);await saveCandidate(c,{quiet:true});renderAll()});
  $$('.attrText').forEach(el=>el.onchange=async()=>{const id=String(el.dataset.attrId);d.attributeValues[id]={valueIds:[],text:el.value.trim()};rebuildAttributes(d,state.attributeCache[attrCacheKey(d)]||[]);touch(d);await saveCandidate(c,{quiet:true});renderAll()});
  $$('.logisticCheck').forEach(el=>el.onchange=async()=>{d.logistics=$$('.logisticCheck:checked').map(x=>Number(x.value)).filter(Boolean);touch(d);await saveCandidate(c,{quiet:true});renderAll()});
  $('#uploadImages')?.addEventListener('click',()=>uploadImages(c,d));
  $$('[data-remove-image]').forEach(btn=>btn.onclick=async()=>{const i=Number(btn.dataset.removeImage);d.imageUploads.splice(i,1);d.imageIds=d.imageUploads.map(x=>x.imageId).filter(Boolean);touch(d);await saveCandidate(c,{quiet:true});renderAll()});
  $('#runPreflight')?.addEventListener('click',()=>runPreflight(c,code,d));
  $('#saveDraft')?.addEventListener('click',()=>saveCandidate(c));
  $('#exportOne')?.addEventListener('click',()=>saveBlob(`japanova-${c.id}-${code}-listing.json`,buildPackage(c,code)));
  const confirmInput=$('#sandboxConfirm'),publishBtn=$('#sandboxPublish');
  if(confirmInput&&publishBtn){
    const phrase=`SANDBOX PUBLISH ${code}`;
    const sync=()=>{publishBtn.disabled=!(state.listingStatus.environment==='sandbox'&&state.listingStatus.sandboxPublishEnabled&&d.preflight?.ready&&confirmInput.value.trim()===phrase)};
    confirmInput.addEventListener('input',sync);sync();
    publishBtn.addEventListener('click',()=>publishSandbox(c,code,d,confirmInput.value.trim()));
  }
}
async function loadCategories(d,parentCategoryId=0){
  if(!d.selectedShopId)return flash('Shop을 먼저 선택해줘.','warn');
  try{
    const qs=new URLSearchParams({shopId:String(d.selectedShopId),language:'en'});
    if(Number(parentCategoryId)>0)qs.set('parentCategoryId',String(parentCategoryId));
    const r=await api(`/api/candidates/listing/categories?${qs.toString()}`);
    const list=arr(r.categoryList);
    state.categoryCache[String(d.selectedShopId)]=list;
    renderEditor();
    flash(Number(parentCategoryId)>0
      ?`하위 카테고리 ${list.length}개를 불러왔어. ✓ 최종 항목을 선택해줘.`
      :`최상위 카테고리 ${list.length}개를 불러왔어. ▶ 항목을 선택해 계속 내려가면 돼.`);
  }catch(e){flash(e.message,'bad')}
}
async function loadAttributes(c,code,d){
  if(!d.selectedShopId||!(Number(d.categoryId)>0))return flash('Shop과 ✓ 최종 카테고리를 먼저 선택해줘.','warn');
  try{
    const r=await api(`/api/candidates/listing/attributes?shopId=${encodeURIComponent(d.selectedShopId)}&categoryId=${encodeURIComponent(d.categoryId)}&language=en`);
    const list=arr(r.attributeList);
    state.attributeCache[attrCacheKey(d)]=list;
    rebuildAttributes(d,list);touch(d);await saveCandidate(c,{quiet:true});renderAll();
    if(!list.length)return flash('속성이 0개야. 상위 카테고리를 고른 경우 이런 현상이 생겨. “카테고리 목록 불러오기”부터 다시 눌러 ▶ 하위 있음 항목을 계속 내려간 뒤 ✓ 최종 카테고리를 선택해줘.','warn');
    flash(`속성 ${list.length}개 · 필수 ${arr(r.mandatoryAttributes).length}개를 불러왔어.`);
  }catch(e){flash(e.message,'bad')}
}
async function loadLogistics(d){
  if(!d.selectedShopId)return flash('Shop을 먼저 선택해줘.','warn');
  try{const r=await api(`/api/candidates/listing/logistics?shopId=${encodeURIComponent(d.selectedShopId)}`);state.logisticsCache[String(d.selectedShopId)]=arr(r.logisticsChannels);renderEditor();flash(`물류채널 ${arr(r.logisticsChannels).length}개를 불러왔어.`)}catch(e){flash(e.message,'bad')}
}
async function uploadImages(c,d){
  const input=$('#imageFiles'),files=[...(input?.files||[])];if(!files.length)return flash('업로드할 이미지 파일을 선택해줘.','warn');
  if(!d.selectedShopId)return flash('등록 대상 Shop을 먼저 선택해줘.','warn');
  if(d.imageIds.length+files.length>9)return flash('기존 image_id와 합쳐 최대 9개까지만 업로드할 수 있어.','warn');
  if(state.busy)return;state.busy=true;
  try{
    for(let i=0;i<files.length;i++){
      const f=files[i];flash(`${i+1}/${files.length} ${f.name} 업로드 중...`,'warn');
      const form=new FormData();form.append('confirm','UPLOAD_IMAGE');form.append('shopId',String(d.selectedShopId));form.append('image',f,f.name);
      const r=await api('/api/candidates/listing/upload-image',{method:'POST',body:form});
      d.imageUploads.push({imageId:r.imageId,imageUrl:r.imageUrl||'',fileName:r.fileName||f.name,size:r.size||f.size,shopId:Number(d.selectedShopId),uploadedAt:now()});
    }
    d.imageUploads=d.imageUploads.slice(0,9);d.imageIds=d.imageUploads.map(x=>x.imageId).filter(Boolean);touch(d);await saveCandidate(c,{quiet:true});renderAll();flash(`${files.length}개 이미지를 Shopee Media에 업로드했어.`);
  }catch(e){flash(e.message,'bad')}finally{state.busy=false}
}
async function runPreflight(c,code,d){
  if(state.busy)return;state.busy=true;
  try{
    const metadata=state.attributeCache[attrCacheKey(d)]||[];if(metadata.length)rebuildAttributes(d,metadata);
    await saveCandidate(c,{quiet:true});
    const r=await api('/api/candidates/listing/preflight',{method:'POST',body:{candidateId:c.id,marketCode:code}});
    d.preflight=r;await saveCandidate(c,{quiet:true});renderAll();flash(r.ready?(state.listingStatus.environment==='sandbox'&&state.listingStatus.sandboxPublishEnabled?'서버 최종검사를 통과했어. 이제 Sandbox 테스트 등록이 가능해.':'서버 최종검사를 통과했어. 상품등록은 현재 잠금 상태야.'):`최종검사에서 ${arr(r.blockers).length}개 차단 사유를 찾았어.`,r.ready?'ok':'warn');
  }catch(e){flash(e.message,'bad')}finally{state.busy=false}
}

async function publishSandbox(c,code,d,confirmText){
  if(state.busy)return;
  if(state.listingStatus.environment!=='sandbox'||!state.listingStatus.sandboxPublishEnabled)return flash('Sandbox 등록 안전스위치가 꺼져 있어.','bad');
  if(!d.preflight?.ready)return flash('서버 최종검사를 먼저 통과해야 해.','warn');
  const phrase=`SANDBOX PUBLISH ${code}`;
  if(confirmText!==phrase)return flash(`확인문구를 정확히 입력해줘: ${phrase}`,'warn');
  if(!window.confirm(`${market(code).name} Sandbox에 UNLIST 테스트 상품 1개를 실제 생성할까?\nProduction 상점에는 영향 없어.`))return;
  state.busy=true;
  try{
    const r=await api('/api/candidates/listing/publish',{method:'POST',body:{candidateId:c.id,marketCode:code,confirm:'SANDBOX_PUBLISH',confirmText:phrase}});
    flash(r.message||'Sandbox 테스트 상품을 생성했어.');
    await load();
  }catch(e){flash(e.message,'bad')}finally{state.busy=false}
}
function renderSummary(){
  const c=candidate(),body=$('#packageRows');if(!c){body.innerHTML='<tr><td colspan="8" class="empty">후보상품이 없어.</td></tr>';return}
  body.innerHTML=MARKETS.map(m=>{const d=draft(c,m.code),r=clientReadiness(c,m.code);const status=d.preflight?.ready?'<span class="ok">최종검사 통과</span>':r.ready?'<span class="warn">서버검사 대기</span>':d.enabled?'<span class="warn">작성중</span>':'대기';return `<tr><td>${m.name}</td><td>${d.enabled?'ON':'OFF'}</td><td>${esc(d.title||'-')}</td><td>${localPrice(d.priceLocal,m.cur)}</td><td>${d.categoryId?`${esc(d.categoryName||'')} #${esc(d.categoryId)}`:'-'}</td><td>${d.mandatoryAttributeIds.length?`${d.attributes.length}/${d.mandatoryAttributeIds.length}+`:'-'}</td><td>${d.imageIds.length}/9</td><td>${status}</td></tr>`}).join('');
}
function renderAll(){renderMetrics();renderCandidateSelect();renderHeader();renderMarketTabs();renderEditor();renderSummary()}

$('#candidateSelect').onchange=e=>{state.selectedId=e.target.value;renderAll()};
$('#seedSandbox').onclick=()=>seedSandboxCandidate();
$('#exportAll').onclick=()=>{const c=candidate();if(!c)return;saveBlob(`japanova-${c.id}-all-listing-packages.json`,{schema:'JAPANOVA_LISTING_BUNDLE_V2',generatedAt:now(),candidateId:c.id,candidateName:c.name,packages:Object.fromEntries(MARKETS.map(m=>[m.code,buildPackage(c,m.code)]))})};
$('#navResearch').onclick=()=>location.href='./v11.html';$('#navValidation').onclick=()=>location.href='./v10.html';$('#navOps').onclick=()=>location.href='./v08.html';

load().catch(e=>{flash(`불러오기 실패: ${e.message}`,'bad');$('#editor').innerHTML='<div class="empty">데이터를 불러오지 못했어.</div>'});
})();
