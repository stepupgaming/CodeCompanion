import { commandNotice, diffNotice, type ChatSnapshot } from './chat';

// A code fence long enough that backticks inside the content cannot close it early.
function fence(content: string, language = ''): string {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}\n${content.replace(/\n$/, '')}\n${ticks}`;
}

// The chat as a Markdown document: the conversation, what the assistant did, and the diffs and commands it proposed.
// Tool output and the assistant's thinking are left out; they are long and rarely wanted in a shared transcript.
export function chatToMarkdown(chat: ChatSnapshot): string {
  const lines = [`# ${chat.title}`, ''];
  if (chat.projectPath) lines.push(`- Project: \`${chat.projectPath}\``);
  lines.push(`- Model: ${chat.model}`, '');

  for (const item of chat.transcript) {
    switch (item.kind) {
      case 'user':
        lines.push('## You', '', item.text.trim(), '');
        if (item.imageCount > 0)
          lines.push(`_(${item.imageCount} image${item.imageCount === 1 ? '' : 's'} attached)_`, '');
        break;
      case 'assistant':
        if (item.text.trim()) lines.push('## Assistant', '', item.text.trim(), '');
        break;
      case 'tool': {
        const status =
          item.undo === 'undone' ? ' (undone)' : item.status === 'done' ? '' : ` (${item.status.replace('-', ' ')})`;
        lines.push(`> **${item.name}**: ${item.summary ?? item.preview?.title ?? item.name}${status}`, '');
        if (item.preview?.command) lines.push(fence(item.preview.command, 'sh'), '');
        if (item.preview?.commandOmittedChars) lines.push(`_(${commandNotice(item.preview.commandOmittedChars)})_`, '');
        if (item.preview?.diff) lines.push(fence(item.preview.diff, 'diff'), '');
        if (item.preview?.diffOmittedLines) lines.push(`_(${diffNotice(item.preview.diffOmittedLines, false)})_`, '');
        break;
      }
      case 'error':
        lines.push(`> **Error:** ${item.text.trim()}`, '');
        break;
      case 'notice':
        lines.push(`> ${item.text.trim()}`, '');
        break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// A file name for the export: the chat title without characters Windows and macOS reject.
export function exportFileName(title: string): string {
  const name = title
    // eslint-disable-next-line no-control-regex -- control characters are stripped on purpose: they are invalid in file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${name || 'chat'}.md`;
}
