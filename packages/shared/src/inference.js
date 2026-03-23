class DeepSeekAdapter {
    apiKey;
    fetchFn;
    constructor(apiKey, fetchFn = globalThis.fetch) {
        this.apiKey = apiKey;
        this.fetchFn = fetchFn;
    }
    async generate(systemPrompt, messages) {
        const body = JSON.stringify({
            model: "deepseek-chat",
            messages: [
                { role: "system", content: systemPrompt },
                ...messages.map(m => ({ role: m.role, content: m.content })),
            ],
            max_tokens: 500,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const res = await this.fetchFn("https://api.deepseek.com/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this.apiKey}`,
                    },
                    body,
                });
                if (!res.ok) {
                    if (attempt === 0) {
                        await sleep(3000);
                        continue;
                    }
                    return null;
                }
                const data = await res.json();
                return data.choices[0]?.message?.content ?? null;
            }
            catch {
                if (attempt === 0) {
                    await sleep(3000);
                    continue;
                }
                return null;
            }
        }
        return null;
    }
}
class GroqAdapter {
    apiKey;
    fetchFn;
    constructor(apiKey, fetchFn = globalThis.fetch) {
        this.apiKey = apiKey;
        this.fetchFn = fetchFn;
    }
    async generate(systemPrompt, messages) {
        try {
            const res = await this.fetchFn("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: systemPrompt },
                        ...messages.map(m => ({ role: m.role, content: m.content })),
                    ],
                    max_tokens: 500,
                }),
            });
            if (!res.ok)
                return null;
            const data = await res.json();
            return data.choices[0]?.message?.content ?? null;
        }
        catch {
            return null;
        }
    }
}
class OllamaAdapter {
    baseUrl;
    fetchFn;
    constructor(baseUrl, fetchFn = globalThis.fetch) {
        this.baseUrl = baseUrl;
        this.fetchFn = fetchFn;
    }
    async generate(systemPrompt, messages) {
        try {
            const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama3.2",
                    messages: [
                        { role: "system", content: systemPrompt },
                        ...messages.map(m => ({ role: m.role, content: m.content })),
                    ],
                    stream: false,
                }),
            });
            if (!res.ok)
                return null;
            const data = await res.json();
            return data.message?.content ?? null;
        }
        catch {
            return null;
        }
    }
}
export function createAdapter(provider, deepseekKey, groqKey, ollamaUrl, fetchFn) {
    switch (provider) {
        case "deepseek":
            if (!deepseekKey)
                throw new Error("DEEPSEEK_API_KEY required");
            return new DeepSeekAdapter(deepseekKey, fetchFn);
        case "groq":
            if (!groqKey)
                throw new Error("GROQ_API_KEY required");
            return new GroqAdapter(groqKey, fetchFn);
        case "ollama":
            return new OllamaAdapter(ollamaUrl ?? "http://localhost:11434", fetchFn);
    }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
