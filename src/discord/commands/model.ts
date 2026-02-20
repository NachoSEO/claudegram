import {
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ComponentType,
} from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { setModel, getModel } from '../../claude/agent.js';
import { getAvailableModels } from '../../providers/model-catalog.js';

export async function handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  const current = getModel(chatId);
  const models = getAvailableModels();

  const select = new StringSelectMenuBuilder()
    .setCustomId('model-select')
    .setPlaceholder(`Current: ${current}`)
    .addOptions(
      ...models.map(m =>
        new StringSelectMenuOptionBuilder()
          .setLabel(m.label)
          .setDescription(m.description)
          .setValue(m.id)
          .setDefault(current === m.id),
      ),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const response = await interaction.reply({
    content: `**Model Selector**\nCurrent model: **${current}**`,
    components: [row],
    ephemeral: true,
  });

  try {
    const collector = response.createMessageComponentCollector({ componentType: ComponentType.StringSelect, time: 60_000 });
    collector.on('collect', async (i) => {
      const selected = i.values[0];
      setModel(chatId, selected);
      await i.update({ content: `Model set to **${selected}**`, components: [] });
    });
  } catch { /* timeout, ignore */ }
}
