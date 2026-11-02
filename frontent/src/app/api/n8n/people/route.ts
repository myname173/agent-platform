import { NextResponse } from 'next/server';
import { getPeople, managePerson } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, invalidateAdminReadCache, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const cached = await withAdminReadCache('people', getPeople);
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

  const clean: Record<string, unknown> = {
    action: String(payload.action || ''),
    name: String(payload.name || '')
  };
  if (payload.display_name !== undefined) clean.display_name = String(payload.display_name);
  if (payload.role !== undefined) clean.role = String(payload.role);
  if (payload.channels !== undefined) clean.channels = String(payload.channels);
  if (payload.tz !== undefined) clean.tz = String(payload.tz);
  if (payload.note !== undefined) clean.note = String(payload.note);
  if (payload.active !== undefined) clean.active = Boolean(payload.active);

  try {
    const result = await managePerson(clean as any);
    if (result.status >= 200 && result.status < 300) {
      invalidateAdminReadCache('people', 'todos:*');
    }
    return NextResponse.json(result.body ?? { ok: false }, { status: result.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
