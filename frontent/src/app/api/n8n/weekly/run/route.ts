import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { runWeekly } from '@/lib/n8n-client';

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let scope: 'owner' | 'team' = 'owner';
  try {
    const body = await req.json();
    if (String(body?.scope || '').toLowerCase() === 'team') scope = 'team';
  } catch {
    /* empty body -> owner view */
  }

  try {
    const out = await runWeekly(scope);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
