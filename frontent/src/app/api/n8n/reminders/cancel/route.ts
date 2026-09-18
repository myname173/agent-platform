import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { cancelReminder } from '@/lib/n8n-client';

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
