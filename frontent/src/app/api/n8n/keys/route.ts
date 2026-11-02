import { NextResponse } from 'next/server';
import { getKeys, manageKey } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, invalidateAdminReadCache, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const cached = await withAdminReadCache('keys', getKeys);
    return NextResponse.json(cached.value, { headers: adminReadCacheHeaders(cached.hit) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { denied } = await requireUser();
  if (denied) return denied;

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    /* empty body */
  }

  const clean = {
    action: String(payload.action || ''),
    name: String(payload.name || ''),
    rate_limit_rpm: payload.rate_limit_rpm === undefined ? undefined : Number(payload.rate_limit_rpm)
  };

  try {
    const out = await manageKey(clean);
    if (out.status >= 200 && out.status < 300) {
      invalidateAdminReadCache('keys');
    }
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
