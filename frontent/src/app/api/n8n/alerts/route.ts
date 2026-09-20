import { NextResponse } from 'next/server';
import { getAlerts, testAlert } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const data = await getAlerts();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const out = await testAlert();
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
