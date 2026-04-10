/**
 * Skills — runtime loading from the Zotero data directory.
 *
 * The user's skills directory is the sole source of truth. Built-in skills
 * are copied there on first run (or when new ones are added in updates).
 * Users can create, edit, or delete `.md` skill files freely.
 */
import { parseSkill } from "./skillLoader";
import type { AgentSkill } from "./skillLoader";
import { BUILTIN_SKILL_FILES } from "./index";
import { joinLocalPath } from "../../utils/localPath";

const USER_SKILLS_DIR_NAME = "llm-for-zotero/skills";

// ---------------------------------------------------------------------------
// Gecko runtime helpers (mirrors patterns from mineruCache.ts)
// ---------------------------------------------------------------------------

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<number>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
  remove?: (path: string) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getBaseDir(): string {
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (typeof dataDir === "string" && dataDir.trim()) return dataDir.trim();
  const profileDir = zotero.Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim())
    return profileDir.trim();
  throw new Error("Cannot resolve Zotero data directory for user skills");
}

/** Returns the directory path where user skill files are stored. */
export function getUserSkillsDir(): string {
  return joinLocalPath(getBaseDir(), "llm-for-zotero", "skills");
}

// ---------------------------------------------------------------------------
// Initialization — copy missing built-in skills to user folder
// ---------------------------------------------------------------------------

const SEEDED_PREF_KEY = "extensions.zotero.llmForZotero.seededBuiltinSkills";

/** Read the set of built-in skill filenames that have already been seeded. */
function getSeededSkills(): Set<string> {
  try {
    const raw = Zotero.Prefs?.get(SEEDED_PREF_KEY, true);
    if (typeof raw === "string" && raw) return new Set(JSON.parse(raw));
  } catch { /* */ }
  return new Set();
}

/** Persist the set of seeded filenames. */
function setSeededSkills(seeded: Set<string>): void {
  try {
    Zotero.Prefs?.set(SEEDED_PREF_KEY, JSON.stringify([...seeded]), true);
  } catch { /* */ }
}

/**
 * Ensure the user skills directory exists and seed built-in skills.
 *
 * Only skills that have **never been seeded** are copied. This means:
 * - New built-in skills from plugin updates auto-appear.
 * - If a user deletes a built-in skill, it stays deleted across restarts.
 *
 * Call this before loadUserSkills().
 */
export async function initUserSkills(): Promise<void> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.makeDirectory) return;

  const dir = getUserSkillsDir();

  try {
    const exists = await io.exists(dir);
    if (!exists) {
      await io.makeDirectory(dir, {
        createAncestors: true,
        ignoreExisting: true,
      });
    }
  } catch {
    return;
  }

  const seeded = getSeededSkills();
  const encoder = new TextEncoder();

  for (const [filename, content] of Object.entries(BUILTIN_SKILL_FILES)) {
    if (seeded.has(filename)) continue; // already seeded once — respect user deletions
    const filePath = joinLocalPath(dir, filename);
    try {
      const exists = await io.exists(filePath);
      if (!exists) {
        await io.write(filePath, encoder.encode(content));
        Zotero.debug?.(
          `[llm-for-zotero] Copied built-in skill to user folder: ${filename}`,
        );
      }
      seeded.add(filename);
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Failed to copy built-in skill ${filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  setSeededSkills(seeded);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Scan the user skills directory for `.md` files and parse them.
 * This is the sole source of skills — all skills come from the user folder.
 * Returns an empty array if the directory does not exist or no valid
 * skill files are found. Never throws.
 */
export async function loadUserSkills(): Promise<AgentSkill[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.read || !io?.getChildren) return [];

  const dir = getUserSkillsDir();

  try {
    const exists = await io.exists(dir);
    if (!exists) return [];
  } catch {
    return [];
  }

  // List .md files
  let entries: string[];
  try {
    entries = await io.getChildren(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((entry) => entry.endsWith(".md"));
  if (mdFiles.length === 0) return [];

  const skills: AgentSkill[] = [];

  for (const filePath of mdFiles) {
    try {
      const data = await io.read(filePath);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const raw = new TextDecoder("utf-8").decode(bytes);

      const skill = parseSkill(raw);

      // Validate: must have a real id and at least one pattern
      if (skill.id === "unknown" || skill.patterns.length === 0) {
        Zotero.debug?.(
          `[llm-for-zotero] Skipping invalid skill file (missing id or match patterns): ${filePath}`,
        );
        continue;
      }

      skills.push(skill);
    } catch (err) {
      Zotero.debug?.(
        `[llm-for-zotero] Error loading skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (skills.length > 0) {
    Zotero.debug?.(
      `[llm-for-zotero] Loaded ${skills.length} skill(s) from ${dir}`,
    );
  }

  return skills;
}

// ---------------------------------------------------------------------------
// Skill file management (used by the skills popup UI)
// ---------------------------------------------------------------------------

/** List all .md file paths (full absolute paths) in the user skills directory. */
export async function listSkillFiles(): Promise<string[]> {
  const io = getIOUtils();
  if (!io?.exists || !io?.getChildren) return [];

  const dir = getUserSkillsDir();
  try {
    const exists = await io.exists(dir);
    if (!exists) return [];
    const entries = await io.getChildren(dir);
    return entries.filter((entry) => entry.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Delete a skill file by its full path. */
export async function deleteSkillFile(filePath: string): Promise<boolean> {
  const io = getIOUtils();
  if (!io?.remove) return false;

  try {
    await io.remove(filePath);
    return true;
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to delete skill file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Create a new skill template file and return its full path.
 * Auto-generates a unique filename (custom-skill-1.md, custom-skill-2.md, ...).
 */
export async function createSkillTemplate(): Promise<string | null> {
  const io = getIOUtils();
  if (!io?.exists || !io?.write || !io?.makeDirectory) return null;

  const dir = getUserSkillsDir();

  // Ensure directory exists (user may have deleted it after startup)
  try {
    await io.makeDirectory(dir, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch { /* */ }
  const encoder = new TextEncoder();
  const template = `---
id: my-custom-skill
match: /your regex pattern here/i
---

Describe when and how the agent should behave when this skill matches.
`;

  let index = 1;
  let filePath: string;
  // Find the next available filename
  // eslint-disable-next-line no-constant-condition
  while (true) {
    filePath = joinLocalPath(dir, `custom-skill-${index}.md`);
    try {
      const exists = await io.exists(filePath);
      if (!exists) break;
    } catch {
      break;
    }
    index++;
    if (index > 999) return null; // safety limit
  }

  try {
    await io.write(filePath, encoder.encode(template));
    return filePath;
  } catch (err) {
    Zotero.debug?.(
      `[llm-for-zotero] Failed to create skill template: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
