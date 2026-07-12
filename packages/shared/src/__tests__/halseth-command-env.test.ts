import { halsethEnv } from "../halseth-command-env.js";

describe("halsethEnv", () => {
  const OLD_ENV = process.env;
  beforeEach(() => { process.env = { ...OLD_ENV }; });
  afterEach(() => { process.env = OLD_ENV; });

  it("returns base + the given secret when HALSETH_URL is set", () => {
    process.env["HALSETH_URL"] = "https://halseth.example/";
    expect(halsethEnv("cypher-secret")).toEqual({ base: "https://halseth.example", secret: "cypher-secret" });
  });

  it("returns null when HALSETH_URL is missing", () => {
    delete process.env["HALSETH_URL"];
    expect(halsethEnv("cypher-secret")).toBeNull();
  });

  it("returns null when no secret is provided", () => {
    process.env["HALSETH_URL"] = "https://halseth.example/";
    expect(halsethEnv("")).toBeNull();
  });
});
