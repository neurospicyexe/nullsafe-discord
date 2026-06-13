import { formatSearchReply, formatImageReply } from "../tools-command.js";

describe("formatSearchReply", () => {
  test("lists found results as a deterministic ack (title + url)", () => {
    const out = formatSearchReply("rome weather", [
      { title: "Rome forecast", url: "https://w.test/rome", snippet: "sunny", score: 0.9 },
      { title: "Climate", url: "https://w.test/clim", snippet: "warm", score: 0.6 },
    ]);
    expect(out).toContain("rome weather");
    expect(out).toContain("2 result");
    expect(out).toContain("Rome forecast");
    expect(out).toContain("https://w.test/rome");
  });

  test("handles an empty result set without throwing", () => {
    const out = formatSearchReply("obscure thing", []);
    expect(out).toContain("0 result");
  });

  test("caps the number of listed results to keep the message Discord-safe", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `R${i}`, url: `https://x.test/${i}`, snippet: "s", score: 0.5,
    }));
    const out = formatSearchReply("q", many);
    // at most 5 bullets listed
    expect((out.match(/\n•/g) ?? []).length).toBeLessThanOrEqual(5);
  });
});

describe("formatImageReply", () => {
  test("returns the ack text plus the image url to attach", () => {
    const out = formatImageReply("a black truck at dusk", { url: "https://h.test/mind/tools/image/abc", key: "tool-images/drevan/abc.png" });
    expect(out.text).toContain("a black truck at dusk");
    expect(out.imageUrl).toBe("https://h.test/mind/tools/image/abc");
  });

  test("omits the attachment when no url is present", () => {
    const out = formatImageReply("x", { url: "", key: "" });
    expect(out.imageUrl).toBeUndefined();
  });
});
