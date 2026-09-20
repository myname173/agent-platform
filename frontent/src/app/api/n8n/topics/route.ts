import { NextResponse } from 'next/server';
import { topicWatch } from '@/lib/n8n-client';
import { requireUser, upstreamError } from '@/lib/api-guard';

/** 关键词列表 */
export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const out = await topicWatch('list');
    if (out.status >= 400) return upstreamError(out.status);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** action: add | remove | run —— run 会真的去检索，可能要几十秒 */
export async function POST(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    /* empty body */
  }

  const action = String(payload.action || '');
  if (!['add', 'remove', 'run'].includes(action)) {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }
  const keyword = payload.keyword ? String(payload.keyword).slice(0, 120) : undefined;
  if ((action === 'add' || action === 'remove') && !keyword) {
    return NextResponse.json({ error: 'keyword is required' }, { status: 400 });
  }

  try {
    const out = await topicWatch(action as 'add' | 'remove' | 'run', keyword);
    if (out.status >= 400) return upstreamError(out.status);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
