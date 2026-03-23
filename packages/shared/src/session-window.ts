export class SessionWindow {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private channelId: string,
    private timeoutMs: number = 30 * 60 * 1000,
    private onTimeout: (channelId: string) => void,
  ) {}

  touch(): void {
    if (this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.destroyed) this.onTimeout(this.channelId);
    }, this.timeoutMs);
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

  close(channelId: string): void {
    this.windows.get(channelId)?.close();
    this.windows.delete(channelId);
  }

  closeAll(): void {
    for (const [id] of this.windows) this.close(id);
  }
}
