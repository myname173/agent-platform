import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getKbDocs, kbAction } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: '登录状态已失效，请重新登录后再试' }, { status: 401 });
  }

  try {
    const data = await getKbDocs();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    // Say what is actually wrong. A bare "Unauthorized" leaves the user guessing
    // between "my session expired" and "the platform can't talk to n8n".
    return NextResponse.json({ error: '登录状态已失效，请重新登录后再试' }, { status: 401 });
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    /* empty body */
  }

  const action = String(payload.action || '');
  let upstream: Record<string, unknown> = {};
  if (action === 'ingest') {
    upstream = {
      mode: 'ingest',
      title: String(payload.title || ''),
      text: String(payload.text || ''),
      source_type: 'text'
    };
  } else if (action === 'retire') {
    upstream = { mode: 'retire', doc_id: String(payload.doc_id || '') };
  } else if (action === 'search') {
    upstream = {
      mode: 'search',
      query: String(payload.query || ''),
      top_k: payload.top_k !== undefined ? Number(payload.top_k) : 6,
    };
  } else {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  try {
    const out = await kbAction(upstream);
    // n8n answers 401 with an empty body, so the reason has to be added here or
    // the user just sees a bare status code.
    if (out.status === 401) {
      return NextResponse.json({ error: 'n8n 拒绝了控制台的请求（CHAT_API_KEY 无效或已变更）' }, { status: 502 });
    }
    if (out.status >= 400) {
      return NextResponse.json({ error: `上游返回 ${out.status}` }, { status: 502 });
    }
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
