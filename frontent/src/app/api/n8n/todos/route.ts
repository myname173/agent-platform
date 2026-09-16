import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getTodos } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const out = await getTodos();
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
