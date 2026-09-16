import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

if (!process.env.DATABASE_URL) {
  console.log('DATABASE_URL이 없어 DB 마이그레이션을 건너뜁니다.');
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPaths = [
  path.resolve(here, '../../db/schema.sql'),
  path.resolve(here, '../../db/candidates.sql')
];

try {
  for (const schemaPath of schemaPaths) {
    const sql = await fs.readFile(schemaPath, 'utf8');
    await pool.query(sql);
  }
  console.log('JAPANOVA DB 스키마 적용 완료');
} catch (error) {
  console.error('JAPANOVA DB 스키마 적용 실패:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
