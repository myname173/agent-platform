import { NextResponse } from 'next/server';
import { getTodos } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  const owner = new URL(req.url).searchParams.get('owner') || undefined;

  try {
    const out = await getTodos(owner);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
