import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

function withoutNativeSeedBindings(text: string): string {
  return text
    .replace('["iii-stream", "stream_store"]', '["native-file-builtin", "stream_store"]')
    .replace('worker("iii-stream").port', 'worker("native-file-builtin").port')
    .replace('worker("iii-stream").host', 'worker("native-file-builtin").host');
}

describe("removed stream/pubsub guard", () => {
  it.each(['import "iii-stream";', 'worker("iii-stream").subscribe();', '"iii-stream"'])
    ("does not exempt application transport outside the three native seed bindings: %s", (source) => {
      expect(withoutNativeSeedBindings(source)).toMatch(/iii-stream/);
    });

  it("keeps application source free of the deprecated stream transport", () => {
    const root = import.meta.dirname + "/..";
    const files = sourceFiles(join(root, "src"));
    const forbidden = [
      /stream::/,
      /STREAM\./,
      /\/stream\/mem-live/,
      /III_STREAM_PORT/,
      /streamsPort/,
      /new WebSocket/,
      /wsPort/,
      /iii-stream/,
      /iii-pubsub/,
    ];
    for (const file of files) {
      const original = readFileSync(file, "utf8");
      const nativeSeed = file === join(root, "src/cli/native-compat.ts");
      if (nativeSeed) expect(original.match(/iii-stream/g)).toHaveLength(3);
      const text = nativeSeed ? withoutNativeSeedBindings(original) : original;
      for (const pattern of forbidden) {
        expect(text, `${file} retained ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
