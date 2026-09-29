import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

const status = (host: string) => proxy(new NextRequest("http://127.0.0.1:3003/api/status", { headers: { host } })).status;
const saved = process.env.ALLOWED_HOSTS;
afterEach(() => { if (saved === undefined) delete process.env.ALLOWED_HOSTS; else process.env.ALLOWED_HOSTS = saved; });

describe("host allow-list", () => {
  it("accepts loopback names and the default 'brody' when ALLOWED_HOSTS is unset", () => {
    delete process.env.ALLOWED_HOSTS;
    for (const host of ["localhost:3003", "127.0.0.1:3003", "[::1]:3003", "brody:3003", "LOCALHOST"]) expect(status(host), host).toBe(200);
  });

  it("refuses other names with 421, which blocks DNS rebinding", () => {
    process.env.ALLOWED_HOSTS = "brody";
    expect(status("evil.example:3003")).toBe(421);
    expect(status("localhost.evil.example")).toBe(421);
  });

  it("uses the configured names and turns the check off when empty", () => {
    process.env.ALLOWED_HOSTS = "review.internal, other";
    expect(status("other:3003")).toBe(200);
    expect(status("brody:3003")).toBe(421);
    process.env.ALLOWED_HOSTS = "";
    expect(status("anything.example")).toBe(200);
  });
});
