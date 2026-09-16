import { Router } from 'express';
import {
  buildShopeeSearchUrl,
  getResearchProviderStatus,
  searchShopeeCompetitors
} from '../services/marketResearch.js';

const router = Router();

function fail(res, error, status = 400) {
  return res.status(status).json({
    error: true,
    message: error?.message || '경쟁상품 조사 중 오류가 발생했습니다.'
  });
}

router.get('/status', (_req, res) => {
  res.json({ markets: getResearchProviderStatus() });
});

router.get('/search-url', (req, res) => {
  try {
    const marketCode = String(req.query.market || '').toUpperCase();
    const keyword = String(req.query.keyword || '').trim();
    if (!marketCode || !keyword) {
      return res.status(400).json({ error: true, message: 'market과 keyword가 필요합니다.' });
    }
    res.json({ marketCode, keyword, url: buildShopeeSearchUrl(marketCode, keyword) });
  } catch (error) {
    fail(res, error, 400);
  }
});

router.post('/search', async (req, res) => {
  try {
    const result = await searchShopeeCompetitors({
      marketCode: req.body?.marketCode,
      keyword: req.body?.keyword,
      page: req.body?.page,
      limit: req.body?.limit,
      sortType: req.body?.sortType
    });
    res.json(result);
  } catch (error) {
    fail(res, error, 502);
  }
});

export default router;
