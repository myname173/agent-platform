import crypto from 'node:crypto';

/**
 * 文档免登录分享链接的签名（F5）。
 *
 * 设计取舍：这是平台里**唯一一条免鉴权读路径**，所以刻意做窄：
 *   - 只对单份文档生效（签名里绑定了 id，不能改 id 复用）
 *   - 带过期时间（默认 7 天），过期即失效，无需服务端存储
 *   - 密钥复用 CHAT_API_KEY，与 n8n 侧同一套算法（n8n 生成、前端校验）
 *
 * token 形态： `<exp 秒级 unix>.<hmac-sha256 hex>`，作为 ?t= 传入。
 */

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

const secret = () => process.env.CHAT_API_KEY || '';

const payloadOf = (id: number, exp: number) => `${id}.${exp}`;

const hmac = (id: number, exp: number) =>
  crypto.createHmac('sha256', secret()).update(payloadOf(id, exp)).digest('hex');

export function signDocToken(id: number, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${exp}.${hmac(id, exp)}`;
}

export function verifyDocToken(id: number, token: string | null | undefined): boolean {
  if (!secret() || !token) return false;

  const parts = String(token).split('.');
  if (parts.length !== 2) return false;

  const exp = Number(parts[0]);
  if (!Number.isFinite(exp)) return false;
  if (exp <= Math.floor(Date.now() / 1000)) return false;

  const provided = Buffer.from(parts[1], 'utf8');
  const expected = Buffer.from(hmac(id, exp), 'utf8');
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}

export const DOC_TOKEN_TTL_DAYS = DEFAULT_TTL_SECONDS / 86400;
