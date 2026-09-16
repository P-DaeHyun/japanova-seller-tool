import { Router } from 'express';
import multer from 'multer';
import {
  deleteCandidate,
  listCandidates,
  saveCandidate
} from '../services/candidates.js';
import { query } from '../db.js';
import { getShopApi, uploadShopImage } from '../services/shopee.js';
import { getValidAccessToken } from '../services/sync.js';
import researchRouter from './research.js';

const router = Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png']);
    if (!allowed.has(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Shopee 등록 이미지는 JPG/JPEG/PNG 파일만 업로드해줘.'));
    }
    cb(null, true);
  }
});

function requireDb(res) {
  if (process.env.DATABASE_URL) return true;
  res.status(503).json({ error: true, message: 'DATABASE_URL 설정이 필요합니다.' });
  return false;
}

function fail(res, error, status = 400) {
  return res.status(status).json({
    error: true,
    message: error?.message || '후보상품 처리 중 오류가 발생했습니다.'
  });
}

function positiveId(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label}가 필요합니다.`);
  return n;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function attrId(value) {
  return String(value?.attribute_id ?? value?.attributeId ?? '');
}

function isMandatoryAttribute(value) {
  return Boolean(value?.mandatory ?? value?.is_mandatory ?? value?.isMandatory);
}

function logisticId(value) {
  return Number(
    value?.logistic_id ??
    value?.logistics_channel_id ??
    value?.channel_id ??
    value?.logistic_channel_id ??
    0
  );
}

function imageResult(data) {
  const root = data?.response || data || {};
  const one = root.image_info || root.image || arr(root.image_list)[0] || arr(root.image_info_list)[0] || root;
  return {
    imageId: one?.image_id || root?.image_id || null,
    imageUrl: one?.image_url || root?.image_url || null
  };
}

function basicDraftBlockers(candidate, marketCode, draft, plan) {
  const blockers = [];
  if (candidate.status !== 'READY') blockers.push('후보상품이 등록 후보(READY)가 아니야.');
  if ((plan.regulationStatus || 'UNCHECKED') !== 'OK') blockers.push('해당 국가 규제 상태가 판매가능(OK)이 아니야.');
  if ((plan.decision || 'AUTO') !== 'SELL') blockers.push('검증센터에서 이 국가를 판매대상(SELL)으로 확정하지 않았어.');
  if (!draft?.enabled) blockers.push('등록 준비 스위치가 꺼져 있어.');
  if (!String(draft?.title || '').trim()) blockers.push('상품명이 비어 있어.');
  if (String(draft?.title || '').trim().length > 120) blockers.push('상품명이 120자를 넘었어.');
  if (!String(draft?.description || '').trim()) blockers.push('상세설명이 비어 있어.');
  if (!String(draft?.sku || '').trim()) blockers.push('SKU가 비어 있어.');
  if (!(Number(draft?.priceLocal) > 0)) blockers.push('판매가가 확정되지 않았어.');
  if (!(Number(draft?.weightG) > 0)) blockers.push('포장 후 중량이 필요해.');
  if (!(Number(draft?.categoryId) > 0)) blockers.push('Shopee 카테고리가 선택되지 않았어.');
  if (!(Number(draft?.initialStock) > 0)) blockers.push('등록 재고가 1개 이상이어야 해.');
  if (!arr(draft?.imageIds).length) blockers.push('Shopee image_id가 하나 이상 필요해.');
  if (arr(draft?.imageIds).length > 9) blockers.push('상품 이미지는 최대 9개까지만 준비해.');
  if (!arr(draft?.logistics).length) blockers.push('사용할 물류 채널을 하나 이상 선택해야 해.');
  if (!draft?.selectedShopId) blockers.push('등록 대상 Shopee Shop이 선택되지 않았어.');
  return blockers;
}

async function connectedShop(shopId) {
  const result = await query(
    `select market_code, shop_id, shop_name, status, last_sync_at
     from shopee_connections
     where shop_id=$1 and status='CONNECTED'`,
    [Number(shopId)]
  );
  if (!result.rows[0]) throw new Error('연결된 Shopee Shop을 찾을 수 없습니다.');
  return result.rows[0];
}

/* 경쟁상품 조사는 후보상품 저장 여부와 무관하게 사용할 수 있다. */
router.use('/research', researchRouter);

/*
 * 등록 준비용 Shopee 메타데이터 API.
 * 상품 생성/수정 mutation은 여기서 실행하지 않는다.
 */
router.get('/listing/status', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await query(
      `select market_code, shop_id, shop_name, status, last_sync_at
       from shopee_connections
       where status='CONNECTED'
       order by market_code nulls last, shop_id`
    );
    res.json({
      environment: process.env.SHOPEE_ENV || 'sandbox',
      publishMutationEnabled: false,
      mediaUploadEnabled: true,
      connections: result.rows.map(row => ({
        marketCode: row.market_code,
        shopId: Number(row.shop_id),
        shopName: row.shop_name,
        status: row.status,
        lastSyncAt: row.last_sync_at
      }))
    });
  } catch (error) {
    fail(res, error, 500);
  }
});

router.get('/listing/categories', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const shopId = positiveId(req.query.shopId, 'shopId');
    const shop = await connectedShop(shopId);
    const auth = await getValidAccessToken(shopId);
    const data = await getShopApi('/api/v2/product/get_category', {
      shopId,
      accessToken: auth.accessToken,
      params: {
        language: String(req.query.language || 'en').slice(0, 20),
        ...(req.query.parentCategoryId
          ? { parent_category_id: positiveId(req.query.parentCategoryId, 'parentCategoryId') }
          : {})
      }
    });
    res.json({
      shop,
      tokenRefreshed: auth.refreshed,
      categoryList: data.category_list || data.response?.category_list || [],
      raw: data.response || data
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

router.get('/listing/attributes', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const shopId = positiveId(req.query.shopId, 'shopId');
    const categoryId = positiveId(req.query.categoryId, 'categoryId');
    const shop = await connectedShop(shopId);
    const auth = await getValidAccessToken(shopId);
    const data = await getShopApi('/api/v2/product/get_attribute_tree', {
      shopId,
      accessToken: auth.accessToken,
      params: {
        category_id: categoryId,
        language: String(req.query.language || 'en').slice(0, 20)
      }
    });
    const attributeList = data.attribute_list || data.response?.attribute_list || [];
    res.json({
      shop,
      categoryId,
      tokenRefreshed: auth.refreshed,
      attributeList,
      mandatoryAttributes: attributeList.filter(isMandatoryAttribute),
      raw: data.response || data
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

router.get('/listing/logistics', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const shopId = positiveId(req.query.shopId, 'shopId');
    const shop = await connectedShop(shopId);
    const auth = await getValidAccessToken(shopId);
    const data = await getShopApi('/api/v2/logistics/get_channel_list', {
      shopId,
      accessToken: auth.accessToken
    });
    res.json({
      shop,
      tokenRefreshed: auth.refreshed,
      logisticsChannels: data.logistics_channel_list || data.response?.logistics_channel_list || [],
      raw: data.response || data
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

/*
 * 이미지 업로드는 실제 Shopee Media 영역을 변경하지만 상품을 생성하지 않는다.
 * 파일 선택 + UPLOAD_IMAGE 확인값이 있는 명시적 요청에서만 실행한다.
 */
router.post('/listing/upload-image', (req, res, next) => {
  imageUpload.single('image')(req, res, error => {
    if (error) return fail(res, error, 400);
    next();
  });
}, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (String(req.body?.confirm || '') !== 'UPLOAD_IMAGE') {
      return fail(res, new Error('이미지 업로드 확인값이 필요합니다.'), 400);
    }
    const shopId = positiveId(req.body?.shopId, 'shopId');
    const shop = await connectedShop(shopId);
    if (!req.file?.buffer?.length) throw new Error('업로드할 이미지 파일을 선택해줘.');
    const auth = await getValidAccessToken(shopId);
    const data = await uploadShopImage({
      shopId,
      accessToken: auth.accessToken,
      bytes: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    const image = imageResult(data);
    if (!image.imageId) throw new Error('Shopee 이미지 업로드 응답에서 image_id를 찾지 못했습니다.');
    res.json({
      message: 'Shopee Media 이미지 업로드가 완료됐어.',
      shop,
      tokenRefreshed: auth.refreshed,
      imageId: image.imageId,
      imageUrl: image.imageUrl,
      fileName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

/*
 * 최종검사: DB에 저장된 초안과 Shopee의 현재 카테고리 속성/물류채널을 서버에서 다시 대조한다.
 * 읽기 전용이며 add_item은 절대 호출하지 않는다.
 */
router.post('/listing/preflight', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const candidateId = String(req.body?.candidateId || '').trim();
    const marketCode = String(req.body?.marketCode || '').trim().toUpperCase();
    if (!candidateId) throw new Error('candidateId가 필요합니다.');
    if (!marketCode) throw new Error('marketCode가 필요합니다.');

    const candidates = await listCandidates();
    const candidate = candidates.find(x => String(x.id) === candidateId);
    if (!candidate) return fail(res, new Error('후보상품을 찾을 수 없습니다.'), 404);

    const plan = candidate.plans?.[marketCode] || {};
    const draft = plan.listingDraft || {};
    const blockers = basicDraftBlockers(candidate, marketCode, draft, plan);
    const warnings = [];

    let shop = null;
    let mandatoryIds = [];
    let availableLogisticIds = [];
    let tokenRefreshed = false;

    if (draft.selectedShopId) {
      shop = await connectedShop(positiveId(draft.selectedShopId, 'selectedShopId'));
      if (String(shop.market_code || '').toUpperCase() !== marketCode) {
        blockers.push(`선택한 Shop의 시장(${shop.market_code})과 초안 시장(${marketCode})이 달라.`);
      }

      const auth = await getValidAccessToken(shop.shop_id);
      tokenRefreshed = auth.refreshed;

      if (Number(draft.categoryId) > 0) {
        const attrData = await getShopApi('/api/v2/product/get_attribute_tree', {
          shopId: shop.shop_id,
          accessToken: auth.accessToken,
          params: { category_id: Number(draft.categoryId), language: 'en' }
        });
        const attributeList = attrData.attribute_list || attrData.response?.attribute_list || [];
        mandatoryIds = attributeList.filter(isMandatoryAttribute).map(attrId).filter(Boolean);
        const presentIds = new Set(arr(draft.attributes).map(attrId).filter(Boolean));
        const missing = mandatoryIds.filter(id => !presentIds.has(String(id)));
        if (missing.length) blockers.push(`Shopee 현재 카테고리 기준 필수속성 ${missing.length}개가 미입력이야.`);
      }

      const logisticData = await getShopApi('/api/v2/logistics/get_channel_list', {
        shopId: shop.shop_id,
        accessToken: auth.accessToken
      });
      const channels = logisticData.logistics_channel_list || logisticData.response?.logistics_channel_list || [];
      availableLogisticIds = channels.map(logisticId).filter(id => id > 0);
      const chosen = arr(draft.logistics).map(Number).filter(id => id > 0);
      const invalid = chosen.filter(id => !availableLogisticIds.includes(id));
      if (invalid.length) blockers.push(`현재 Shop에서 사용할 수 없는 물류채널 ${invalid.join(', ')}이 선택돼 있어.`);
    }

    if (!(Number(draft.lengthCm) > 0 && Number(draft.widthCm) > 0 && Number(draft.heightCm) > 0)) {
      warnings.push('포장 가로·세로·높이가 모두 입력되진 않았어. 카테고리/물류 정책상 필요할 수 있어.');
    }
    if (!String(draft.brandName || '').trim()) warnings.push('브랜드가 비어 있어. 카테고리에 따라 필수일 수 있어.');
    if (!String(draft.gtin || '').trim()) warnings.push('GTIN/EAN/JAN이 비어 있어. 카테고리에 따라 요구될 수 있어.');

    res.json({
      checkedAt: new Date().toISOString(),
      ready: blockers.length === 0,
      mutationLocked: true,
      endpointPreview: '/api/v2/product/add_item',
      candidateId,
      marketCode,
      shop: shop ? {
        marketCode: shop.market_code,
        shopId: Number(shop.shop_id),
        shopName: shop.shop_name
      } : null,
      tokenRefreshed,
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
      metadata: {
        mandatoryAttributeIds: mandatoryIds,
        availableLogisticIds
      }
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

router.get('/', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ candidates: await listCandidates() });
  } catch (error) {
    fail(res, error, 500);
  }
});

router.put('/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const candidate = await saveCandidate(req.params.id, req.body || {});
    res.json({ message: '후보상품을 저장했습니다.', candidate });
  } catch (error) {
    fail(res, error, 400);
  }
});

router.delete('/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await deleteCandidate(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: true, message: '후보상품을 찾을 수 없습니다.' });
    }
    res.json({ message: '후보상품을 삭제했습니다.', id: String(req.params.id) });
  } catch (error) {
    fail(res, error, 500);
  }
});

export default router;
