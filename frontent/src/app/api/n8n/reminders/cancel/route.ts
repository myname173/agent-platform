import { NextResponse } from 'next/server';
import { cancelReminder } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function POST(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  let id = 0;
  try {
    const body = await req.json();
    id = Number(body?.id) || 0;
  } catch {
    /* empty body */
  }

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    const out = await cancelReminder(id);
    return NextResponse.json(out.body ?? { ok: false }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
