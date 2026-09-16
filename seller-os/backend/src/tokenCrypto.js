import crypto from 'node:crypto';

function key() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY는 32자 이상이어야 합니다.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [iv64, tag64, encrypted64] = String(payload).split('.');
  if (!iv64 || !tag64 || !encrypted64) throw new Error('암호화 토큰 형식이 올바르지 않습니다.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(iv64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted64, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}
