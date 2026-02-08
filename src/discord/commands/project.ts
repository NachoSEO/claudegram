import {
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { discordChatId } from '../id-mapper.js';
import { sessionManager } from '../../claude/session-manager.js';
import {
  type BrowserState,
  BROWSER_TIMEOUT,
  getBrowserRoot,
  buildBrowserUI,
  isWithinRoot,
  setProject,
} from '../project-browser.js';

// Active browser states per user
const browserStates = new Map<string, BrowserState>();

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
