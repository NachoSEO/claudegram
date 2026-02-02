import {
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import { clearConversation } from '../../claude/agent.js';
import { config } from '../../config.js';

const PAGE_SIZE = 23; // 25 max select options minus 2 reserve
const BROWSER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

interface BrowserState {
  root: string;
  current: string;
  page: number;
}

// Active browser states per user
const browserStates = new Map<string, BrowserState>();

function getBrowserRoot(): string {
  return path.resolve(process.env.HOME || config.WORKSPACE_DIR || process.cwd());
}

function listDirectories(dir: string): string[] {
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

function shortenLabel(name: string, max = 25): string {
  if (name.length <= max) return name;
  return name.slice(0, max - 1) + '\u2026';
}

function shortenDescription(fullPath: string, max = 100): string {
  if (fullPath.length <= max) return fullPath;
  return '\u2026' + fullPath.slice(fullPath.length - (max - 1));
}

function isWithinRoot(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function buildBrowserUI(state: BrowserState): {
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
      .setCustomId('project-dir-select')
      .setPlaceholder('Select a folder to open\u2026')
      .addOptions(options);

    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    );
  }

  // Row 2: Navigation buttons
  const canGoUp = state.current !== state.root && state.current !== '/';

  const upBtn = new ButtonBuilder()
    .setCustomId('project-up')
    .setLabel('\u2B06\uFE0F Up')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(!canGoUp);

  const useBtn = new ButtonBuilder()
    .setCustomId('project-use')
    .setLabel('Use This Folder')
    .setStyle(ButtonStyle.Success);

  const manualBtn = new ButtonBuilder()
    .setCustomId('project-manual')
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
      .setCustomId('project-prev')
      .setLabel('\u25C0\uFE0F Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(state.page === 0);

    const pageBtn = new ButtonBuilder()
      .setCustomId('project-page-info')
      .setLabel(`Page ${state.page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    const nextBtn = new ButtonBuilder()
      .setCustomId('project-next')
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

function setProject(chatId: number, dirPath: string): string {
  sessionManager.setWorkingDirectory(chatId, dirPath);
  clearConversation(chatId);
  const name = path.basename(dirPath) || dirPath;
  return `Project set: **${name}**\n\`${dirPath}\`\n\n@mention the bot or use \`/chat\` to talk to Claude.`;
}

export async function handleProject(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  const projectPath = interaction.options.getString('path');

  // Direct path: set immediately
  if (projectPath) {
    let resolvedPath = projectPath;
    if (resolvedPath.startsWith('~')) {
      resolvedPath = path.join(process.env.HOME || '', resolvedPath.slice(1));
    }
    resolvedPath = path.resolve(resolvedPath);

    if (!fs.existsSync(resolvedPath)) {
      await interaction.reply({ content: `Path not found: \`${resolvedPath}\``, ephemeral: true });
      return;
    }
    if (!fs.statSync(resolvedPath).isDirectory()) {
      await interaction.reply({ content: `Not a directory: \`${resolvedPath}\``, ephemeral: true });
      return;
    }

    await interaction.reply({ content: setProject(chatId, resolvedPath), ephemeral: true });
    return;
  }

  // No path: launch interactive browser
  const root = getBrowserRoot();
  const state: BrowserState = { root, current: root, page: 0 };

  // Start from current session directory if within root
  const session = sessionManager.getSession(chatId);
  if (session && isWithinRoot(root, session.workingDirectory)) {
    state.current = session.workingDirectory;
  }

  browserStates.set(interaction.user.id, state);
  const ui = buildBrowserUI(state);

  const response = await interaction.reply({
    content: ui.content,
    components: ui.components,
    ephemeral: true,
  });

  const collector = response.createMessageComponentCollector({ time: BROWSER_TIMEOUT });

  collector.on('collect', async (i) => {
    try {
      // Directory selection — navigate into
      if (i.isStringSelectMenu() && i.customId === 'project-dir-select') {
        const selected = i.values[0];
        const nextPath = path.join(state.current, selected);
        if (fs.existsSync(nextPath) && fs.statSync(nextPath).isDirectory()) {
          state.current = nextPath;
          state.page = 0;
        }
        const updated = buildBrowserUI(state);
        await i.update({ content: updated.content, components: updated.components });
        return;
      }

      if (!i.isButton()) return;

      switch (i.customId) {
        case 'project-up': {
          const parent = path.dirname(state.current);
          if (parent !== state.current) {
            state.current = parent;
            state.page = 0;
          }
          const updated = buildBrowserUI(state);
          await i.update({ content: updated.content, components: updated.components });
          break;
        }

        case 'project-use': {
          const msg = setProject(chatId, state.current);
          await i.update({ content: msg, components: [] });
          browserStates.delete(interaction.user.id);
          collector.stop();
          break;
        }

        case 'project-prev': {
          state.page = Math.max(0, state.page - 1);
          const updated = buildBrowserUI(state);
          await i.update({ content: updated.content, components: updated.components });
          break;
        }

        case 'project-next': {
          state.page += 1;
          const updated = buildBrowserUI(state);
          await i.update({ content: updated.content, components: updated.components });
          break;
        }

        case 'project-manual': {
          const modal = new ModalBuilder()
            .setCustomId(`project-modal-${interaction.user.id}`)
            .setTitle('Enter Project Path');

          const input = new TextInputBuilder()
            .setCustomId('project-path-input')
            .setLabel('Directory path')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('/home/user/projects/myapp')
            .setValue(state.current)
            .setRequired(true);

          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(input),
          );

          await i.showModal(modal);

          try {
            const modalSubmit = await i.awaitModalSubmit({ time: 60_000 });
            let inputPath = modalSubmit.fields.getTextInputValue('project-path-input').trim();

            if (inputPath.startsWith('~')) {
              inputPath = path.join(process.env.HOME || '', inputPath.slice(1));
            }
            inputPath = path.resolve(inputPath);

            if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isDirectory()) {
              await modalSubmit.reply({
                content: `Not a valid directory: \`${inputPath}\``,
                ephemeral: true,
              });
              return;
            }

            // Navigate to the entered path
            state.current = inputPath;
            // Update root if outside current root to allow continued browsing
            if (!isWithinRoot(state.root, inputPath)) {
              state.root = inputPath;
            }
            state.page = 0;

            const updated = buildBrowserUI(state);
            if (modalSubmit.isFromMessage()) {
              await modalSubmit.update({ content: updated.content, components: updated.components });
            } else {
              await modalSubmit.reply({ content: updated.content, components: updated.components, ephemeral: true });
            }
          } catch {
            // Modal timed out — ignore
          }
          break;
        }
      }
    } catch (error) {
      console.error('[Discord] Project browser error:', error);
    }
  });

  collector.on('end', () => {
    browserStates.delete(interaction.user.id);
  });
}
