export declare class SessionWindow {
    private channelId;
    private timeoutMs;
    private onTimeout;
    private timer;
    private destroyed;
    constructor(channelId: string, timeoutMs: number | undefined, onTimeout: (channelId: string) => void);
    touch(): void;
    close(): void;
    destroy(): void;
}
export declare class SessionWindowManager {
    private timeoutMs;
    private onTimeout;
    private windows;
    constructor(timeoutMs: number, onTimeout: (channelId: string) => void);
    touch(channelId: string): void;
    close(channelId: string): void;
    closeAll(): void;
}
