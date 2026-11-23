import { describe, expect, it } from "vitest";
import { requestLogSerializer } from "../src/app.js";

describe("request logging", () => {
  it("strips query strings so upgrade tickets never reach the access log", () => {
    expect(
      requestLogSerializer({
        method: "GET",
        url: "/api/v1/agent/connect?ticket=tkt_secret&token=ses_secret",
      }),
    ).toEqual({ method: "GET", url: "/api/v1/agent/connect" });
  });
});
