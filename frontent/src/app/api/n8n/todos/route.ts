import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getTodos } from '@/lib/n8n-client';

export async function GET(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const owner = new URL(req.url).searchParams.get('owner') || undefined;

  try {
    const out = await getTodos(owner);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
