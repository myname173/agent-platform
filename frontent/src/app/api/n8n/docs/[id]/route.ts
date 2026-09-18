import { auth } from '@clerk/nextjs/server';
import { getDocHtml } from '@/lib/n8n-client';

/**
 * 直接返回自包含 HTML —— 浏览器打开即可阅读、打印或另存为 PDF。
 * 这就是「能带走」的那份东西。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();

  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id } = await ctx.params;
  const docId = Number(id);

  if (!Number.isFinite(docId) || docId <= 0) {
    return new Response('Bad request', { status: 400 });
  }

  try {
    const html = await getDocHtml(docId);
    if (!html) return new Response('Document not found', { status: 404 });
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  } catch (error: any) {
    return new Response(String(error?.message || error), { status: 500 });
  }
}
