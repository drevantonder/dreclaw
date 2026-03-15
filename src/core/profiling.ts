type ProfileSpan = {
  name: string;
  durationMs: number;
  attrs?: Record<string, unknown>;
};

type ProfileEvent = {
  name: string;
  atMs: number;
  attrs?: Record<string, unknown>;
};

export type ProfilingConfig = {
  enabled: boolean;
  sampleRate: number;
  traceId?: string;
  context?: Record<string, unknown>;
};

export class Profiler {
  readonly enabled: boolean;
  readonly traceId: string;
  private readonly startedAt = performance.now();
  private readonly spans: ProfileSpan[] = [];
  private readonly events: ProfileEvent[] = [];
  private flushed = false;

  constructor(
    enabled: boolean,
    traceId: string,
    private readonly context: Record<string, unknown> = {},
  ) {
    this.enabled = enabled;
    this.traceId = traceId;
  }

  event(name: string, attrs?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.events.push({ name, atMs: roundMs(performance.now() - this.startedAt), attrs });
  }

  async span<T>(name: string, run: () => Promise<T>, attrs?: Record<string, unknown>): Promise<T> {
    if (!this.enabled) return run();
    const startedAt = performance.now();
    try {
      const result = await run();
      this.spans.push({
        name,
        durationMs: roundMs(performance.now() - startedAt),
        attrs,
      });
      return result;
    } catch (error) {
      this.spans.push({
        name,
        durationMs: roundMs(performance.now() - startedAt),
        attrs: {
          ...attrs,
          ok: false,
          error:
            error instanceof Error ? error.message : typeof error === "string" ? error : "unknown",
        },
      });
      throw error;
    }
  }

  flush(stage: string, attrs?: Record<string, unknown>): void {
    if (!this.enabled || this.flushed) return;
    this.flushed = true;
    console.info(
      JSON.stringify({
        type: "profiling",
        stage,
        traceId: this.traceId,
        totalMs: roundMs(performance.now() - this.startedAt),
        context: this.context,
        attrs,
        spans: this.spans,
        events: this.events,
      }),
    );
  }
}

export function createProfiler(config: ProfilingConfig): Profiler {
  const enabled =
    config.enabled && (config.sampleRate >= 1 || Math.random() < Math.max(0, config.sampleRate));
  return new Profiler(enabled, config.traceId ?? createTraceId(), config.context ?? {});
}

export function createTraceId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function parseProfilingEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

export function parseProfilingSampleRate(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(1, parsed));
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
