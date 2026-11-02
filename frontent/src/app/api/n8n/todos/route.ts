import { NextResponse } from 'next/server';
import { getTodos } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  const owner = new URL(req.url).searchParams.get('owner') || undefined;
  const cacheKey = `todos:${owner || 'all'}`;

  try {
    const cached = await withAdminReadCache(cacheKey, () => getTodos(owner), {
      shouldCache: (out) => out.status >= 200 && out.status < 300
    });
    return NextResponse.json(cached.value.body ?? { error: 'upstream error' }, {
      status: cached.value.status,
      headers: adminReadCacheHeaders(cached.hit)
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
