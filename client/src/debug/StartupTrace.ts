export interface StartupTraceEntry {
  name: string;
  timeMs: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __evilQuestStartupTrace?: StartupTrace;
  }
}

class StartupTrace {
  private readonly startTime = performance.now();
  private readonly entries: StartupTraceEntry[] = [];

  mark(name: string, detail?: Record<string, unknown>): void {
    const timeMs = performance.now() - this.startTime;
    this.entries.push({ name, timeMs, detail });
    performance.mark(`eq:${name}`);

    if (import.meta.env.DEV) {
      const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
      console.debug(`[startup] ${name} ${timeMs.toFixed(1)}ms${suffix}`);
    }
  }

  measure(name: string, startMark: string, endMark?: string): PerformanceMeasure | null {
    try {
      return performance.measure(
        `eq:${name}`,
        `eq:${startMark}`,
        endMark ? `eq:${endMark}` : undefined,
      );
    } catch {
      return null;
    }
  }

  snapshot(): StartupTraceEntry[] {
    return [...this.entries];
  }

  table(): void {
    if (!import.meta.env.DEV) return;
    console.table(this.entries.map((entry) => ({
      name: entry.name,
      timeMs: Math.round(entry.timeMs),
      detail: entry.detail ? JSON.stringify(entry.detail) : '',
    })));
  }
}

export const startupTrace = new StartupTrace();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__evilQuestStartupTrace = startupTrace;
}
