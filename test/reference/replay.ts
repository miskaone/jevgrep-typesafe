import { expect } from "bun:test";
import { resolve } from "node:path";
export async function replay(
  mode: "healthy" | "missing" | "invalid" = "healthy",
  production = false,
) {
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/systemone");
      expect(request.headers.get("authorization")).toBe("Bearer reference-fixture");
      const body = (await request.json()) as {
        model: string;
        state: {
          items?: Array<{ path: string }>;
          path?: string;
          declarations?: unknown[];
          selectedEvidence?: unknown[];
          relationAnchor?: unknown;
        };
        questions: Record<string, { type: string; instructions?: string; criteria?: { yes: string; no: string } }>;
      };
      expect(body.model).toBe("jev-latest");
      for (const question of Object.values(body.questions)) {
        expect(question.type).toBe("noul");
        expect(question.instructions).toBeDefined();
        expect(question.criteria).toBeDefined();
        expect(typeof question.criteria).toBe("object");
      }
      requests.push(body);
      if (mode === "missing") return Response.json({ answers: {} });
      if (mode === "invalid")
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 2 }]),
          ),
        });
      return Response.json({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((id, i) => [
            id,
            {
              type: "noul",
              noul:
                body.state.items?.[i]?.path === "unrelated.md"
                  ? 0.05
                  : body.state.items?.[i]?.path === "src/backend" && !body.state.relationAnchor
                    ? 0.1
                    : body.state.declarations &&
                        !body.state.selectedEvidence &&
                        body.state.path !== "src/telemetry.ts"
                      ? 0.4
                      : 0.9,
            },
          ]),
        ),
        warnings: [{ type: "other", message: "fixture warning" }],
      });
    },
  });
  try {
    const child = Bun.spawn(
      production
        ? [
            "node",
            resolve("apps/cli/dist/bin/index.js"),
            "research how telemetry records event names",
            resolve("test/reference/tree"),
            "--no-cache",
          ]
        : [
            "node",
            "/opt/jevgrep-reference.mjs",
            "--root",
            resolve("test/reference/tree"),
            "--query",
            "research how telemetry records event names",
          ],
      {
        env: {
          PATH: process.env.PATH,
          TYPESAFE_API_KEY: "reference-fixture",
          TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      requests: requests.map((value) => JSON.stringify(value)).sort(),
      stdout,
      stderr,
      code,
    };
  } finally {
    server.stop(true);
  }
}
