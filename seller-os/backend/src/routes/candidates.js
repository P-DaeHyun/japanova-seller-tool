import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import {
  deleteCandidate,
  listCandidates,
  saveCandidate
} from '../services/candidates.js';
import { query, withTransaction } from '../db.js';
import { getShopApi, postShopApi, uploadShopImage } from '../services/shopee.js';
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

function candidateFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    plans: row.plans && typeof row.plans === 'object' ? row.plans : {},
    updatedAt: row.updated_at
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
  if (draft?.publishReceipt?.itemId) blockers.push(`이미 Shopee item_id ${draft.publishReceipt.itemId}로 등록된 초안이야.`);
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

function publishEnabled() {
  return String(process.env.SHOPEE_ENV || '').toLowerCase() === 'production'
    && String(process.env.SHOPEE_PUBLISH_ENABLED || '').toLowerCase() === 'true';
}

function buildAddItemPayload(draft) {
  const dimensions = Number(draft.lengthCm) > 0 && Number(draft.widthCm) > 0 && Number(draft.heightCm) > 0
    ? {
        package_length: Math.round(Number(draft.lengthCm)),
        package_width: Math.round(Number(draft.widthCm)),
        package_height: Math.round(Number(draft.heightCm))
      }
    : null;
  return {
    item_name: String(draft.title || '').trim(),
    description: String(draft.description || '').trim(),
    item_sku: String(draft.sku || '').trim(),
    category_id: Number(draft.categoryId),
    original_price: Number(draft.priceLocal),
    weight: Number(draft.weightG) / 1000,
    ...(dimensions ? { dimension: dimensions } : {}),
    condition: draft.condition || 'NEW',
    image: { image_id_list: arr(draft.imageIds) },
    logistic_info: arr(draft.logistics)
      .map(id => ({ logistic_id: Number(id), enabled: true }))
      .filter(x => x.logistic_id > 0),
    attribute_list: arr(draft.attributes),
    seller_stock: [{ stock: Math.max(0, Math.floor(Number(draft.initialStock) || 0)) }],
    item_status: 'UNLIST'
  };
}

