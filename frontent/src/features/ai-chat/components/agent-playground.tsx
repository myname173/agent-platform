'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  IconBrain,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconClock,
  IconCopy,
  IconPlayerStop,
  IconRefresh,
  IconRobot,
  IconSend,
  IconSparkles,
  IconTool,
  IconUser
} from '@tabler/icons-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  createdAt: number;
  tokens?: number;
  latencyMs?: number;
}

const AVAILABLE_MODELS = [
  {
    id: 'deepseek-agent',
    name: 'DeepSeek Agent (全能网关)',
    badge: '工具+检索',
    description: '默认全能智能体，内置 SearXNG 公网搜索、私域知识库与平台管控工具'
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    badge: '高吞吐极速',
    description: 'V4 代超快流式，支持多模态视觉内联与双向工具调用'
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    badge: '纯文本对话',
    description: '标准对话模式，无需工具调用时的低延迟通用问答'
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner (R1)',
    badge: '深度思考',
    description: '复杂逻辑推理、数学演算与代码架构分析'
  }
];

const PROMPT_SUGGESTIONS = [
  { label: '平台监控', prompt: '查询个人 AI 平台的实时健康状况与今日调用统计。' },
  { label: '检索知识库', prompt: '检索私域知识库中关于系统架构与配置的关键信息。' },
  { label: '待办清单', prompt: '查看我最近的所有未完成待办事项。' },
  { label: '今日晨报', prompt: '立即生成今天的精选早报并简要总结要点。' }
];

