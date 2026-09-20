import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

/**
 * 控制台 API 路由的两个共用护栏。
 *
 * 1) 登录守卫：以前每个路由都手写 `return NextResponse.json({ error: 'Unauthorized' })`。
 *    用户看到 "Unauthorized" 时分不清是"我登录过期了"还是"平台和 n8n 之间坏了"，
 *    而这两种的修法完全不同。现在统一给出可操作的一句话。
 *
 * 2) 上游错误映射：n8n 的 401 响应体是空的。如果原样透传，前端只剩一个状态码，
 *    同样分不清是谁拒的。这里把它重新标注成 502（明确表示是服务端之间的问题，
 *    不是用户的会话问题）。
 */

/** 没有会话时返回现成的 401 响应；否则 denied 为 null。 */
export async function requireUser(): Promise<{ userId: string | null; denied: NextResponse | null }> {
  const { userId } = await auth();
  if (!userId) {
    return {
      userId: null,
      denied: NextResponse.json({ error: '登录状态已失效，请重新登录后再试' }, { status: 401 })
    };
  }
  return { userId, denied: null };
}

/**
 * 把上游的非 2xx 转成面向浏览器的响应。
 * 401/403 → 502，并说明是控制台与 n8n 之间的问题（不要误报成用户未登录）。
 */
export function upstreamError(status: number): NextResponse {
  if (status === 401 || status === 403) {
    return NextResponse.json(
      { error: 'n8n 拒绝了控制台的请求（CHAT_API_KEY 无效或已变更）' },
      { status: 502 }
    );
  }
  return NextResponse.json({ error: `上游返回 ${status}` }, { status: 502 });
}
