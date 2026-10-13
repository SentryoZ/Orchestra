import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Make sure a target directory exists. OpenCode refuses to open a session in a
 * directory that does not exist, so we create it (like `mkdir -p`) and let the
 * caller report that it did.
 */
export async function ensureDirectory(dir: string): Promise<{ created: boolean }> {
  if (!path.isAbsolute(dir)) {
    throw new Error(`targetDirectory must be an absolute path, got "${dir}"`);
  }
  const before = await exists(dir);
  await mkdir(dir, { recursive: true });
  return { created: !before };
}

async function exists(dir: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
