import type { TranscriptItem } from './chat';

const MAX_SPOKEN_CHARS = 300;

function toolTitle(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  return item.summary ?? item.preview?.title ?? item.name.replace(/_/g, ' ');
}

// What a screen reader should be told about the transcript changes since the last call: finished answers, approval
// requests, failures, errors and notices. Streaming text is not announced piece by piece, and finished tool calls
// that succeeded are not announced at all. Ids already in `announced` are skipped, and new ones are added to it.
export function newAnnouncements(items: TranscriptItem[], announced: Set<string>): string[] {
  const messages: string[] = [];
  const once = (key: string, message: string | null) => {
    if (announced.has(key)) return;
    announced.add(key);
    if (message) messages.push(message);
  };

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        once(item.id, null);
        break;
      case 'assistant': {
        if (item.streaming) break;
        const text = item.text.trim();
        once(
          item.id,
          text ? `Assistant: ${text.length > MAX_SPOKEN_CHARS ? `${text.slice(0, MAX_SPOKEN_CHARS)}…` : text}` : null,
        );
        break;
      }
      case 'tool':
        if (item.status === 'awaiting-approval') once(`${item.id}:approval`, `Approval needed: ${toolTitle(item)}`);
        else if (item.status === 'error') once(`${item.id}:error`, `Failed: ${toolTitle(item)}`);
        break;
      case 'error':
        once(item.id, `Error: ${item.text.trim()}`);
        break;
      case 'notice':
        once(item.id, item.text.trim());
        break;
    }
  }
  return messages;
}

// Marks everything already in the transcript as announced, for when a chat is opened rather than watched live.
export function markAnnounced(items: TranscriptItem[], announced: Set<string>): void {
  newAnnouncements(items, announced);
}
