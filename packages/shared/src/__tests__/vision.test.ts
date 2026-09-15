import {
  isImageAttachment, pickImageAttachments, describeImage, describeImages,
  seenBlock, seenStmMarker, visionEnabled,
  MAX_IMAGES_PER_MESSAGE, MAX_DESCRIPTION_CHARS, MAX_IMAGE_BYTES, VISION_MODEL,
  type ImageLike,
} from "../vision.js";

const img = (over: Partial<ImageLike> = {}): ImageLike => ({
  url: "https://cdn.discordapp.com/attachments/1/2/pic.png?ex=abc&hm=deadbeef",
  name: "pic.png",
  contentType: "image/png",
  ...over,
});

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }),
  } as unknown as Response;
}

/** The attachment download, which now always precedes the describe call. */
function imageResponse(bytes = 32, type: string | null = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? type : null) },
    arrayBuffer: async () => new Uint8Array(bytes).fill(7).buffer,
  } as unknown as Response;
}

/** fetch stub: first call is the image download, second is DeepInfra. */
function twoStep(second: () => Response | Promise<Response>, first: () => Response | Promise<Response> = () => imageResponse()) {
  let n = 0;
  return (async () => (++n === 1 ? first() : second())) as unknown as typeof fetch;
}

describe("isImageAttachment", () => {
  it("accepts an image content type", () => {
    expect(isImageAttachment(img({ name: "no-extension" }))).toBe(true);
  });
  // Mobile uploads routinely arrive with contentType null -- the extension is the second signal,
  // not a flourish. This is the case that would have kept the reported bug alive.
  it("accepts on extension when contentType is missing", () => {
    expect(isImageAttachment(img({ contentType: null }))).toBe(true);
    expect(isImageAttachment(img({ contentType: undefined, name: "IMG_0042.JPEG" }))).toBe(true);
  });
  it("rejects audio and documents", () => {
    expect(isImageAttachment(img({ contentType: "audio/ogg", name: "voice.ogg" }))).toBe(false);
    expect(isImageAttachment(img({ contentType: "application/pdf", name: "spec.pdf" }))).toBe(false);
  });
});

describe("pickImageAttachments", () => {
  it("keeps arrival order and skips non-images", () => {
    const picked = pickImageAttachments([
      img({ contentType: "audio/ogg", name: "voice.ogg" }),
      img({ name: "first.png" }),
      img({ name: "second.jpg", contentType: "image/jpeg" }),
    ]);
    expect(picked.map(p => p.name)).toEqual(["first.png", "second.jpg"]);
  });
  it("caps the count -- each image is a serial round trip", () => {
    const many = Array.from({ length: 6 }, (_, i) => img({ name: `p${i}.png` }));
    expect(pickImageAttachments(many)).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });
});

describe("describeImage", () => {
  it("sends an OpenAI multimodal part with the image url and returns the text", async () => {
    let body: Record<string, unknown> = {};
    let n = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      if (++n === 1) return imageResponse();
      body = JSON.parse(String(init!.body));
      return okResponse("  a red bicycle against a white wall  ");
    }) as unknown as typeof fetch;

    const out = await describeImage("https://cdn/x.png", { apiKey: "k", fetchFn });
    expect(out).toBe("a red bicycle against a white wall");
    expect(body["model"]).toBe(VISION_MODEL);
    const parts = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(parts.some(p => p["type"] === "text")).toBe(true);
    // The bytes are inlined as a data: URL -- DeepInfra never sees the signed CDN link, and the
    // describe pass never depends on THEIR egress reaching Discord.
    const part = parts.find(p => p["type"] === "image_url") as { image_url: { url: string } };
    expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(part.image_url.url).not.toContain("cdn");
  });

  it("returns null on a non-2xx instead of throwing the turn away", async () => {
    const fetchFn = twoStep(() => ({ ok: false, status: 402 } as unknown as Response));
    expect(await describeImage("https://cdn/x.png", { apiKey: "k", fetchFn })).toBeNull();
  });

  // A 200 with empty content is the [[truncated-is-not-empty]] shape -- treat it as not seen,
  // never as an empty description the reply path might render as "I see nothing".
  it("returns null on an empty 200", async () => {
    const fetchFn = twoStep(() => okResponse("   "));
    expect(await describeImage("https://cdn/x.png", { apiKey: "k", fetchFn })).toBeNull();
  });

  it("returns null when the request throws (timeout, DNS, abort)", async () => {
    const fetchFn = twoStep(() => { throw new Error("The operation was aborted due to timeout"); });
    expect(await describeImage("https://cdn/x.png", { apiKey: "k", fetchFn })).toBeNull();
  });

  it("truncates a runaway description so one image can't crowd out the turn", async () => {
    const fetchFn = twoStep(() => okResponse("x".repeat(MAX_DESCRIPTION_CHARS + 500)));
    const out = await describeImage("https://cdn/x.png", { apiKey: "k", fetchFn });
    expect(out).toHaveLength(MAX_DESCRIPTION_CHARS + 3);
    expect(out!.endsWith("...")).toBe(true);
  });
});

