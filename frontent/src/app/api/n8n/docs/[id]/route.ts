import { auth } from '@clerk/nextjs/server';
import { getDocHtml } from '@/lib/n8n-client';
import { verifyDocToken } from '@/lib/doc-token';

/**
 * 直接返回自包含 HTML —— 浏览器打开即可阅读、打印或另存为 PDF。
 * 这就是「能带走」的那份东西。
 *
 * 鉴权（F5）：
 *   - 带合法的 ?t=<exp>.<sig>  → 免登录放行（用于分享给别人）
 *   - 否则                      → 走 Clerk 登录校验（原有行为）
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const docId = Number(id);

  if (!Number.isFinite(docId) || docId <= 0) {
    return new Response('Bad request', { status: 400 });
  }

  const token = new URL(req.url).searchParams.get('t');
  const shared = verifyDocToken(docId, token);

  if (!shared) {
    // 分享签名无效时退回登录态校验。这里保持 401 —— 与"服务端之间出问题"的 502 不同，
    // 但光秃秃的 "Unauthorized" 说不清是链接坏了还是没登录，所以写明白。
    const { userId } = await auth();
    if (!userId) {
      return new Response('文档链接无效或已过期，且当前未登录', { status: 401 });
    }
  }

  try {
    const html = await getDocHtml(docId);
    if (!html) return new Response('Document not found', { status: 404 });
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': shared ? 'private, max-age=300' : 'no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      }
    });
  } catch (error: any) {
    return new Response(String(error?.message || error), { status: 500 });
  }
}
