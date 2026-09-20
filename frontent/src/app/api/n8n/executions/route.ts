import { NextRequest, NextResponse } from 'next/server';
import { getExecutions } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET(request: NextRequest) {
  const { denied } = await requireUser();
  if (denied) return denied;

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? 10);

  try {
    const data = await getExecutions(limit);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
