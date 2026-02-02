/**
 * Discord message splitting utility.
 * Discord has a 2000 char message limit. We split at 1900 to leave room for formatting.
 * No MarkdownV2 escaping needed — Discord uses standard markdown.
 */

const DEFAULT_MAX_LENGTH = 1900;

/**
 * Split a message into chunks that fit within Discord's message limit.
 * Respects code block boundaries.
 */
export function splitDiscordMessage(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      if (inCodeBlock) {
        remaining = remaining + '\n```';
      }
      parts.push(remaining);
      break;
    }

    let chunk = remaining.substring(0, maxLength);
    let splitIndex = maxLength;

    // Track code block state in this chunk
    const codeBlockMatches = chunk.matchAll(/```(\w*)?/g);
    let tempInCodeBlock: boolean = inCodeBlock;
    let tempLang: string = codeBlockLang;

    for (const match of codeBlockMatches) {
      if (tempInCodeBlock) {
        tempInCodeBlock = false;
        tempLang = '';
      } else {
        tempInCodeBlock = true;
        tempLang = match[1] || '';
      }
    }

    if (tempInCodeBlock) {
      // In a code block — split at a newline
      const newlineSplit = chunk.lastIndexOf('\n');
      if (newlineSplit > maxLength / 2) {
        splitIndex = newlineSplit + 1;
        chunk = remaining.substring(0, splitIndex);

        // Recount code blocks in adjusted chunk
        const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
        tempInCodeBlock = inCodeBlock;
        tempLang = codeBlockLang;
        for (const match of adjustedMatches) {
          if (tempInCodeBlock) {
            tempInCodeBlock = false;
            tempLang = '';
          } else {
            tempInCodeBlock = true;
            tempLang = match[1] || '';
          }
        }
      }
    } else {
      // Not in a code block — split at natural boundaries
      const paragraphBreak = chunk.lastIndexOf('\n\n');
      if (paragraphBreak > maxLength / 2) {
        splitIndex = paragraphBreak + 2;
      } else {
        const newlineBreak = chunk.lastIndexOf('\n');
        if (newlineBreak > maxLength / 2) {
          splitIndex = newlineBreak + 1;
        } else {
          const spaceBreak = chunk.lastIndexOf(' ');
          if (spaceBreak > maxLength / 2) {
            splitIndex = spaceBreak + 1;
          }
        }
      }

      chunk = remaining.substring(0, splitIndex);

      // Recount code blocks
      const adjustedMatches = chunk.matchAll(/```(\w*)?/g);
      tempInCodeBlock = inCodeBlock;
      tempLang = codeBlockLang;
      for (const match of adjustedMatches) {
        if (tempInCodeBlock) {
          tempInCodeBlock = false;
          tempLang = '';
        } else {
          tempInCodeBlock = true;
          tempLang = match[1] || '';
        }
      }
    }

    // Close code block at chunk boundary if needed
    if (tempInCodeBlock) {
      chunk = chunk.trimEnd() + '\n```';
      inCodeBlock = true;
      codeBlockLang = tempLang;
    } else {
      inCodeBlock = tempInCodeBlock;
      codeBlockLang = tempLang;
    }

    parts.push(chunk);

    remaining = remaining.substring(splitIndex).trimStart();

    // Reopen code block in next chunk
    if (inCodeBlock && remaining.length > 0) {
      remaining = '```' + codeBlockLang + '\n' + remaining;
    }
  }

  return parts;
}
