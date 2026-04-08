export class SessionWindow {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private lastMessageAt = 0;

  constructor(
    private channelId: string,
    private timeoutMs: number = 30 * 60 * 1000,
    private onTimeout: (channelId: string) => void,
  ) {}

  touch(): void {
    if (this.destroyed) return;
    this.lastMessageAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.destroyed) this.onTimeout(this.channelId);
    }, this.timeoutMs);
  }

  /** Returns true if a message was seen within the last thresholdMs (default 5min). */
  isActive(thresholdMs = 5 * 60 * 1000): boolean {
    if (this.destroyed || this.lastMessageAt === 0) return false;
    return Date.now() - this.lastMessageAt < thresholdMs;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.destroyed) this.onTimeout(this.channelId);
    this.destroyed = true;
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.destroyed = true;
  }
}

export class SessionWindowManager {
  private windows = new Map<string, SessionWindow>();

  constructor(
    private timeoutMs: number,
    private onTimeout: (channelId: string) => void,
  ) {}

  touch(channelId: string): void {
    if (!this.windows.has(channelId)) {
      this.windows.set(channelId, new SessionWindow(channelId, this.timeoutMs, this.onTimeout));
    }
    this.windows.get(channelId)!.touch();
  }

  /** Returns true if any channel had activity within the last thresholdMs. */
  isAnyActive(thresholdMs = 5 * 60 * 1000): boolean {
    for (const win of this.windows.values()) {
      if (win.isActive(thresholdMs)) return true;
    }
    return false;
  }

  close(channelId: string): void {
    this.windows.get(channelId)?.close();
    this.windows.delete(channelId);
  }

  closeAll(): void {
    for (const [id] of this.windows) this.close(id);
  }
}
