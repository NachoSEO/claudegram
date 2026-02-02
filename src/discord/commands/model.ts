import {
  ChatInputCommandInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  ComponentType,
} from 'discord.js';
import { discordChatId } from '../id-mapper.js';
import { setModel, getModel } from '../../claude/agent.js';

export async function handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const chatId = discordChatId(interaction.user.id);
  const current = getModel(chatId);

  const select = new StringSelectMenuBuilder()
    .setCustomId('model-select')
    .setPlaceholder(`Current: ${current}`)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Opus').setDescription('Most capable model').setValue('opus').setDefault(current === 'opus'),
      new StringSelectMenuOptionBuilder().setLabel('Sonnet').setDescription('Balanced speed and capability').setValue('sonnet').setDefault(current === 'sonnet'),
      new StringSelectMenuOptionBuilder().setLabel('Haiku').setDescription('Fastest model').setValue('haiku').setDefault(current === 'haiku'),
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
