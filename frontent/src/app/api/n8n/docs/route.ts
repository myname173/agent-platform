import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDocs, createDoc, shareDoc, archiveDoc } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await getDocs();
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

  // actions that operate on an existing document
  const action = String(payload.action || '').toLowerCase();
  if (action === 'share' || action === 'archive') {
    const id = Number(payload.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ ok: false, error: { message: 'id is required' } }, { status: 400 });
    }
    try {
      const out = action === 'share' ? await shareDoc(id, payload.to ? String(payload.to) : undefined) : await archiveDoc(id);
      return NextResponse.json(out.body ?? { ok: false }, { status: out.status });
    } catch (error: any) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const kind = String(payload.kind || 'custom');
  const clean: Record<string, unknown> = { kind };
  if (payload.title !== undefined) clean.title = String(payload.title);
  if (payload.text !== undefined) clean.text = String(payload.text);

  try {
    const out = await createDoc(clean as any);
    return NextResponse.json(out.body ?? { ok: false }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