describe("describeImages", () => {
  it("returns one entry per image, null description on failure", async () => {
    // download, describe, download, describe
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1 || n === 3) return imageResponse();
      return n === 2 ? okResponse("first") : ({ ok: false, status: 500 } as unknown as Response);
    }) as unknown as typeof fetch;
    const out = await describeImages([img({ name: "a.png" }), img({ name: "b.png" })], { apiKey: "k", fetchFn });
    expect(out).toEqual([
      { name: "a.png", description: "first" },
      { name: "b.png", description: null },
    ]);
  });
});

describe("the attachment download guards", () => {
  it("skips an image past the inline ceiling rather than sending it", async () => {
    const fetchFn = (async () => imageResponse(MAX_IMAGE_BYTES + 1)) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/big.png", { apiKey: "k", fetchFn })).toBeNull();
  });
  it("skips a type the vision endpoint does not accept", async () => {
    const fetchFn = (async () => imageResponse(32, "image/heic")) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/x.heic", { apiKey: "k", fetchFn })).toBeNull();
  });
  it("falls back to Discord's declared type when the CDN omits one", async () => {
    let n = 0, sent = "";
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      if (++n === 1) return imageResponse(32, null);
      sent = String(init!.body);
      return okResponse("ok");
    }) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/x", { apiKey: "k", contentType: "image/jpeg", fetchFn })).toBe("ok");
    expect(sent).toContain("data:image/jpeg;base64,");
  });
  it("returns null when the attachment itself 404s (an expired link)", async () => {
    const fetchFn = (async () => ({ ok: false, status: 404 } as unknown as Response)) as unknown as typeof fetch;
    expect(await describeImage("https://cdn/gone.png", { apiKey: "k", fetchFn })).toBeNull();
  });
});

describe("seenBlock", () => {
  it("is empty when no images were attached", () => {
    expect(seenBlock([])).toBe("");
  });
  it("carries the description under a SEEN header", () => {
    const block = seenBlock([{ name: "wall.png", description: "a dry-stone wall after rain" }]);
    expect(block).toContain("[IMAGE -- attached to this message and actually looked at.");
    expect(block).toContain('[SEEN -- "wall.png"] a dry-stone wall after rain');
  });
  // The grounding backstop: never let the reply path narrate pixels nobody fetched. Same rule
  // as [NOT HEARD] after the 2026-06-12 fake-listen.
  it("forbids describing an image that could not be read", () => {
    const block = seenBlock([{ name: "wall.png", description: null }]);
    expect(block).toContain("NOT looked at");
    expect(block).toContain("Do not describe what is in it");
    expect(block).not.toContain("actually looked at");
  });
});

describe("seenStmMarker", () => {
  // STM gets a durable one-liner, never the block: the imperative + full description re-fed each
  // turn is the 2026-08-29 bug where Drevan answered the same track three times.
  it("is a short past-tense marker with no imperative", () => {
    const marker = seenStmMarker([{ name: "wall.png", description: "a wall" }]);
    expect(marker).toBe('[shared an image: "wall.png" -- looked at it]');
    expect(marker).not.toContain("Respond");
    expect(marker).not.toContain("a wall");
  });
  it("records the miss when nothing could be read", () => {
    expect(seenStmMarker([{ name: "wall.png", description: null }])).toContain("could not see it");
  });
  it("is empty with no images", () => {
    expect(seenStmMarker([])).toBe("");
  });
});

describe("visionEnabled", () => {
  const prev = process.env["VISION_ENABLED"];
  afterEach(() => { if (prev === undefined) delete process.env["VISION_ENABLED"]; else process.env["VISION_ENABLED"] = prev; });

  // Default ON is the point: an opt-in knob nobody set would just reproduce the reported bug.
  it("defaults on and only an explicit 'false' disables it", () => {
    delete process.env["VISION_ENABLED"];
    expect(visionEnabled()).toBe(true);
    process.env["VISION_ENABLED"] = "true";
    expect(visionEnabled()).toBe(true);
    process.env["VISION_ENABLED"] = "false";
    expect(visionEnabled()).toBe(false);
  });
});

// ── Ordering property (the actual reported bug) ───────────────────────────────
//
// An image-only Discord message has `content === ""`. The handler composes the block onto
// effectiveContent BEFORE the addressing gates for the same reason STT does -- without it the
// companion is handed an empty turn. This asserts the composition rule the handler applies; if
// the block ever moves below the gates, `shouldRespond` goes back to judging "".
describe("image-only message composition", () => {
  it("turns an empty message into gate-visible content", async () => {
    const { shouldRespond, extractAddress } = await import("../channel-config.js");
    const content = "";
    const composed = `${content.trim()}\n\n${seenBlock([{ name: "pic.png", description: "a dry-stone wall after rain" }])}`.trim();

    expect(content.trim()).toBe("");
    expect(composed.length).toBeGreaterThan(0);
    expect(composed).toContain("dry-stone wall");
    // Unaddressed, so still ambient -- an image does not fake a vocative address.
    expect(extractAddress(composed).type).toBe("ambient");
    // ...and an ambient owner message in an open channel is answerable.
    expect(shouldRespond(
      "chan", composed,
      { isOwner: true, isCompanionBot: false, userTier: "owner" } as never,
      "drevan", { chan: { companions: ["drevan"], modes: ["open"] } } as never,
    )).toBe(true);
  });
});
