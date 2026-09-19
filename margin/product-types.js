/* JAPANOVA v5.12 — options / variants / bundles */
(function(){
  if (typeof openProductModal !== 'function' || typeof productFormRead !== 'function') return;

  var openProductModalV511 = openProductModal;
  var renderProductManagerV511 = renderProductManager;

  function saleTypeOf(p){ return p && p.saleType ? p.saleType : 'single'; }
  function saleTypeLabel(t){ return t === 'variant' ? '옵션 있음' : t === 'bundle' ? '세트·번들' : '옵션 없음'; }
  function escAttrV512(v){ return esc(String(v == null ? '' : v)); }
  function splitValuesV512(v){
    var seen = {};
    return String(v || '').split(/[\n,|]+/).map(function(x){ return x.trim(); }).filter(function(x){
      if(!x || seen[x]) return false; seen[x] = true; return true;
    });
  }
  function normalizeProductV512(p){
    p = p || {};
    if(!p.saleType) p.saleType = 'single';
    if(!Array.isArray(p.variants)) p.variants = [];
    if(!p.optionDefinition || typeof p.optionDefinition !== 'object') p.optionDefinition = {name1:'',values1:[],name2:'',values2:[]};
    if(!p.bundle || typeof p.bundle !== 'object') p.bundle = {components:[],extraCost:0,extraWeight:0};
    if(!Array.isArray(p.bundle.components)) p.bundle.components = [];
    if(!p.markets || typeof p.markets !== 'object') p.markets = {};
    return p;
  }
  function variantNameV512(p,v){
    var a = [];
    if(v && v.option1) a.push(v.option1);
    if(v && v.option2) a.push(v.option2);
    return a.length ? a.join(' / ') : (v && v.id ? v.id : '옵션');
  }
  function variantByIdV512(p,id){
    return (p.variants || []).find(function(v){ return String(v.id) === String(id); }) || null;
  }
  function allJansV512(p){
    var vals = [];
    if(p.jan) vals.push(String(p.jan).trim());
    (p.variants || []).forEach(function(v){ if(v.jan) vals.push(String(v.jan).trim()); });
    return vals.filter(Boolean);
  }
  function componentCatalogV512(currentId){
    var out = [];
    (productCache || []).forEach(function(p){
      if(!p || p.id === currentId || saleTypeOf(p) === 'bundle') return;
      if(saleTypeOf(p) === 'variant' && Array.isArray(p.variants) && p.variants.length){
        p.variants.forEach(function(v){
          out.push({ref:p.id + '::' + v.id,label:p.id + ' · ' + p.name + ' · ' + variantNameV512(p,v),cost:Number(v.cost)||0,weight:Number(v.weight)||0,stock:Math.max(0,Number(v.stock)||0)});
        });
      }else{
        out.push({ref:p.id,label:p.id + ' · ' + p.name,cost:Number(p.cost)||0,weight:Number(p.weight)||0,stock:Math.max(0,Number(p.stock)||0)});
      }
    });
    return out;
  }
  function resolveComponentV512(ref){
    if(!ref) return null;
    var parts = String(ref).split('::');
    var p = (productCache || []).find(function(x){ return x.id === parts[0]; });
    if(!p) return null;
    if(parts[1]){
      var v = variantByIdV512(p,parts[1]);
      if(!v) return null;
      return {ref:ref,label:p.id + ' · ' + p.name + ' · ' + variantNameV512(p,v),cost:Number(v.cost)||0,weight:Number(v.weight)||0,stock:Math.max(0,Number(v.stock)||0)};
    }
    return {ref:ref,label:p.id + ' · ' + p.name,cost:Number(p.cost)||0,weight:Number(p.weight)||0,stock:Math.max(0,Number(p.stock)||0)};
  }
  function bundleMetricsV512(bundle){
    bundle = bundle || {components:[],extraCost:0,extraWeight:0};
    var totalCost = Math.max(0,Number(bundle.extraCost)||0);
    var totalWeight = Math.max(0,Number(bundle.extraWeight)||0);
    var limits = [];
    (bundle.components || []).forEach(function(c){
      var r = resolveComponentV512(c.ref), qty = Math.max(1,Math.floor(Number(c.qty)||1));
      if(!r) return;
      totalCost += r.cost * qty;
      totalWeight += r.weight * qty;
      limits.push(Math.floor(r.stock / qty));
    });
    return {cost:totalCost,weight:totalWeight,stock:limits.length ? Math.max(0,Math.min.apply(Math,limits)) : 0};
  }
  function currentTypeV512(){
    var el = document.querySelector('input[name="saleType"]:checked');
    return el ? el.value : saleTypeOf(editingProduct);
  }

  function readVariantRowsV512(){
    var rows = [];
    document.querySelectorAll('[data-variant-row]').forEach(function(tr){
      rows.push({
        id:tr.dataset.variantRow,
        option1:tr.dataset.option1 || '',
        option2:tr.dataset.option2 || '',
        jan:(tr.querySelector('[data-v-field="jan"]') || {}).value || '',
        cost:Math.max(0,Number((tr.querySelector('[data-v-field="cost"]') || {}).value)||0),
        weight:Math.max(0,Number((tr.querySelector('[data-v-field="weight"]') || {}).value)||0),
        stock:Math.max(0,Math.floor(Number((tr.querySelector('[data-v-field="stock"]') || {}).value)||0))
      });
    });
    return rows;
  }
  function readBundleRowsV512(){
    var rows = [];
    document.querySelectorAll('[data-bundle-row]').forEach(function(tr){
      var sel = tr.querySelector('[data-b-field="ref"]'), qty = tr.querySelector('[data-b-field="qty"]');
      if(sel && sel.value) rows.push({ref:sel.value,qty:Math.max(1,Math.floor(Number(qty && qty.value)||1))});
    });
    return rows;
  }
  function syncTypeEditorV512(){
    if(!editingProduct) return;
    editingProduct = normalizeProductV512(editingProduct);
    editingProduct.saleType = currentTypeV512();
    if(editingProduct.saleType === 'variant'){
      editingProduct.optionDefinition = {
        name1:($('pOption1Name') && $('pOption1Name').value.trim()) || '',
        values1:splitValuesV512($('pOption1Values') && $('pOption1Values').value),
        name2:($('pOption2Name') && $('pOption2Name').value.trim()) || '',
        values2:splitValuesV512($('pOption2Values') && $('pOption2Values').value)
      };
      editingProduct.variants = readVariantRowsV512();
    }else if(editingProduct.saleType === 'bundle'){
      editingProduct.bundle = {
        components:readBundleRowsV512(),
        extraCost:Math.max(0,Number($('pBundleExtraCost') && $('pBundleExtraCost').value)||0),
        extraWeight:Math.max(0,Number($('pBundleExtraWeight') && $('pBundleExtraWeight').value)||0)
      };
    }
  }
  function updateVariantSummaryV512(){
    var el = $('variantSummary');
    if(!el) return;
    var rows = readVariantRowsV512();
    if(!rows.length){ el.innerHTML = '<strong>옵션 조합을 만들어 줘.</strong> 옵션명과 옵션값을 입력한 뒤 조합 생성 버튼을 누르면 돼.'; return; }
    var stocks = rows.reduce(function(a,v){ return a + (Number(v.stock)||0); },0);
    var costs = rows.map(function(v){ return Number(v.cost)||0; });
    var weights = rows.map(function(v){ return Number(v.weight)||0; });
    el.innerHTML = '<strong>' + rows.length + '개 옵션</strong> · 총재고 ' + stocks.toLocaleString('ko-KR') + '개 · 원가 ¥' + Math.min.apply(Math,costs).toLocaleString('ko-KR') + ' ~ ¥' + Math.max.apply(Math,costs).toLocaleString('ko-KR') + ' · 최대중량 ' + Math.max.apply(Math,weights).toLocaleString('ko-KR') + 'g';
    if($('pStock')) $('pStock').value = stocks;
  }
  function renderVariantRowsV512(){
    var body = $('variantRows');
    if(!body || !editingProduct) return;
    var p = editingProduct, rows = p.variants || [];
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="8"><div class="product-empty" style="padding:20px 10px"><strong>옵션 조합이 없어.</strong><span>예: 색상 블랙/화이트 + 사이즈 S/M/L</span></div></td></tr>';
      updateVariantSummaryV512();
      return;
    }
    body.innerHTML = rows.map(function(v){
      return '<tr data-variant-row="' + escAttrV512(v.id) + '" data-option1="' + escAttrV512(v.option1 || '') + '" data-option2="' + escAttrV512(v.option2 || '') + '">' +
        '<td><span class="variant-code">' + escAttrV512(v.id) + '</span></td>' +
        '<td><span class="variant-option">' + escAttrV512(variantNameV512(p,v)) + '</span></td>' +
        '<td><input data-v-field="jan" value="' + escAttrV512(v.jan || '') + '" placeholder="옵션 JAN"></td>' +
        '<td><input data-v-field="cost" type="number" min="0" step="any" value="' + (Number(v.cost)||0) + '"></td>' +
        '<td><input data-v-field="weight" type="number" min="0" step="any" value="' + (Number(v.weight)||0) + '"></td>' +
        '<td><input data-v-field="stock" type="number" min="0" step="1" value="' + (Number(v.stock)||0) + '"></td>' +
        '<td><span class="variant-code">' + escAttrV512((p.id || 'JNV-자동') + '-' + v.id) + '</span></td>' +
        '<td><button class="type-action danger" data-remove-variant="' + escAttrV512(v.id) + '" type="button">삭제</button></td>' +
      '</tr>';
    }).join('');
    updateVariantSummaryV512();
  }
  function generateVariantsV512(){
    if(!editingProduct) return;
    syncTypeEditorV512();
    var name1 = ($('pOption1Name').value || '').trim(), vals1 = splitValuesV512($('pOption1Values').value);
    var name2 = ($('pOption2Name').value || '').trim(), vals2 = splitValuesV512($('pOption2Values').value);
    if(!name1 || !vals1.length){ setProductMessage('옵션명 1과 옵션값 1을 입력해 줘.','bad'); return; }
    if(name2 && !vals2.length){ setProductMessage('옵션명 2를 사용한다면 옵션값 2도 입력해 줘.','bad'); return; }
    if(!name2) vals2 = [''];
    var old = {};
    (editingProduct.variants || []).forEach(function(v){ old[(v.option1||'') + '\u0001' + (v.option2||'')] = v; });
    var seq = (editingProduct.variants || []).reduce(function(m,v){ var n = Number(String(v.id||'').replace(/\D/g,''))||0; return Math.max(m,n); },0) + 1;
    var defaultsCost = Math.max(0,Number($('pCost').value)||0), defaultsWeight = Math.max(0,Number($('pWeight').value)||0);
    var made = [];
    vals1.forEach(function(a){ vals2.forEach(function(b){
      var key = a + '\u0001' + b, prev = old[key];
      made.push(prev || {id:'V' + String(seq++).padStart(3,'0'),option1:a,option2:b,jan:'',cost:defaultsCost,weight:defaultsWeight,stock:0});
    });});
    editingProduct.optionDefinition = {name1:name1,values1:vals1,name2:name2,values2:name2?vals2:[]};
    editingProduct.variants = made;
    renderVariantRowsV512();
    renderMarketEditor();
    setProductMessage(made.length + '개 옵션 조합을 만들었어. 각 옵션의 JAN·원가·중량·재고를 확인해 줘.','good');
  }
  function renderBundleRowsV512(){
    var body = $('bundleRows');
    if(!body || !editingProduct) return;
    var comps = editingProduct.bundle.components || [], catalog = componentCatalogV512(editingProduct.id);
    if(!comps.length){
      body.innerHTML = '<tr><td colspan="5"><div class="product-empty" style="padding:20px 10px"><strong>구성품이 없어.</strong><span>아래 버튼으로 이미 등록한 상품을 세트에 추가해 줘.</span></div></td></tr>';
      updateBundleSummaryV512();
      return;
    }
    body.innerHTML = comps.map(function(c,i){
      var opts = catalog.map(function(x){ return '<option value="' + escAttrV512(x.ref) + '"' + (x.ref===c.ref?' selected':'') + '>' + escAttrV512(x.label) + '</option>'; }).join('');
      var r = resolveComponentV512(c.ref), qty = Math.max(1,Number(c.qty)||1);
      return '<tr data-bundle-row="' + i + '">' +
        '<td><select class="bundle-product-select" data-b-field="ref">' + opts + '</select></td>' +
        '<td><input data-b-field="qty" type="number" min="1" step="1" value="' + qty + '"></td>' +
        '<td>' + (r ? '¥' + (r.cost*qty).toLocaleString('ko-KR') : '—') + '</td>' +
        '<td>' + (r ? (r.weight*qty).toLocaleString('ko-KR') + 'g' : '—') + '</td>' +
        '<td><button class="type-action danger" data-remove-bundle="' + i + '" type="button">삭제</button></td>' +
      '</tr>';
    }).join('');
    updateBundleSummaryV512();
  }
  function updateBundleSummaryV512(){
    if(!editingProduct || !$('bundleSummary')) return;
    var bundle = {
      components:readBundleRowsV512(),
      extraCost:Math.max(0,Number($('pBundleExtraCost') && $('pBundleExtraCost').value)||0),
      extraWeight:Math.max(0,Number($('pBundleExtraWeight') && $('pBundleExtraWeight').value)||0)
    };
    editingProduct.bundle = bundle;
    var m = bundleMetricsV512(bundle);
    if($('pCost')) $('pCost').value = m.cost;
    if($('pWeight')) $('pWeight').value = m.weight;
    if($('pStock')) $('pStock').value = m.stock;
    $('bundleSummary').innerHTML = '<strong>자동 계산</strong> · 세트 원가 ¥' + Math.round(m.cost).toLocaleString('ko-KR') + ' · 총중량 ' + Math.round(m.weight).toLocaleString('ko-KR') + 'g · 현재 판매가능 ' + m.stock.toLocaleString('ko-KR') + '세트';
  }
  function renderProductTypeEditorV512(){
    if(!editingProduct) return;
    editingProduct = normalizeProductV512(editingProduct);
    var t = saleTypeOf(editingProduct);
    var radio = document.querySelector('input[name="saleType"][value="' + t + '"]');
    if(radio) radio.checked = true;
    $('variantSection').classList.toggle('hidden',t!=='variant');
    $('bundleSection').classList.toggle('hidden',t!=='bundle');
    var stock = $('pStock'), cost = $('pCost'), weight = $('pWeight');
    [cost,weight,stock].forEach(function(x){ if(x){ x.readOnly=false; x.classList.remove('readonly-derived'); }});
    if(t === 'variant'){
      var od = editingProduct.optionDefinition || {};
      $('pOption1Name').value = od.name1 || '';
      $('pOption1Values').value = Array.isArray(od.values1) ? od.values1.join(', ') : '';
      $('pOption2Name').value = od.name2 || '';
      $('pOption2Values').value = Array.isArray(od.values2) ? od.values2.join(', ') : '';
      if(stock){ stock.readOnly=true; stock.classList.add('readonly-derived'); }
      renderVariantRowsV512();
    }
    if(t === 'bundle'){
      var b = editingProduct.bundle || {};
      $('pBundleExtraCost').value = Number(b.extraCost)||0;
      $('pBundleExtraWeight').value = Number(b.extraWeight)||0;
      [cost,weight,stock].forEach(function(x){ if(x){ x.readOnly=true; x.classList.add('readonly-derived'); }});
      renderBundleRowsV512();
    }
    renderMarketEditor();
  }

  openProductModal = function(p){
    var q = p ? normalizeProductV512(cloneProduct(p)) : null;
    openProductModalV511(q);
    editingProduct = normalizeProductV512(editingProduct);
    renderProductTypeEditorV512();
  };

  productFormRead = function(){
    var p = editingProduct ? cloneProduct(editingProduct) : {id:'',markets:{},createdAt:new Date().toISOString()};
    p = normalizeProductV512(p);
    p.name = $('pName').value.trim();
    p.jan = $('pJan').value.trim();
    p.category = $('pCategory').value.trim();
    p.cost = Math.max(0,Number($('pCost').value)||0);
    p.weight = Math.max(0,Number($('pWeight').value)||0);
    p.stock = Math.max(0,Math.floor(Number($('pStock').value)||0));
    p.supplier = $('pSupplier').value.trim();
    p.supplierUrl = $('pSupplierUrl').value.trim();
    p.note = $('pNote').value.trim();
    p.saleType = currentTypeV512();
    if(p.saleType === 'variant'){
      p.optionDefinition = {
        name1:$('pOption1Name').value.trim(),values1:splitValuesV512($('pOption1Values').value),
        name2:$('pOption2Name').value.trim(),values2:splitValuesV512($('pOption2Values').value)
      };
      p.variants = readVariantRowsV512();
      p.stock = p.variants.reduce(function(a,v){ return a + (Number(v.stock)||0); },0);
      if(p.variants.length){
        p.cost = Math.min.apply(Math,p.variants.map(function(v){ return Number(v.cost)||0; }));
        p.weight = Math.max.apply(Math,p.variants.map(function(v){ return Number(v.weight)||0; }));
      }
    }else if(p.saleType === 'bundle'){
      p.bundle = {
        components:readBundleRowsV512(),
        extraCost:Math.max(0,Number($('pBundleExtraCost').value)||0),
        extraWeight:Math.max(0,Number($('pBundleExtraWeight').value)||0)
      };
      var bm = bundleMetricsV512(p.bundle); p.cost=bm.cost; p.weight=bm.weight; p.stock=bm.stock;
    }
    p.markets = p.markets || {};
    document.querySelectorAll('[data-market-card]').forEach(function(card){
      var c = card.dataset.marketCard, m = p.markets[c] || marketEmpty(p,c);
      card.querySelectorAll('[data-market-field]').forEach(function(el){
        var k=el.dataset.marketField,v=el.value;m[k]=(k==='price'||k==='margin')?(v===''?'':Number(v)):v;
      });
      if(p.saleType === 'variant'){
        m.variants = m.variants || {};
        card.querySelectorAll('[data-market-variant-row]').forEach(function(tr){
          var vid = tr.dataset.marketVariantRow, vm = m.variants[vid] || {};
          tr.querySelectorAll('[data-market-variant-field]').forEach(function(el){
            var k=el.dataset.marketVariantField,v=el.value;vm[k]=(k==='price'||k==='margin')?(v===''?'':Number(v)):v;
          });
          m.variants[vid]=vm;
        });
      }
      m.updatedAt=new Date().toISOString();p.markets[c]=m;
    });
    return p;
  };

  function ensureMarketVariantsV512(p,c,m){
    m.variants = m.variants || {};
    (p.variants || []).forEach(function(v){
      if(!m.variants[v.id]) m.variants[v.id]={sku:(MARKET_CODES[c]||'')+'-'+(p.id||'JNV-자동')+'-'+v.id,price:'',margin:''};
    });
    Object.keys(m.variants).forEach(function(id){ if(!variantByIdV512(p,id)) delete m.variants[id]; });
    return m;
  }

  renderMarketEditor = function(){
    if(!editingProduct)return;
    var p=normalizeProductV512(editingProduct),mk=p.markets||{};
    $('marketAddRow').innerHTML=Object.keys(data.markets).map(function(c){
      return '<button class="market-add-btn" data-add-market="'+c+'" type="button" '+(mk[c]?'disabled':'')+'>'+(FLAGS[c]||'')+' '+MARKET_CODES[c]+(mk[c]?' · 추가됨':' 추가')+'</button>';
    }).join('');
    var cards = Object.keys(data.markets).filter(function(c){return mk[c];}).map(function(c){
      var m=mk[c],cur=data.markets[c].cur;
      if(saleTypeOf(p)==='variant'){
        ensureMarketVariantsV512(p,c,m);
        var vr=(p.variants||[]).map(function(v){
          var vm=m.variants[v.id]||{};
          return '<tr data-market-variant-row="'+escAttrV512(v.id)+'"><td><span class="variant-code">'+escAttrV512(v.id)+'</span><span class="product-meta">'+escAttrV512(variantNameV512(p,v))+'</span></td>'+
            '<td><input data-market-variant-field="sku" value="'+escAttrV512(vm.sku||'')+'"></td>'+
            '<td><input data-market-variant-field="price" type="number" min="0" step="any" value="'+(vm.price===''?'':Number(vm.price)||0)+'"></td>'+
            '<td><input data-market-variant-field="margin" type="number" step="any" value="'+(vm.margin===''?'':Number(vm.margin)||0)+'"></td>'+
            '<td><div class="product-row-actions"><button class="product-btn small" data-load-variant="'+c+'" data-variant-id="'+escAttrV512(v.id)+'" type="button">계산</button><button class="product-btn small" data-save-variant="'+c+'" data-variant-id="'+escAttrV512(v.id)+'" type="button">결과저장</button></div></td></tr>';
        }).join('');
        return '<div class="market-card" data-market-card="'+c+'"><div class="market-card-head"><span class="market-label">'+(FLAGS[c]||'')+' '+c+' · '+cur+'</span><span class="market-state">옵션 '+(p.variants||[]).length+'개 · '+escAttrV512(p.id||'저장 전')+'</span></div><div class="market-card-body">'+
          '<div class="market-edit-grid"><label>상태<select data-market-field="status">'+['등록준비','판매중','품절','판매중단'].map(function(v){return '<option value="'+v+'" '+(m.status===v?'selected':'')+'>'+v+'</option>';}).join('')+'</select></label><label>Shopee 상품 URL<input data-market-field="listingUrl" type="url" value="'+escAttrV512(m.listingUrl||'')+'" placeholder="https://..."></label><label>등록일<input data-market-field="registeredAt" type="date" value="'+escAttrV512(m.registeredAt||'')+'"></label></div>'+
          '<div class="market-variant-wrap"><table class="market-variant-table"><thead><tr><th>옵션</th><th>Shopee SKU</th><th>판매가 · '+cur+'</th><th>마진율 %</th><th>마진계산</th></tr></thead><tbody>'+vr+'</tbody></table></div>'+
          '<div class="market-card-actions"><button class="product-btn small danger" data-remove-market="'+c+'" type="button">국가 정보 삭제</button></div></div></div>';
      }
      return '<div class="market-card" data-market-card="'+c+'"><div class="market-card-head"><span class="market-label">'+(FLAGS[c]||'')+' '+c+' · '+cur+'</span><span class="market-state">'+(saleTypeOf(p)==='bundle'?'세트·번들':'단품')+' · '+escAttrV512(p.id||'저장 전')+'</span></div><div class="market-card-body"><div class="market-edit-grid">'+
        '<label>Shopee SKU<input data-market-field="sku" value="'+escAttrV512(m.sku||'')+'" placeholder="'+escAttrV512((MARKET_CODES[c]||'')+'-'+(p.id||'JNV-자동'))+'"><small>자동 생성 후 수정 가능</small></label>'+
        '<label>판매가 · '+cur+'<input data-market-field="price" type="number" min="0" step="any" value="'+(m.price===''?'':Number(m.price)||0)+'"></label>'+
        '<label>마진율 · %<input data-market-field="margin" type="number" step="any" value="'+(m.margin===''?'':Number(m.margin)||0)+'"></label>'+
        '<label>상태<select data-market-field="status">'+['등록준비','판매중','품절','판매중단'].map(function(v){return '<option value="'+v+'" '+(m.status===v?'selected':'')+'>'+v+'</option>';}).join('')+'</select></label>'+
        '<label>Shopee 상품 URL<input data-market-field="listingUrl" type="url" value="'+escAttrV512(m.listingUrl||'')+'" placeholder="https://..."></label><label>등록일<input data-market-field="registeredAt" type="date" value="'+escAttrV512(m.registeredAt||'')+'"></label></div>'+
        '<div class="market-card-actions"><button class="product-btn small" data-load-margin="'+c+'" type="button">마진계산기로 불러오기</button><button class="product-btn small" data-save-margin="'+c+'" type="button">현재 계산결과 저장</button><button class="product-btn small danger" data-remove-market="'+c+'" type="button">국가 정보 삭제</button></div></div></div>';
    });
    $('marketEditor').innerHTML=cards.join('')||'<div class="product-empty" style="padding:22px 10px"><strong>아직 등록된 국가가 없어.</strong><span>위 국가 버튼을 눌러 필요한 마켓만 추가하면 돼.</span></div>';
  };

  saveProductForm = async function(){
    var p=productFormRead();
    if(!p.name){setProductMessage('상품명을 입력해 줘.','bad');return}
    if(p.saleType==='variant' && !p.variants.length){setProductMessage('옵션 상품은 최소 1개의 옵션 조합이 필요해.','bad');return}
    if(p.saleType==='bundle' && !(p.bundle.components||[]).length){setProductMessage('세트·번들은 최소 1개의 구성품이 필요해.','bad');return}
    var currentJans=allJansV512(p), seen={};
    for(var i=0;i<currentJans.length;i++){if(seen[currentJans[i]]){setProductMessage('같은 상품 안에 중복된 JAN이 있어. 옵션 JAN을 확인해 줘.','bad');return}seen[currentJans[i]]=1;}
    var dup=null,dupJan='';
    productCache.some(function(x){
      if(x.id===p.id)return false;
      var xj=allJansV512(normalizeProductV512(cloneProduct(x)));
      for(var a=0;a<currentJans.length;a++){if(xj.indexOf(currentJans[a])>=0){dup=x;dupJan=currentJans[a];return true;}}
      return false;
    });
    if(dup){setProductMessage('JAN '+dupJan+' 이(가) 이미 '+dup.id+'에 등록돼 있어.','bad');return}
    if(!p.id){
      p.id=await nextProductId();
      Object.keys(p.markets||{}).forEach(function(c){
        var m=p.markets[c];
        if(!m.sku||String(m.sku).indexOf('JNV-자동')>=0)m.sku=MARKET_CODES[c]+'-'+p.id;
        if(m.variants)Object.keys(m.variants).forEach(function(vid){
          var vm=m.variants[vid];if(!vm.sku||String(vm.sku).indexOf('JNV-자동')>=0)vm.sku=MARKET_CODES[c]+'-'+p.id+'-'+vid;
        });
      });
    }
    p.updatedAt=new Date().toISOString();if(!p.createdAt)p.createdAt=p.updatedAt;
    await productPut(p);setProductMessage(p.id+' 저장 완료','good');closeProductModal();await refreshProductCache();
  };

  loadProductToMargin = function(c){
    syncTypeEditorV512();
    var p=productFormRead(),m=p.markets[c];
    country=c;states[c].cost=Number(p.cost)||0;states[c].weight=Math.max(1,Number(p.weight)||1);
    if(m&&Number(m.price)>0){states[c].price=Number(m.price);simPrices[c]=states[c].price}
    saveState();setActiveTool('margin');render();closeProductModal();
  };
  saveCurrentMarginToEditor = function(c){
    syncTypeEditorV512();
    if(country!==c||!window.marginResult||window.marginResult.error){setProductMessage((FLAGS[c]||'')+' '+c+' 마진계산 탭을 먼저 계산한 뒤 저장해 줘.','bad');return}
    var m=editingProduct.markets[c]||(editingProduct.markets[c]=marketEmpty(editingProduct,c));m.price=Number(states[c].price)||'';m.margin=Number(window.marginResult.margin);m.updatedAt=new Date().toISOString();
    setProductMessage(c+' 현재 판매가·마진을 상품에 반영했어. 아래 상품 저장을 눌러 확정해 줘.','good');renderMarketEditor();
  };
  function loadVariantToMarginV512(c,vid){
    syncTypeEditorV512();
    var p=productFormRead(),v=variantByIdV512(p,vid),m=p.markets[c],vm=m&&m.variants&&m.variants[vid];
    if(!v)return;
    country=c;states[c].cost=Number(v.cost)||0;states[c].weight=Math.max(1,Number(v.weight)||1);
    if(vm&&Number(vm.price)>0){states[c].price=Number(vm.price);simPrices[c]=states[c].price}
    saveState();setActiveTool('margin');render();closeProductModal();
  }
  function saveVariantMarginV512(c,vid){
    syncTypeEditorV512();
    if(country!==c||!window.marginResult||window.marginResult.error){setProductMessage((FLAGS[c]||'')+' '+c+' 마진계산 탭에서 해당 옵션을 먼저 계산해 줘.','bad');return}
    var p=editingProduct,m=p.markets[c]||(p.markets[c]=marketEmpty(p,c));ensureMarketVariantsV512(p,c,m);
    var vm=m.variants[vid];vm.price=Number(states[c].price)||'';vm.margin=Number(window.marginResult.margin);vm.updatedAt=new Date().toISOString();
    setProductMessage(c+' · '+vid+' 계산결과를 반영했어. 상품 저장을 눌러 확정해 줘.','good');renderMarketEditor();
  }

  renderProductManager = function(){
    renderProductManagerV511();
    document.querySelectorAll('[data-product-open]').forEach(function(btn){
      var p=(productCache||[]).find(function(x){return x.id===btn.dataset.productOpen;});
      if(!p)return;var row=btn.closest('tr'),meta=row&&row.querySelector('.product-meta');
      if(meta && !meta.querySelector('.product-type-badge')){
        var b=document.createElement('span');b.className='product-type-badge';b.textContent=saleTypeLabel(saleTypeOf(p));meta.appendChild(b);
      }
    });
  };

  var chooser = $('saleTypeChooser');
  if(chooser) chooser.addEventListener('change',function(e){
    if(!e.target.matches('input[name="saleType"]'))return;
    syncTypeEditorV512();editingProduct.saleType=e.target.value;renderProductTypeEditorV512();
  });
  if($('generateVariants')) $('generateVariants').addEventListener('click',generateVariantsV512);
  if($('variantRows')) {
    $('variantRows').addEventListener('input',updateVariantSummaryV512);
    $('variantRows').addEventListener('click',function(e){
      var b=e.target.closest('[data-remove-variant]');if(!b)return;
      syncTypeEditorV512();editingProduct.variants=(editingProduct.variants||[]).filter(function(v){return v.id!==b.dataset.removeVariant;});renderVariantRowsV512();renderMarketEditor();
    });
  }
  if($('addBundleComponent')) $('addBundleComponent').addEventListener('click',function(){
    syncTypeEditorV512();var cat=componentCatalogV512(editingProduct.id);
    if(!cat.length){setProductMessage('세트에 넣을 기존 상품을 먼저 등록해 줘.','bad');return}
    editingProduct.bundle.components.push({ref:cat[0].ref,qty:1});renderBundleRowsV512();
  });
  if($('bundleRows')){
    $('bundleRows').addEventListener('change',function(){syncTypeEditorV512();renderBundleRowsV512();});
    $('bundleRows').addEventListener('input',function(){updateBundleSummaryV512();});
    $('bundleRows').addEventListener('click',function(e){
      var b=e.target.closest('[data-remove-bundle]');if(!b)return;
      syncTypeEditorV512();editingProduct.bundle.components.splice(Number(b.dataset.removeBundle),1);renderBundleRowsV512();
    });
  }
  ['pBundleExtraCost','pBundleExtraWeight'].forEach(function(id){ if($(id)) $(id).addEventListener('input',updateBundleSummaryV512); });
  if($('marketEditor')) $('marketEditor').addEventListener('click',function(e){
    var load=e.target.closest('[data-load-variant]'),save=e.target.closest('[data-save-variant]');
    if(load){e.stopPropagation();loadVariantToMarginV512(load.dataset.loadVariant,load.dataset.variantId);}
    else if(save){e.stopPropagation();saveVariantMarginV512(save.dataset.saveVariant,save.dataset.variantId);}
  });
})();