function responseItemId(data) {
  const root = data?.response || data || {};
  const id = Number(root.item_id || data?.item_id || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function attemptSummary(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    candidateId: row.candidate_id,
    marketCode: row.market_code,
    shopId: Number(row.shop_id),
    requestHash: row.request_hash,
    status: row.status,
    itemId: row.item_id ? Number(row.item_id) : null,
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at
  };
}

async function latestAttempt(candidateId, marketCode) {
  const result = await query(
    `select * from listing_publish_attempts where candidate_id=$1 and market_code=$2 limit 1`,
    [String(candidateId), String(marketCode).toUpperCase()]
  );
  return attemptSummary(result.rows[0]);
}

async function inspectListing(candidate, marketCode) {
  const plan = candidate.plans?.[marketCode] || {};
  const draft = plan.listingDraft || {};
  const blockers = basicDraftBlockers(candidate, marketCode, draft, plan);
  const warnings = [];
  let shop = null;
  let mandatoryIds = [];
  let availableLogisticIds = [];
  let tokenRefreshed = false;
  let accessToken = null;

  if (draft.selectedShopId) {
    shop = await connectedShop(positiveId(draft.selectedShopId, 'selectedShopId'));
    if (String(shop.market_code || '').toUpperCase() !== marketCode) {
      blockers.push(`선택한 Shop의 시장(${shop.market_code})과 초안 시장(${marketCode})이 달라.`);
    }
    const auth = await getValidAccessToken(shop.shop_id);
    tokenRefreshed = auth.refreshed;
    accessToken = auth.accessToken;

    if (Number(draft.categoryId) > 0) {
      const attrData = await getShopApi('/api/v2/product/get_attribute_tree', {
        shopId: shop.shop_id,
        accessToken,
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
      accessToken
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

  return {
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    plan,
    draft,
    shop,
    tokenRefreshed,
    accessToken,
    metadata: { mandatoryAttributeIds: mandatoryIds, availableLogisticIds }
  };
}

router.use('/research', researchRouter);

router.get('/listing/status', async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await query(
      `select market_code, shop_id, shop_name, status, last_sync_at
       from shopee_connections
       where status='CONNECTED'
       order by market_code nulls last, shop_id`
    );
    const environment = process.env.SHOPEE_ENV || 'sandbox';
    res.json({
      environment,
      publishMutationEnabled: publishEnabled(),
      mediaUploadEnabled: true,
      publishSafety: {
        productionRequired: true,
        serverSwitch: String(process.env.SHOPEE_PUBLISH_ENABLED || '').toLowerCase() === 'true',
        explicitConfirmationRequired: true,
        createItemStatus: 'UNLIST',
        duplicateProtection: 'durable_attempt_ledger'
      },
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
    res.json({ shop, tokenRefreshed: auth.refreshed, categoryList: data.category_list || data.response?.category_list || [], raw: data.response || data });
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
      params: { category_id: categoryId, language: String(req.query.language || 'en').slice(0, 20) }
    });
    const attributeList = data.attribute_list || data.response?.attribute_list || [];
    res.json({ shop, categoryId, tokenRefreshed: auth.refreshed, attributeList, mandatoryAttributes: attributeList.filter(isMandatoryAttribute), raw: data.response || data });
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
    const data = await getShopApi('/api/v2/logistics/get_channel_list', { shopId, accessToken: auth.accessToken });
    res.json({ shop, tokenRefreshed: auth.refreshed, logisticsChannels: data.logistics_channel_list || data.response?.logistics_channel_list || [], raw: data.response || data });
  } catch (error) {
    fail(res, error, 502);
  }
});

router.post('/listing/upload-image', (req, res, next) => {
  imageUpload.single('image')(req, res, error => {
    if (error) return fail(res, error, 400);
    next();
  });
}, async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (String(req.body?.confirm || '') !== 'UPLOAD_IMAGE') return fail(res, new Error('이미지 업로드 확인값이 필요합니다.'), 400);
    const shopId = positiveId(req.body?.shopId, 'shopId');
    const shop = await connectedShop(shopId);
    if (!req.file?.buffer?.length) throw new Error('업로드할 이미지 파일을 선택해줘.');
    const auth = await getValidAccessToken(shopId);
    const data = await uploadShopImage({ shopId, accessToken: auth.accessToken, bytes: req.file.buffer, filename: req.file.originalname, contentType: req.file.mimetype });
    const image = imageResult(data);
    if (!image.imageId) throw new Error('Shopee 이미지 업로드 응답에서 image_id를 찾지 못했습니다.');
    res.json({ message: 'Shopee Media 이미지 업로드가 완료됐어.', shop, tokenRefreshed: auth.refreshed, imageId: image.imageId, imageUrl: image.imageUrl, fileName: req.file.originalname, size: req.file.size });
  } catch (error) {
    fail(res, error, 502);
  }
});

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
    const inspection = await inspectListing(candidate, marketCode);
    const attempt = await latestAttempt(candidateId, marketCode);
    res.json({
      checkedAt: new Date().toISOString(),
      ready: inspection.ready,
      mutationLocked: !publishEnabled(),
      endpointPreview: '/api/v2/product/add_item',
      candidateId,
      marketCode,
      shop: inspection.shop ? { marketCode: inspection.shop.market_code, shopId: Number(inspection.shop.shop_id), shopName: inspection.shop.shop_name } : null,
      tokenRefreshed: inspection.tokenRefreshed,
      blockers: inspection.blockers,
      warnings: inspection.warnings,
      metadata: inspection.metadata,
      publishAttempt: attempt
    });
  } catch (error) {
    fail(res, error, 502);
  }
});

