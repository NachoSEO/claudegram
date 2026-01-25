// Format Claude's response for Telegram HTML mode

export function formatForTelegram(text: string): string {
  let formatted = text;

  // Escape HTML special characters first (except in code blocks)
  formatted = escapeHtmlOutsideCode(formatted);

  // Format code blocks: ```lang\ncode\n``` -> <pre><code class="language-lang">code</code></pre>
  formatted = formatted.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const langAttr = lang ? ` class="language-${lang}"` : '';
      return `<pre><code${langAttr}>${escapeHtml(code.trim())}</code></pre>`;
    }
  );

  // Format inline code: `code` -> <code>code</code>
  formatted = formatted.replace(
    /`([^`]+)`/g,
    (_, code) => `<code>${escapeHtml(code)}</code>`
  );

  // Format bold: **text** or __text__ -> <b>text</b>
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  formatted = formatted.replace(/__([^_]+)__/g, '<b>$1</b>');

  // Format italic: *text* or _text_ -> <i>text</i>
  formatted = formatted.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<i>$1</i>');
  formatted = formatted.replace(/(?<!_)_([^_]+)_(?!_)/g, '<i>$1</i>');

  // Format success indicators
  formatted = formatted.replace(/^(✓|✅)/gm, '✅');

  // Format file paths to be more visible
  formatted = formatted.replace(
    /(?:^|\s)((?:\.\/|\/)?(?:[\w-]+\/)*[\w-]+\.\w+)/g,
    ' <code>$1</code>'
  );

  return formatted.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlOutsideCode(text: string): string {
  // Split by code blocks, escape HTML only outside them
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    // Odd indices are code blocks, don't escape
    if (i % 2 === 1) return part;
    return escapeHtml(part);
  }).join('');
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

    // Try to split at a double newline (paragraph)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);

    // Try single newline
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }

    // Try space
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }

    // Force split at maxLength
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    parts.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trimStart();
  }

  return parts;
}
