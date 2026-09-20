import { NextResponse } from 'next/server';
import { getSettings } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const data = await getSettings();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
