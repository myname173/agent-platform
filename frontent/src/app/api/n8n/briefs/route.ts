import { NextResponse } from 'next/server';
import { getBriefs, runBrief } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, invalidateAdminReadCache, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const cached = await withAdminReadCache('briefs', getBriefs);
    return NextResponse.json(cached.value, { headers: adminReadCacheHeaders(cached.hit) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const out = await runBrief();
    if (out.status >= 200 && out.status < 300) {
      invalidateAdminReadCache('briefs');
    }
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
