(function(global){
  'use strict';

  function clampNumber(v,min=0){
    const n=Number(v);
    return Number.isFinite(n)?Math.max(min,n):min;
  }

  function slsLocal(market, weightG, dims={}){
    const sls=market?.sls;
    if(!sls) throw new Error('이 시장의 SLS 요금 데이터가 아직 없습니다.');
    let g=clampNumber(weightG,1);

    if(sls.volumetric){
      const L=clampNumber(dims.lengthCm), W=clampNumber(dims.widthCm), H=clampNumber(dims.heightCm);
      if(L>0&&W>0&&H>0){
        const volumetricG=(L*W*H/sls.volumetric)*1000;
        g=Math.max(g,volumetricG);
      }
    }

    if(sls.maxG && g>sls.maxG) throw new Error(`최대 허용중량 ${sls.maxG.toLocaleString()}g 초과`);

    if(sls.kind==='step50'){
      return Number(sls.base||0)+Number(sls.step||0)*Math.ceil(g/50);
    }
    if(sls.kind==='sg20260601'){
      if(g<=500){
        const steps=Math.max(1,Math.ceil(g/100));
        return 2.63+0.23*(steps-1);
      }
      return 3.55+2.50*Math.ceil((g-500)/250);
    }
    if(sls.kind==='vn20260601'){
      if(g<=800){
        const step=Math.max(1,Math.ceil(g/50));
        return 5500+11500*(step-1);
      }
      if(g<=850) return 188500;
      return 188500+10500*Math.ceil((g-850)/50);
    }
    throw new Error(`지원하지 않는 SLS 계산방식: ${sls.kind||'없음'}`);
  }

  function feeLocal(market, listedLocal, effectiveLocal){
    return (market.feeItems||[]).reduce((sum,item)=>{
      const base=item.base==='effective'?effectiveLocal:listedLocal;
      return sum+base*Number(item.rate||0);
    },0);
  }

  function evaluate({market,baseFx,buffer,listedLocal,discount,payoneer,purchaseCostJpy,packagingCostJpy,domesticShippingJpy,otherCostJpy,weightG,dims}){
    const effectiveLocal=listedLocal*(1-discount);
    const priceFx=baseFx*(1-buffer);
    const revenueJpy=effectiveLocal*priceFx;
    const feeL=feeLocal(market,listedLocal,effectiveLocal);
    const feeJpy=feeL*baseFx;
    const shippingLocal=slsLocal(market,weightG,dims);
    const shippingJpy=shippingLocal*baseFx;
    const payoneerJpy=effectiveLocal*baseFx*payoneer;
    const localCostJpy=purchaseCostJpy+packagingCostJpy+domesticShippingJpy+otherCostJpy;
    const profitJpy=revenueJpy-feeJpy-shippingJpy-payoneerJpy-localCostJpy;
    const margin=revenueJpy>0?profitJpy/revenueJpy:0;
    return {listedLocal,effectiveLocal,baseFx,priceFx,revenueJpy,feeLocal:feeL,feeJpy,shippingLocal,shippingJpy,payoneerJpy,localCostJpy,profitJpy,margin};
  }

  function solveTarget(input){
    const target=Number(input.targetMargin||0);
    if(!(input.baseFx>0)) throw new Error('환율 정보가 없습니다.');
    if(!input.market) throw new Error('시장 데이터를 찾을 수 없습니다.');

    const normalized={
      ...input,
      buffer:clampNumber(input.buffer),
      discount:Math.min(0.95,clampNumber(input.discount)),
      payoneer:Math.min(0.5,clampNumber(input.payoneer)),
      purchaseCostJpy:clampNumber(input.purchaseCostJpy),
      packagingCostJpy:clampNumber(input.packagingCostJpy),
      domesticShippingJpy:clampNumber(input.domesticShippingJpy),
      otherCostJpy:clampNumber(input.otherCostJpy),
      weightG:clampNumber(input.weightG,1)
    };

    let low=0.01, high=10;
    let hi=evaluate({...normalized,listedLocal:high});
    let guard=0;
    while(hi.margin<target && guard<40){
      high*=2;
      hi=evaluate({...normalized,listedLocal:high});
      guard++;
    }
    if(guard>=40) throw new Error('목표 마진을 만족하는 판매가를 찾지 못했습니다.');

    for(let i=0;i<80;i++){
      const mid=(low+high)/2;
      const r=evaluate({...normalized,listedLocal:mid});
      if(r.margin>=target) high=mid; else low=mid;
    }

    return evaluate({...normalized,listedLocal:high});
  }

  function domesticAllocation(fare,outerBox,orderCount){
    const n=Math.max(1,Math.floor(clampNumber(orderCount,1)));
    return (clampNumber(fare)+clampNumber(outerBox))/n;
  }

  global.JAPANOVA_MARGIN={slsLocal,feeLocal,evaluate,solveTarget,domesticAllocation};
})(window);
