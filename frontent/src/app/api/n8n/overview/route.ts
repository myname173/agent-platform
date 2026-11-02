import { NextResponse } from 'next/server';
import { getOverview } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const cached = await withAdminReadCache('overview', getOverview);
    return NextResponse.json(cached.value, { headers: adminReadCacheHeaders(cached.hit) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
