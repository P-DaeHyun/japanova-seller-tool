import { Router } from 'express';
import {
  deleteCandidate,
  listCandidates,
  saveCandidate
} from '../services/candidates.js';
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

/* 경쟁상품 조사는 후보상품 저장 여부와 무관하게 사용할 수 있다. */
router.use('/research', researchRouter);

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
