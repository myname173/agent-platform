import { NextResponse } from 'next/server';
import { getProjects, manageProject } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';
import { adminReadCacheHeaders, invalidateAdminReadCache, withAdminReadCache } from '@/lib/admin-read-cache';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const cached = await withAdminReadCache('projects', getProjects);
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
  if (payload.label !== undefined) clean.label = String(payload.label);
  if (payload.repo_url !== undefined) clean.repo_url = String(payload.repo_url);
  if (payload.customer !== undefined) clean.customer = String(payload.customer);
  if (payload.notes !== undefined) clean.notes = String(payload.notes);
  if (payload.status !== undefined) clean.status = String(payload.status);

  try {
    const result = await manageProject(clean as any);
    if (result.status >= 200 && result.status < 300) {
      invalidateAdminReadCache('projects');
    }
    return NextResponse.json(result.body ?? { ok: false }, { status: result.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
