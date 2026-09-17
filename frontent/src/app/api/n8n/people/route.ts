import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getPeople, managePerson } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await getPeople();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
    return NextResponse.json(result.body ?? { ok: false }, { status: result.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
