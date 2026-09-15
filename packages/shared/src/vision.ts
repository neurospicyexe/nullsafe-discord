// vision.ts -- shared-experience: Eyes.
//
// Raziel sent Drevan a picture on Discord and nothing happened. The cause was structural, not a
// misconfiguration: `bot-message-handler` read `message.attachments` for AUDIO only (STT), and every
// inference adapter in this repo sends `content` as a plain STRING. An image attachment never left
// Discord. On an image-only message `message.content` is "", so the companion was answering an empty
// turn -- which is exactly what "it didn't work" looked like from his side.
//
// WHY THE FIX LIVES HERE AND NOT IN HERMES (2026-09-14, measured on the VPS):
// Hermes DOES know how to downgrade images for a text-only main model -- `agent/image_routing.py`
// runs `vision_analyze` up-front and prepends the description ("text" mode). But that module is
// imported by `cli.py`, `tui_gateway/server.py`, `gateway/run.py` and `tools/vision_tools.py` --
// NOT by `gateway/platforms/api_server.py`, which is the endpoint our bots call. The api_server
// validates OpenAI-style `image_url` parts and hands them straight to the provider adapter, so
// sending image parts would put pixels at a text-only DeepSeek main model with no downgrade path.
// So the bot describes the image itself and injects the description as text -- the same shape as the
// [HEARD] block the listen pipeline already uses ([[one-shape-two-retrieval-jobs]]: text is the only
// content shape every adapter and every surface here can carry).
//
// Model: `Qwen/Qwen3-VL-30B-A3B-Instruct` on DeepInfra, NOT the 235B the Hermes aux uses. The 235B
// was measured at 89.7s for a 1MB image (2026-09-03) and this is the LIVE reply path sitting on top
// of a ~10s orient -- the 30B was pre-named as the fallback for exactly this case. Override with
// VISION_MODEL if that trade changes.
//
// Never log the attachment URL: a Discord CDN link carries an `hm=` signature and is bearer-ish
// while it lives ([[never-print-secret-values]]). Log the filename, type, size and description
// length instead -- the URL expires, so it is useless for replay anyway.

/** DeepInfra id for the describe pass. Speed over ceiling -- see the header note. */
export const VISION_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";

/** Hard cap on images described per message. Each one is a serial round trip. */
export const MAX_IMAGES_PER_MESSAGE = 2;

/** Per-image ceiling. The audio path uses 30s; a VL pass legitimately wants more. */
export const VISION_TIMEOUT_MS = 75_000;

/** Ceiling on a single description, so one image can't crowd out the turn. */
export const MAX_DESCRIPTION_CHARS = 1200;

/**
 * Largest attachment we will inline as a data: URL. Discord's own ceiling is 10MB on the free tier
 * (higher with Nitro); anything past this is skipped as [NOT SEEN] rather than sent -- base64
 * inflates by ~33% and a huge payload is the slow path we're specifically avoiding.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Discord's own fetch budget. The CDN is fast; a slow one is a dead one. */
export const FETCH_TIMEOUT_MS = 20_000;

// Mobile uploads routinely arrive with `contentType: null`, so the extension is a real second
// signal, not a belt-and-braces flourish. Same list Hermes's own image_routing uses.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;

/**
 * Kill switch, default ON.
 *
 * Deliberately not opt-in like MEDIA_LISTEN_ENABLED: that gate exists because the listen pipeline
 * needs yt-dlp and hear-music installed on the box, so it can be *absent*. This needs only the
 * DEEPINFRA_API_KEY the bots already carry, and "I sent a picture and nothing happened" is the
 * failure it exists to remove -- a knob nobody set would just reproduce the bug.
 */
export function visionEnabled(): boolean {
  return process.env["VISION_ENABLED"] !== "false";
}

/** The subset of a discord.js Attachment this module needs. Structural, so tests need no client. */
export interface ImageLike {
  url: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}

