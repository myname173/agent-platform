import { NextResponse } from 'next/server';
import { getWeekly } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const out = await getWeekly();
    return NextResponse.json(out);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
