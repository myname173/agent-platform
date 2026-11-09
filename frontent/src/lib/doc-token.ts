import crypto from 'node:crypto';

/**
 * 文档免登录分享链接的校验（F5）。
 *
 * 设计取舍：这是平台里**唯一一条免鉴权读路径**，所以刻意做窄：
 *   - 只对单份文档生效（签名里绑定了 id，不能改 id 复用）
 *   - 带过期时间，过期即失效，无需服务端存储
 *   - 密钥复用 CHAT_API_KEY，与 n8n 侧同一套算法
 *
 * 签名不在这里生成：n8n 的 doc-forge（`Run Doc Forge` 节点）用同一算法签出
 * `?t=`，TTL 由它的 DOC_TTL_SECONDS 决定。控制台「复制链接」→
 * `/api/n8n/docs` 的 `action:'sign'` → doc-forge，前端只负责校验。
 *
 * token 形态： `<exp 秒级 unix>.<hmac-sha256 hex>`，作为 ?t= 传入。
 */

const secret = () => process.env.CHAT_API_KEY || '';

const payloadOf = (id: number, exp: number) => `${id}.${exp}`;

const hmac = (id: number, exp: number) =>
  crypto.createHmac('sha256', secret()).update(payloadOf(id, exp)).digest('hex');

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
