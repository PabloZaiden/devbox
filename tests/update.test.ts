import { describe, expect, test } from "bun:test";
import { DEVBOX_UPDATER_CONFIG, runUpdateCommand } from "../src/update";

describe("runUpdateCommand", () => {
  test("checks for updates using the devbox release asset contract", async () => {
    const output: string[] = [];
    const requestedUrls: string[] = [];
    const fetchFn = Object.assign(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return Response.json({
          tag_name: "v0.2.0",
          assets: [
            {
              name: "devbox-v0.2.0-linux-x64",
              browser_download_url: "https://example.com/devbox-v0.2.0-linux-x64",
            },
            {
              name: "devbox-v0.2.0-linux-x64.sha256",
              browser_download_url: "https://example.com/devbox-v0.2.0-linux-x64.sha256",
            },
          ],
        });
      },
      { preconnect: () => {} },
    ) as typeof fetch;

    const exitCode = await runUpdateCommand(
      { checkOnly: true },
      {
        currentVersion: "0.1.0",
        out: message => output.push(message),
        err: message => output.push(message),
        getPlatform: () => ({ platform: "linux", arch: "x64" }),
        fetchFn,
      },
    );

    expect(exitCode).toBe(0);
    expect(requestedUrls).toEqual(["https://api.github.com/repos/pablozaiden/devbox/releases/latest"]);
    expect(output).toContain("Update available: 0.1.0 -> 0.2.0");
  });

  test("uses the confirmed updater configuration", () => {
    expect(DEVBOX_UPDATER_CONFIG).toMatchObject({
      repository: "pablozaiden/devbox",
      binaryName: "devbox",
      productName: "Devbox",
      checksum: { required: true },
    });
  });
});