export function AgentPlayground() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('deepseek-agent');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});

  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = () => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming]);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleReasoning = (id: string) => {
    setExpandedReasoning((prev) => ({
      ...prev,
      [id]: prev[id] === undefined ? false : !prev[id]
    }));
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  };

  const handleClear = () => {
    handleStop();
    setMessages([]);
  };

  const handleSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const promptText = input.trim();
    if (!promptText || isStreaming) return;

    const userMsgId = 'usr-' + Date.now();
    const assistantMsgId = 'ast-' + (Date.now() + 1);

    const newMessages: ChatMessage[] = [
      ...messages,
      {
        id: userMsgId,
        role: 'user',
        content: promptText,
        createdAt: Date.now()
      }
    ];

    setMessages(newMessages);
    setInput('');
    setIsStreaming(true);

    const botMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      reasoning: '',
      createdAt: Date.now()
    };

    setMessages((prev) => [...prev, botMsg]);
    // Auto-expand reasoning by default for the active stream
    setExpandedReasoning((prev) => ({ ...prev, [assistantMsgId]: true }));

    const controller = new AbortController();
    abortRef.current = controller;
    const startTime = Date.now();

    try {
      const payloadMessages = newMessages.map((m) => ({
        role: m.role,
        content: m.content
      }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: payloadMessages
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errText = await res.text();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: `⚠️ 请求异常 (${res.status}): ${errText}`,
                  latencyMs: Date.now() - startTime
                }
              : m
          )
        );
        setIsStreaming(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('ReadableStream not supported');

      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let completionTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            if (data.usage?.completion_tokens) {
              completionTokens = data.usage.completion_tokens;
            }

            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) {
              accumulatedReasoning += delta.reasoning_content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, reasoning: accumulatedReasoning }
                    : m
                )
              );
            }

            if (delta.content) {
              accumulatedContent += delta.content;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: accumulatedContent,
                        latencyMs: Date.now() - startTime,
                        tokens: completionTokens
                      }
                    : m
                )
              );
            }
          } catch {}
        }
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: accumulatedContent || (accumulatedReasoning ? '（执行完成）' : '（空回复）'),
                reasoning: accumulatedReasoning,
                latencyMs: Date.now() - startTime,
                tokens: completionTokens
              }
            : m
        )
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: `⚠️ 对话流中断: ${err?.message || '未知错误'}`,
                  latencyMs: Date.now() - startTime
                }
              : m
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8.5rem)] max-w-5xl mx-auto gap-3">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-card border rounded-xl shadow-xs">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <IconRobot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">Agent 联调工作台</h2>
              <Badge variant="outline" className="text-xs">
                Live Gateway
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              直连 stream-bridge 与 n8n 网关，支持流式思考与工具执行追踪
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Model Selector */}
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isStreaming}
            className="text-xs border rounded-lg px-2.5 py-1.5 bg-background font-medium focus:ring-1 focus:ring-primary focus:outline-none"
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={messages.length === 0 || isStreaming}
            className="h-8 text-xs gap-1"
          >
            <IconRefresh className="w-3.5 h-3.5" />
            清空
          </Button>
        </div>
      </div>

      {/* Main Conversation Area */}
      <Card className="flex-1 flex flex-col overflow-hidden border shadow-xs">
        <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4 py-12">
              <div className="p-4 rounded-2xl bg-muted/60 text-muted-foreground border">
                <IconSparkles className="w-10 h-10 text-primary/70" />
              </div>
              <div className="max-w-md space-y-1">
                <h3 className="font-semibold text-foreground text-sm">
                  准备好体验真流式 Agent 了吗？
                </h3>
                <p className="text-xs text-muted-foreground">
                  输入自然语言指令或点击下方快捷卡片，实时测试公网搜索、私域知识库以及待办提醒调度。
                </p>
              </div>

              {/* Quick suggestions */}
              <div className="grid grid-cols-2 gap-2 w-full max-w-lg mt-2">
                {PROMPT_SUGGESTIONS.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setInput(item.prompt);
                    }}
                    className="flex flex-col items-start p-2.5 rounded-lg border bg-muted/30 hover:bg-muted/80 text-left transition-colors"
                  >
                    <span className="text-xs font-semibold text-primary">
                      {item.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground line-clamp-1">
                      {item.prompt}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex gap-3 ${
                  m.role === 'user' ? 'justify-end' : 'justify-start'
                }`}
              >
                {m.role === 'assistant' && (
                  <div className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
                    <IconRobot className="w-4 h-4" />
                  </div>
                )}

                <div
                  className={`flex flex-col max-w-[85%] ${
                    m.role === 'user' ? 'items-end' : 'items-start'
                  }`}
                >
                  {/* Reasoning block for assistant */}
                  {m.role === 'assistant' && m.reasoning && (
                    <div className="w-full mb-2 border rounded-lg bg-muted/40 overflow-hidden text-xs">
                      <button
                        onClick={() => toggleReasoning(m.id)}
                        className="w-full flex items-center justify-between px-3 py-1.5 bg-muted/60 text-muted-foreground hover:text-foreground font-medium text-left"
                      >
                        <span className="flex items-center gap-1.5">
                          <IconBrain className="w-3.5 h-3.5 text-amber-500" />
                          思考过程与工具调用
                        </span>
                        {expandedReasoning[m.id] !== false ? (
                          <IconChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <IconChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {expandedReasoning[m.id] !== false && (
                        <div className="p-3 text-muted-foreground whitespace-pre-wrap font-mono text-[11px] leading-relaxed border-t border-muted bg-background/50">
                          {m.reasoning}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Message Bubble */}
                  <div
                    className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-xs'
                        : 'bg-muted/70 text-foreground border rounded-tl-xs'
                    }`}
                  >
                    {m.content ||
                      (isStreaming && m.id === messages[messages.length - 1]?.id ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <IconTool className="w-3.5 h-3.5 animate-spin" />
                          正在生成回复...
                        </span>
                      ) : (
                        '（空回复）'
                      ))}
                  </div>

                  {/* Message metadata & actions */}
                  <div className="flex items-center gap-2 mt-1 px-1 text-[11px] text-muted-foreground">
                    <span>
                      {new Date(m.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                    {m.latencyMs && (
                      <span className="flex items-center gap-0.5">
                        <IconClock className="w-3 h-3" />
                        {(m.latencyMs / 1000).toFixed(1)}s
                      </span>
                    )}
                    {m.tokens ? <span>{m.tokens} tokens</span> : null}

                    {m.content && (
                      <button
                        onClick={() => handleCopy(m.id, m.content)}
                        className="hover:text-foreground transition-colors ml-1"
                        title="复制内容"
                      >
                        {copiedId === m.id ? (
                          <IconCheck className="w-3 h-3 text-emerald-500" />
                        ) : (
                          <IconCopy className="w-3 h-3" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {m.role === 'user' && (
                  <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 text-muted-foreground">
                    <IconUser className="w-4 h-4" />
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={scrollEndRef} />
        </CardContent>

        {/* Input Bar */}
        <div className="p-3 border-t bg-card">
          <form onSubmit={handleSubmit} className="flex gap-2 items-center">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="向平台智能体发送消息，按 Enter 发送..."
              disabled={isStreaming}
              className="flex-1 h-10 px-3.5 text-sm bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
            />

            {isStreaming ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleStop}
                className="h-10 px-4 gap-1.5"
              >
                <IconPlayerStop className="w-4 h-4" />
                停止
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!input.trim()}
                className="h-10 px-4 gap-1.5"
              >
                <IconSend className="w-4 h-4" />
                发送
              </Button>
            )}
          </form>
        </div>
      </Card>
    </div>
  );
}
