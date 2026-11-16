import fs from 'node:fs';
import path from 'node:path';
import { getConfigHome } from '../config.js';

/**
 * Stage D — local Agent Skills discovery.
 *
 * Discovers skills laid out per the Agent Skills convention:
 *   <skills-root>/<skill-name>/SKILL.md
 * Each SKILL.md may carry YAML frontmatter with `name` and `description`.
 *
 * The skills root defaults to `<AGENTBOARD_HOME>/skills` and can be overridden with
 * AGENTBOARD_SKILLS_DIR. Discovered skills are delivered to providers that support them
 * (Copilot `skillDirectories`, Claude `skills`); providers without skill support are left
 * unchanged (explicit provider differences, not a one-size-fits-all assumption).
 */

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  path: string;
}

export function getSkillsRoot(): string {
  const override = process.env.AGENTBOARD_SKILLS_DIR?.trim();
  return override ? path.resolve(override) : path.join(getConfigHome(), 'skills');
}

/** Parse `name` / `description` from YAML frontmatter delimited by --- lines. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const pick = (key: string): string | undefined => {
    const line = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    if (!line) return undefined;
    return line.replace(/^["']|["']$/g, '');
  };
  return { name: pick('name'), description: pick('description') };
}

/** Discover skills under the root (each subdirectory containing a SKILL.md). */
export function discoverSkills(root: string = getSkillsRoot()): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable root -> no skills
  }
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const skillFile = path.join(dir, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue; // no SKILL.md in this directory
    }
    const { name, description } = parseSkillFrontmatter(content);
    skills.push({
      name: name || entry.name,
      description: description ?? '',
      dir,
      path: skillFile,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