router.post('/listing/publish', async (req, res) => {
  if (!requireDb(res)) return;
  const candidateId = String(req.body?.candidateId || '').trim();
  const marketCode = String(req.body?.marketCode || '').trim().toUpperCase();
  try {
    if (!candidateId) throw new Error('candidateId가 필요합니다.');
    if (!marketCode) throw new Error('marketCode가 필요합니다.');
    if (String(req.body?.confirm || '') !== 'PUBLISH') throw new Error('실제 등록 확인값 PUBLISH가 필요합니다.');
    if (String(req.body?.confirmText || '') !== `PUBLISH ${marketCode}`) throw new Error(`최종 확인란에 PUBLISH ${marketCode}를 정확히 입력해야 합니다.`);
    if (String(process.env.SHOPEE_ENV || '').toLowerCase() !== 'production') return fail(res, new Error('Sandbox에서는 실제 상품 등록을 실행할 수 없습니다.'), 403);
    if (!publishEnabled()) return fail(res, new Error('서버 실제등록 안전스위치가 꺼져 있습니다.'), 403);

    const prepared = await withTransaction(async client => {
      const locked = await client.query(`select * from candidate_products where id=$1 for update`, [candidateId]);
      if (!locked.rows[0]) throw Object.assign(new Error('후보상품을 찾을 수 없습니다.'), { httpStatus: 404 });
      const candidate = candidateFromRow(locked.rows[0]);
      const existing = await client.query(`select * from listing_publish_attempts where candidate_id=$1 and market_code=$2 for update`, [candidateId, marketCode]);
      if (existing.rows[0]) {
        const a = attemptSummary(existing.rows[0]);
        const msg = a.status === 'SUCCEEDED'
          ? `이미 Shopee item_id ${a.itemId}로 등록 완료된 시장이야.`
          : `이 시장에 ${a.status} 등록 시도 기록이 있어 자동 재등록을 차단했어. 원장 확인이 필요해.`;
        throw Object.assign(new Error(msg), { httpStatus: 409 });
      }
      const inspection = await inspectListing(candidate, marketCode);
      if (!inspection.ready) {
        throw Object.assign(new Error(`서버 최종검사를 통과하지 못했어: ${inspection.blockers.join(' / ')}`), { httpStatus: 409 });
      }
      const payload = buildAddItemPayload(inspection.draft);
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const attempt = await client.query(
        `insert into listing_publish_attempts(candidate_id,market_code,shop_id,request_hash,status)
         values($1,$2,$3,$4,'PENDING') returning *`,
        [candidateId, marketCode, Number(inspection.shop.shop_id), requestHash]
      );
      return { inspection, payload, requestHash, attempt: attemptSummary(attempt.rows[0]) };
    });

    let shopeeData;
    try {
      shopeeData = await postShopApi('/api/v2/product/add_item', {
        shopId: Number(prepared.inspection.shop.shop_id),
        accessToken: prepared.inspection.accessToken,
        body: prepared.payload
      });
    } catch (error) {
      await query(
        `update listing_publish_attempts set status='REVIEW', error_message=$2, updated_at=now(), finished_at=now() where id=$1`,
        [prepared.attempt.id, String(error?.message || 'Shopee add_item 호출 실패').slice(0, 4000)]
      ).catch(() => {});
      return fail(res, new Error('Shopee 등록 요청 결과를 안전하게 확정할 수 없어 REVIEW로 잠갔어. 자동 재시도하지 말고 원장을 확인해야 해.'), 502);
    }

    const itemId = responseItemId(shopeeData);
    if (!itemId) {
      await query(
        `update listing_publish_attempts set status='REVIEW', response_json=$2::jsonb, error_message='item_id missing', updated_at=now(), finished_at=now() where id=$1`,
        [prepared.attempt.id, JSON.stringify(shopeeData)]
      ).catch(() => {});
      return fail(res, new Error('Shopee 응답에서 item_id를 확인하지 못해서 REVIEW 상태로 잠갔어.'), 502);
    }

    const receipt = {
      status: 'SUCCEEDED',
      itemId,
      marketCode,
      shopId: Number(prepared.inspection.shop.shop_id),
      shopName: prepared.inspection.shop.shop_name,
      itemStatus: 'UNLIST',
      requestHash: prepared.requestHash,
      attemptId: prepared.attempt.id,
      publishedAt: new Date().toISOString()
    };

    await withTransaction(async client => {
      const locked = await client.query(`select plans from candidate_products where id=$1 for update`, [candidateId]);
      if (!locked.rows[0]) throw new Error('등록 성공 후 후보상품 저장 중 원본을 찾지 못했습니다.');
      const plans = locked.rows[0].plans && typeof locked.rows[0].plans === 'object' ? locked.rows[0].plans : {};
      plans[marketCode] = plans[marketCode] || {};
      plans[marketCode].listingDraft = plans[marketCode].listingDraft || {};
      plans[marketCode].listingDraft.publishReceipt = receipt;
      plans[marketCode].listingDraft.preflight = null;
      plans[marketCode].listingDraft.updatedAt = new Date().toISOString();
      await client.query(`update candidate_products set plans=$2::jsonb, updated_at=now() where id=$1`, [candidateId, JSON.stringify(plans)]);
      await client.query(
        `update listing_publish_attempts set status='SUCCEEDED', item_id=$2, response_json=$3::jsonb, updated_at=now(), finished_at=now() where id=$1`,
        [prepared.attempt.id, itemId, JSON.stringify(shopeeData)]
      );
    });

    res.json({
      message: `Shopee 미게시(UNLIST) 상품을 생성했어. item_id=${itemId}`,
      receipt,
      mutation: { endpoint: '/api/v2/product/add_item', itemStatus: 'UNLIST' }
    });
  } catch (error) {
    fail(res, error, error?.httpStatus || 400);
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
    if (!deleted) return res.status(404).json({ error: true, message: '후보상품을 찾을 수 없습니다.' });
    res.json({ message: '후보상품을 삭제했습니다.', id: String(req.params.id) });
  } catch (error) {
    fail(res, error, 500);
  }
});

export default router;
