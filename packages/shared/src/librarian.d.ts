import type { CompanionId } from "./types.js";
interface LibrarianOptions {
    url: string;
    secret: string;
    companionId: CompanionId;
    fetch?: typeof globalThis.fetch;
}
export declare class LibrarianClient {
    private url;
    private secret;
    private companionId;
    private _fetch;
    constructor(opts: LibrarianOptions);
    ask(request: string, context?: string, sessionType?: "checkin" | "hangout" | "work" | "ritual"): Promise<Record<string, unknown>>;
    sessionOpen(sessionType?: "work" | "checkin" | "hangout" | "ritual"): Promise<Record<string, unknown>>;
    sessionClose(params: {
        sessionId: string;
        spine: string;
        lastRealThing: string;
        motionState: "in_motion" | "at_rest" | "floating";
    }): Promise<Record<string, unknown>>;
    getState(): Promise<Record<string, unknown>>;
    addCompanionNote(note: string, channel?: string): Promise<Record<string, unknown>>;
    witnessLog(entry: string, channel?: string): Promise<Record<string, unknown>>;
    synthesizeSession(summary: string, channel?: string): Promise<Record<string, unknown>>;
    bridgePull(): Promise<Record<string, unknown>>;
}
export {};
