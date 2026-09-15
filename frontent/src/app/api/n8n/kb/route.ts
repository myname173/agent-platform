import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getKbDocs, kbAction } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
  } else {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  }

  try {
    const out = await kbAction(upstream);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
