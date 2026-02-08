import {
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config.js';
import { sessionManager } from '../claude/session-manager.js';
import { clearConversation } from '../claude/agent.js';

export const PAGE_SIZE = 23; // 25 max select options minus 2 reserve
export const BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export interface BrowserState {
  root: string;
  current: string;
  page: number;
}

export function getBrowserRoot(): string {
  return path.resolve(process.env.HOME || config.WORKSPACE_DIR || process.cwd());
}

export function listDirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function shortenLabel(name: string, max = 25): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '\u2026';
}

export function shortenDescription(fullPath: string, max = 100): string {
  if (fullPath.length <= max) return fullPath;
  return '\u2026' + fullPath.slice(fullPath.length - (max - 1));
}

export function isWithinRoot(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Build the interactive directory browser UI components.
 * @param state  Current browser state
 * @param prefix Custom ID prefix for component IDs (default: 'project')
 */
export function buildBrowserUI(
  state: BrowserState,
  prefix = 'project',
): {
  content: string;
  components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
} {
  const dirs = listDirectories(state.current);
  const totalPages = Math.max(1, Math.ceil(dirs.length / PAGE_SIZE));
  state.page = Math.min(Math.max(state.page, 0), totalPages - 1);

  const pageEntries = dirs.slice(
    state.page * PAGE_SIZE,
    (state.page + 1) * PAGE_SIZE,
  );

  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  // Row 1: Directory select menu (only if there are entries)
  if (pageEntries.length > 0) {
    const options = pageEntries.map(dir =>
      new StringSelectMenuOptionBuilder()
        .setLabel('\uD83D\uDCC1 ' + shortenLabel(dir))
        .setDescription(shortenDescription(path.join(state.current, dir)))
        .setValue(dir),
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId(`${prefix}-dir-select`)
      .setPlaceholder('Select a folder to open\u2026')
      .addOptions(options);

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    );
  }

  // Row 2: Navigation buttons
  const canGoUp = state.current !== state.root && state.current !== '/';

  const upBtn = new ButtonBuilder()
    .setCustomId(`${prefix}-up`)
    .setLabel('\u2B06\uFE0F Up')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!canGoUp);

  const useBtn = new ButtonBuilder()
    .setCustomId(`${prefix}-use`)
    .setLabel('Use This Folder')
    .setStyle(ButtonStyle.Success);

  const manualBtn = new ButtonBuilder()
    .setCustomId(`${prefix}-manual`)
    .setLabel('Enter Path')
    .setStyle(ButtonStyle.Primary);

  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    upBtn,
    useBtn,
    manualBtn,
  );
  components.push(navRow);

  // Row 3: Pagination buttons (only if >1 page)
  if (totalPages > 1) {
    const prevBtn = new ButtonBuilder()
      .setCustomId(`${prefix}-prev`)
      .setLabel('\u25C0\uFE0F Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.page === 0);

    const pageBtn = new ButtonBuilder()
      .setCustomId(`${prefix}-page-info`)
      .setLabel(`Page ${state.page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextBtn = new ButtonBuilder()
      .setCustomId(`${prefix}-next`)
      .setLabel('Next \u25B6\uFE0F')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.page >= totalPages - 1);

    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, pageBtn, nextBtn),
    );
  }

  // Header text
  const currentDisplay = state.current.replace(process.env.HOME || '', '~');
  const folderCount = dirs.length;
  const pageInfo = totalPages > 1 ? ` | Page ${state.page + 1}/${totalPages}` : '';
  const emptyNote = pageEntries.length === 0 ? '\n\n*(No subdirectories here)*' : '';

  const content =
    `\uD83D\uDCC1 **Project Browser**\n\n` +
    `**Location:** \`${currentDisplay}\`\n` +
    `**Folders:** ${folderCount}${pageInfo}` +
    emptyNote +
    `\n\nSelect a folder to navigate into, or use the buttons below.`;

  return { content, components };
}

/** Set project directory for a chat and return a confirmation message. */
export function setProject(chatId: number, dirPath: string): string {
  sessionManager.setWorkingDirectory(chatId, dirPath);
  clearConversation(chatId);
  const name = path.basename(dirPath) || dirPath;
  return `Project set: **${name}**\n\`${dirPath}\`\n\n@mention the bot or use \`/chat\` to talk to Claude.`;
}
