import { NextResponse } from 'next/server';
import { getSelfcheckRuns, runSelfcheck } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    return NextResponse.json(await getSelfcheckRuns());
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const out = await runSelfcheck();
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
