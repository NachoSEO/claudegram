import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'changed' | 'expired';

export type ApprovalRecord = {
  id: string;
  createdAt: number;
  expiresAt: number;
  state: ApprovalState;
  summary: string;
  details?: string;
  requestedByUserId: string;
  channelId: string;
  threadId?: string;
  messageId?: string;
  changeRequest?: string;
};

type ResolveFn = (res: { state: 'approved' | 'denied' | 'changed' | 'expired'; changeRequest?: string }) => void;

export class ApprovalManager {
  private approvals = new Map<string, ApprovalRecord>();
  private resolvers = new Map<string, ResolveFn>();

  constructor(private readonly ttlMs = 10 * 60 * 1000) {}

  create(args: {
    summary: string;
    details?: string;
    requestedByUserId: string;
    channelId: string;
    threadId?: string;
  }): ApprovalRecord {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = Date.now();
    const rec: ApprovalRecord = {
      id,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      state: 'pending',
      summary: args.summary,
      details: args.details,
      requestedByUserId: args.requestedByUserId,
      channelId: args.channelId,
      threadId: args.threadId,
    };
    this.approvals.set(id, rec);
    return rec;
  }

  get(id: string) {
    return this.approvals.get(id);
  }

  isExpired(rec: ApprovalRecord) {
    return Date.now() > rec.expiresAt;
  }

  renderButtons(id: string) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`appr:yes:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`appr:no:${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`appr:chg:${id}`).setLabel('Change…').setStyle(ButtonStyle.Secondary),
    );
  }

  async awaitDecision(id: string) {
    const rec = this.approvals.get(id);
    if (!rec) return { state: 'expired' as const };

    if (this.isExpired(rec)) {
      rec.state = 'expired';
      return { state: 'expired' as const };
    }

    return await new Promise<{ state: 'approved' | 'denied' | 'changed' | 'expired'; changeRequest?: string }>((resolve) => {
      this.resolvers.set(id, resolve);

      // Expiry timer
      setTimeout(() => {
        const r = this.approvals.get(id);
        if (!r) return;
        if (r.state !== 'pending') return;
        r.state = 'expired';
        this.resolvers.get(id)?.({ state: 'expired' });
        this.resolvers.delete(id);
      }, Math.max(0, rec.expiresAt - Date.now()));
    });
  }

  private finish(id: string, res: { state: 'approved' | 'denied' | 'changed' | 'expired'; changeRequest?: string }) {
    const rec = this.approvals.get(id);
    if (rec) {
      rec.state = res.state;
      if (res.changeRequest) rec.changeRequest = res.changeRequest;
    }
    const resolve = this.resolvers.get(id);
    if (resolve) resolve(res);
    this.resolvers.delete(id);
  }

  async handleButton(interaction: ButtonInteraction) {
    const [p, action, id] = String(interaction.customId).split(':');
    if (p !== 'appr' || !action || !id) return false;

    const rec = this.approvals.get(id);
    if (!rec) {
      await interaction.reply({ content: 'Approval request not found (expired).', ephemeral: true });
      return true;
    }

    if (this.isExpired(rec)) {
      rec.state = 'expired';
      await interaction.reply({ content: 'Approval request expired.', ephemeral: true });
      this.finish(id, { state: 'expired' });
      return true;
    }

    if (interaction.user.id !== rec.requestedByUserId) {
      await interaction.reply({ content: 'Only the requester can approve/deny this action.', ephemeral: true });
      return true;
    }

    if (action === 'yes') {
      await interaction.reply({ content: 'Approved.', ephemeral: true });
      this.finish(id, { state: 'approved' });
      return true;
    }

    if (action === 'no') {
      await interaction.reply({ content: 'Denied.', ephemeral: true });
      this.finish(id, { state: 'denied' });
      return true;
    }

    if (action === 'chg') {
      const modal = new ModalBuilder()
        .setCustomId(`appr:modal:${id}`)
        .setTitle('Change request');

      const input = new TextInputBuilder()
        .setCustomId('notes')
        .setLabel('What should change?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    return false;
  }

  async handleModal(interaction: ModalSubmitInteraction) {
    const [p, action, id] = String(interaction.customId).split(':');
    if (p !== 'appr' || action !== 'modal' || !id) return false;

    const rec = this.approvals.get(id);
    if (!rec) {
      await interaction.reply({ content: 'Approval request not found (expired).', ephemeral: true });
      return true;
    }

    if (this.isExpired(rec)) {
      rec.state = 'expired';
      await interaction.reply({ content: 'Approval request expired.', ephemeral: true });
      this.finish(id, { state: 'expired' });
      return true;
    }

    if (interaction.user.id !== rec.requestedByUserId) {
      await interaction.reply({ content: 'Only the requester can change this action.', ephemeral: true });
      return true;
    }

    const notes = interaction.fields.getTextInputValue('notes');
    await interaction.reply({ content: 'Change request received.', ephemeral: true });
    this.finish(id, { state: 'changed', changeRequest: notes });
    return true;
  }
}
