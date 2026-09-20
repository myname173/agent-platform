import { NextResponse } from 'next/server';
import { completeTodo } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function POST(request: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }
    const out = await completeTodo(id);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
