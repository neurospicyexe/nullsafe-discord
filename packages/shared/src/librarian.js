export class LibrarianClient {
    url;
    secret;
    companionId;
    _fetch;
    constructor(opts) {
        this.url = opts.url.replace(/\/$/, "");
        this.secret = opts.secret;
        this.companionId = opts.companionId;
        this._fetch = opts.fetch ?? globalThis.fetch;
    }
    async ask(request, context, sessionType) {
        const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "ask_librarian",
                arguments: {
                    request,
                    companion_id: this.companionId,
                    ...(context ? { context } : {}),
                    ...(sessionType ? { session_type: sessionType } : {}),
                },
            },
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await this._fetch(`${this.url}/librarian/mcp`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.secret}`,
                },
                body,
            });
            if (!res.ok) {
                if (attempt === 0) {
                    await sleep(3000);
                    continue;
                }
                throw new Error(`Librarian ${res.status}`);
            }
            const json = await res.json();
            if (json.error)
                throw new Error(`Librarian error: ${json.error.message}`);
            const text = json.result?.content?.[0]?.text ?? "{}";
            try {
                return JSON.parse(text);
            }
            catch {
                return { raw: text };
            }
        }
        throw new Error("Librarian unreachable");
    }
    async sessionOpen(sessionType = "work") {
        return this.ask("open my session", undefined, sessionType);
    }
    async sessionClose(params) {
        return this.ask("close session", JSON.stringify(params));
    }
    async getState() {
        return this.ask("my state");
    }
    async addCompanionNote(note, channel) {
        return this.ask("add companion note", JSON.stringify({ note, channel }));
    }
    async witnessLog(entry, channel) {
        return this.ask("witness log", JSON.stringify({ entry, channel }));
    }
    async synthesizeSession(summary, channel) {
        return this.ask("synthesize session", JSON.stringify({ summary, channel }));
    }
    async bridgePull() {
        return this.ask("check bridge events");
    }
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
