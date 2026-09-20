import { NextResponse } from 'next/server';
import { runWeekly } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function POST(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

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
