import {
  Interaction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { checkInteractionAuth } from '../middleware/auth.js';
import { handleChat } from '../commands/chat.js';
import { handleCancel } from '../commands/cancel.js';
import { handleSoftReset } from '../commands/softreset.js';
import { handleStatus } from '../commands/status.js';
import { handleClear } from '../commands/clear.js';
import { handleProject } from '../commands/project.js';
import { handleModel } from '../commands/model.js';
import { handleCommands } from '../commands/commands.js';
import { handleReddit } from '../commands/reddit.js';
import { handleVReddit } from '../commands/vreddit.js';
import { handleAskClaude } from '../commands/ask-claude.js';
import { handleContinue } from '../commands/continue.js';
import { handleResume } from '../commands/resume.js';
import { handleContext } from '../commands/context.js';
import { handleTranscribe } from '../commands/transcribe.js';
import { handleTTS } from '../commands/tts.js';
import { handleVoice } from '../commands/voice.js';
import { sanitizeError } from '../../utils/sanitize.js';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  // Context menu commands
  if (interaction.isMessageContextMenuCommand()) {
    const authorized = await checkInteractionAuth(interaction);
    if (!authorized) return;
    if (interaction.commandName === 'Ask Claude') {
      await handleAskClaude(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // Auth check
  const authorized = await checkInteractionAuth(interaction);
  if (!authorized) return;

  const command = interaction as ChatInputCommandInteraction;

  try {
    switch (command.commandName) {
      case 'chat':
        await handleChat(command);
        break;
      case 'cancel':
        await handleCancel(command);
        break;
      case 'softreset':
        await handleSoftReset(command);
        break;
      case 'status':
        await handleStatus(command);
        break;
      case 'clear':
        await handleClear(command);
        break;
      case 'project':
        await handleProject(command);
        break;
      case 'model':
        await handleModel(command);
        break;
      case 'commands':
        await handleCommands(command);
        break;
      case 'reddit':
        await handleReddit(command);
        break;
      case 'vreddit':
        await handleVReddit(command);
        break;
      case 'continue':
        await handleContinue(command);
        break;
      case 'resume':
        await handleResume(command);
        break;
      case 'context':
        await handleContext(command);
        break;
      case 'transcribe':
        await handleTranscribe(command);
        break;
      case 'tts':
        await handleTTS(command);
        break;
      case 'voice':
        await handleVoice(command);
        break;
      default:
        await command.reply({ content: `Unknown command: ${command.commandName}`, ephemeral: true });
    }
  } catch (error) {
    console.error(`[Discord] Command error (/${command.commandName}):`, error);
    const errorMsg = `Error: ${sanitizeError(error)}`;

    try {
      if (command.deferred || command.replied) {
        await command.followUp({ content: errorMsg, ephemeral: true });
      } else {
        await command.reply({ content: errorMsg, ephemeral: true });
      }
    } catch {
      // Interaction expired or already handled
    }
  }
}
