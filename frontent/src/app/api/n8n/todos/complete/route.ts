import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { completeTodo } from '@/lib/n8n-client';

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
