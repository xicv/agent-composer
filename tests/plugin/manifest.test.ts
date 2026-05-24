import { describe, it, expect } from "vitest";
import AjvMod from "ajv";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ajv 8 ships a default-export class; ESM/CJS interop quirk requires this
// dance so both vitest (esbuild) and tsc (Node16 strict) resolve the ctor.
const AjvCtor = (AjvMod as unknown as { default?: typeof AjvMod }).default ?? AjvMod;

const REPO_ROOT = resolve(__dirname, "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "plugin");
const SCHEMA_PATH = join(REPO_ROOT, "plugin.schema.json");

type ValidateFn = ((data: unknown) => boolean) & { errors?: unknown };

describe("plugin manifest schema", () => {
  const ajv = new (AjvCtor as unknown as new (opts?: object) => { compile: (s: object) => ValidateFn }) ({ allErrors: true, strict: true });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const validate = ajv.compile(schema);

  it("compiles as a strict JSON Schema", () => {
    // ajv.compile threw above if it didn't.
    expect(typeof validate).toBe("function");
  });

  it("validates the composer-mastermind plugin manifest", () => {
    const manifestPath = join(PLUGIN_ROOT, "composer-mastermind", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const ok = validate(manifest);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV errors:", validate.errors);
    }
    expect(ok).toBe(true);
  });

  it("validates every plugin.json under plugin/*/", () => {
    if (!existsSync(PLUGIN_ROOT)) return; // pre-Wave-4 environments
    const dirs = readdirSync(PLUGIN_ROOT).filter((d) => {
      const full = join(PLUGIN_ROOT, d);
      return statSync(full).isDirectory();
    });
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const manifestPath = join(PLUGIN_ROOT, d, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const ok = validate(manifest);
      if (!ok) {
        // eslint-disable-next-line no-console
        console.error(`plugin ${d} errors:`, validate.errors);
      }
      expect(ok).toBe(true);
    }
  });

  it("rejects a manifest missing the required 'name' field", () => {
    const ok = validate({ version: "1.0.0", description: "missing name field test" });
    expect(ok).toBe(false);
  });

  it("rejects a non-semver version", () => {
    const ok = validate({ name: "x", version: "not-semver", description: "valid description text" });
    expect(ok).toBe(false);
  });

  it("rejects an unknown top-level key (additionalProperties false)", () => {
    const ok = validate({
      name: "x",
      version: "1.0.0",
      description: "valid description text",
      bogus: true,
    });
    expect(ok).toBe(false);
  });

  it("rejects an unknown 'settings' key (additionalProperties false on settings)", () => {
    const ok = validate({
      name: "x",
      version: "1.0.0",
      description: "valid description text",
      settings: { BogusHook: ["bash:x.sh"] },
    });
    expect(ok).toBe(false);
  });

  it("accepts a minimal manifest (only required fields)", () => {
    const ok = validate({ name: "minimal-plugin", version: "0.0.1", description: "minimum valid manifest" });
    if (!ok) {
      // eslint-disable-next-line no-console
      console.error("AJV errors:", validate.errors);
    }
    expect(ok).toBe(true);
  });
});
