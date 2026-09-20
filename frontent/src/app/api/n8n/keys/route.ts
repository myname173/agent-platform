import { NextResponse } from 'next/server';
import { getKeys, manageKey } from '@/lib/n8n-client';
import { requireUser } from '@/lib/api-guard';

export async function GET() {
  const { denied } = await requireUser();
  if (denied) return denied;

  try {
    const data = await getKeys();
    return NextResponse.json(data);
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
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
