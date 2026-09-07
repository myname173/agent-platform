import { NextResponse } from 'next/server';
import { getHealthz } from '@/lib/n8n-client';

export async function GET() {
  try {
    const data = await getHealthz();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
