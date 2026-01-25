// Characters that need escaping in Telegram MarkdownV2
const ESCAPE_CHARS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];

export function escapeMarkdown(text: string): string {
  let result = text;
  for (const char of ESCAPE_CHARS) {
    result = result.replace(new RegExp(`\\${char}`, 'g'), `\\${char}`);
  }
  return result;
}

export function formatCodeBlock(code: string, language?: string): string {
  const escaped = code.replace(/`/g, '\\`');
  if (language) {
    return `\`\`\`${language}\n${escaped}\n\`\`\``;
  }
  return `\`\`\`\n${escaped}\n\`\`\``;
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf('\n', maxLength);

    // If no newline, try space
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }

    // If still no good split point, force split at maxLength
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    parts.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return parts;
}
