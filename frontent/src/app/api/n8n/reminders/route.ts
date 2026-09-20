import { NextResponse } from 'next/server';
import { getReminders } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  const owner = new URL(req.url).searchParams.get('owner') || undefined;

  try {
    const data = await getReminders(owner);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
