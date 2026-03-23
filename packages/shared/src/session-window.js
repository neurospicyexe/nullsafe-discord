export class SessionWindow {
    channelId;
    timeoutMs;
    onTimeout;
    timer = null;
    destroyed = false;
    constructor(channelId, timeoutMs = 30 * 60 * 1000, onTimeout) {
        this.channelId = channelId;
        this.timeoutMs = timeoutMs;
        this.onTimeout = onTimeout;
    }
    touch() {
        if (this.destroyed)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            if (!this.destroyed)
                this.onTimeout(this.channelId);
        }, this.timeoutMs);
    }
    close() {
        if (this.timer)
            clearTimeout(this.timer);
        if (!this.destroyed)
            this.onTimeout(this.channelId);
        this.destroyed = true;
    }
    destroy() {
        if (this.timer)
            clearTimeout(this.timer);
        this.destroyed = true;
    }
}
export class SessionWindowManager {
    timeoutMs;
    onTimeout;
    windows = new Map();
    constructor(timeoutMs, onTimeout) {
        this.timeoutMs = timeoutMs;
        this.onTimeout = onTimeout;
    }
    touch(channelId) {
        if (!this.windows.has(channelId)) {
            this.windows.set(channelId, new SessionWindow(channelId, this.timeoutMs, this.onTimeout));
        }
        this.windows.get(channelId).touch();
    }
    close(channelId) {
        this.windows.get(channelId)?.close();
        this.windows.delete(channelId);
    }
    closeAll() {
        for (const [id] of this.windows)
            this.close(id);
    }
}
