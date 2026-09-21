import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

const BRIDGE_URL =
  process.env.STREAM_BRIDGE_URL ||
  (process.env.N8N_URL?.includes('n8n:')
    ? 'http://stream-bridge:3211/v1'
    : 'http://127.0.0.1:3211/v1');

const CHAT_API_KEY = process.env.CHAT_API_KEY || '';

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: '登录状态已失效，请重新登录后再试' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const endpoint = `${BRIDGE_URL}/chat/completions`;

    // F4: the debug console can name its own session, so multi-session behaviour
    // (and, since B3, person attribution) can actually be exercised from here.
    // Anything not obviously safe is rejected rather than silently passed through.
    const requested = String(body.sessionId || '').trim();
    const sessionOk = /^[A-Za-z0-9_.@:-]{1,64}$/.test(requested);
    const sessionId = sessionOk ? requested : `console-${userId}`;

    const upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHAT_API_KEY}`,
        'x-session-id': sessionId,
        'x-client': 'kiranism-playground'
      },
      body: JSON.stringify({
        model: body.model || 'deepseek-agent',
        messages: body.messages || [],
        stream: true,
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {})
      })
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return NextResponse.json(
        { error: `Upstream error (${upstreamRes.status}): ${errText}` },
        { status: upstreamRes.status }
      );
    }

    if (!upstreamRes.body) {
      return NextResponse.json({ error: 'No response body from stream-bridge' }, { status: 502 });
    }

    return new Response(upstreamRes.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (error: any) {
    console.error('Chat proxy error:', error);
    return NextResponse.json(
      { error: error?.message || 'Internal chat proxy error' },
      { status: 500 }
    );
  }
}