export function isImageAttachment(a: ImageLike): boolean {
  if (a.contentType?.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(a.name ?? "");
}

/**
 * Pick the images to describe, in arrival order, capped.
 *
 * Attachments are the ONLY source here. A pasted image link or a Tenor GIF arrives on
 * `message.embeds[].image`, not on `attachments` -- deliberately out of scope: an embed's image is
 * often decoration on a link (an article's og:image), and describing those would put a stranger's
 * thumbnail into the turn every time Raziel shares a URL.
 */
export function pickImageAttachments(
  attachments: Iterable<ImageLike>,
  max: number = MAX_IMAGES_PER_MESSAGE,
): ImageLike[] {
  const out: ImageLike[] = [];
  for (const a of attachments) {
    if (!isImageAttachment(a)) continue;
    out.push(a);
    if (out.length >= max) break;
  }
  return out;
}

const DESCRIBE_PROMPT =
  "Describe this image for someone who cannot see it. Be concrete and specific: what it shows, " +
  "the setting, who or what is in it, any text visible (quote it exactly), the mood or style. " +
  "Do not interpret feelings or invent context you cannot see. No preamble -- start with the " +
  "description itself.";

export interface DescribeOpts {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Discord's declared type, used only when the CDN response omits one. */
  contentType?: string | null;
  fetchFn?: typeof fetch;
}

/**
 * Download the attachment and return it as a `data:` URL, or null.
 *
 * WHY WE DON'T JUST HAND DEEPINFRA THE URL (measured 2026-09-14): DeepInfra fetches image URLs
 * server-side, and that fetch is not guaranteed to succeed -- a live check against a Wikimedia
 * thumbnail came back `Failed to download one or more images`. Discord CDN links are additionally
 * signed and expiring, so a remote fetch adds a second failure mode we cannot see or retry. The bot
 * already holds a valid link at the moment the message arrives; fetching here makes the describe
 * pass depend only on our own egress. It also keeps the `hm=` signature out of a third party's logs.
 */
async function fetchAsDataUrl(
  url: string,
  doFetch: typeof fetch,
  contentTypeHint?: string | null,
): Promise<string | null> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    console.warn(`[vision] attachment fetch non-2xx: ${res.status}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    console.warn("[vision] attachment fetch returned 0 bytes");
    return null;
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    console.warn(`[vision] attachment too large to inline: ${buf.byteLength} bytes`);
    return null;
  }
  // Trust the response header first, the Discord-side hint second; only the four types DeepInfra
  // accepts, so an exotic upload degrades to [NOT SEEN] rather than a 400 mid-turn.
  const raw = (res.headers.get("content-type") ?? contentTypeHint ?? "").split(";")[0]!.trim().toLowerCase();
  const mime = SUPPORTED_MIME.has(raw) ? raw : null;
  if (!mime) {
    console.warn(`[vision] unsupported image type: "${raw || "unknown"}"`);
    return null;
  }
  return `data:${mime};base64,${buf.toString("base64")}`;
}

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * One describe pass. Returns null on any failure -- the caller turns null into a [NOT SEEN] block
 * rather than failing the turn, because a companion that says "I can't see it" is correct and a
 * companion that invents the picture is the 2026-06-12 fake-listen class of bug.
 */
export async function describeImage(url: string, opts: DescribeOpts): Promise<string | null> {
  const model = opts.model ?? VISION_MODEL;
  const doFetch = opts.fetchFn ?? globalThis.fetch;
  try {
    const dataUrl = await fetchAsDataUrl(url, doFetch, opts.contentType);
    if (!dataUrl) return null;
    const res = await doFetch("https://api.deepinfra.com/v1/openai/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: DESCRIBE_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        }],
        max_tokens: 700,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? VISION_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[vision] non-2xx response: ${res.status} (model=${model})`);
      return null;
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const content = data.choices?.[0]?.message?.content ?? null;
    if (!content?.trim()) {
      // finish_reason is the discriminator between "model declined" and "budget ran out"
      // ([[truncated-is-not-empty]]).
      console.warn(`[vision] empty description (finish=${data.choices?.[0]?.finish_reason ?? ""}, model=${model})`);
      return null;
    }
    const text = content.trim();
    return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS)}...` : text;
  } catch (e: unknown) {
    const cause = e instanceof Error && e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
    console.warn(`[vision] describe failed: ${e instanceof Error ? e.message : String(e)}${cause}`);
    return null;
  }
}

export interface SeenImage {
  name: string;
  description: string | null;
}

/**
 * Describe every picked image. Serial on purpose: two concurrent VL calls double the peak latency
 * risk for no gain at a cap of 2, and the cap is what bounds the turn.
 */
export async function describeImages(images: ImageLike[], opts: DescribeOpts): Promise<SeenImage[]> {
  const out: SeenImage[] = [];
  for (const img of images) {
    const description = await describeImage(img.url, { ...opts, contentType: img.contentType ?? null });
    out.push({ name: safeName(img.name), description });
  }
  return out;
}

/** Filenames reach the model and the log; keep them short and free of newlines. */
function safeName(name: string | null | undefined): string {
  const n = (name ?? "image").replace(/[\r\n]+/g, " ").trim();
  return (n.length > 80 ? `${n.slice(0, 80)}...` : n) || "image";
}

/**
 * The turn-scoped block appended to `effectiveContent`.
 *
 * Mirrors [HEARD]/[NOT HEARD]: the standing imperative plus the full description are built for THIS
 * inference call only and must never be written to STM ([[chatter-lane-write-and-index]] -- storing
 * it re-fed the imperative every turn and Drevan answered the same track three times, 2026-08-29).
 */
export function seenBlock(seen: SeenImage[]): string {
  if (seen.length === 0) return "";
  const lines = seen.map((s) => (
    s.description
      ? `[SEEN -- "${s.name}"] ${s.description}`
      : `[NOT SEEN -- "${s.name}"] this image was attached but could not be read; nobody has looked ` +
        `at it. Do not describe what is in it. Say plainly that you can't see this one.`
  ));
  const anySeen = seen.some((s) => s.description);
  const header = anySeen
    ? "[IMAGE -- attached to this message and actually looked at. Respond to the picture itself, " +
      "in your own register; do not recite the description back.]"
    : "[IMAGE -- attached to this message but NOT looked at.]";
  return `${header}\n${lines.join("\n")}`;
}

/**
 * The DURABLE one-liner for STM. Without it the companion has no memory a picture was ever shared;
 * with the full block it would re-answer the picture every turn. Past tense, no imperative.
 */
export function seenStmMarker(seen: SeenImage[]): string {
  if (seen.length === 0) return "";
  const named = seen.map((s) => `"${s.name}"`).join(", ");
  const anySeen = seen.some((s) => s.description);
  return anySeen
    ? `[shared an image: ${named} -- looked at it]`
    : `[shared an image: ${named} -- could not see it]`;
}
