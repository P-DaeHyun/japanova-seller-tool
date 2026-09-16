import { Router } from 'express';
import {
  deleteCandidate,
  listCandidates,
  saveCandidate
} from '../services/candidates.js';
import { query } from '../db.js';
import { getShopApi } from '../services/shopee.js';
import { getValidAccessToken } from '../services/sync.js';
import researchRouter from './research.js';

const router = Router();

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
 * 모두 읽기 전용이며 상품 생성/수정 mutation은 여기서 실행하지 않는다.
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
      mandatoryAttributes: attributeList.filter(x => x.mandatory || x.is_mandatory),
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
