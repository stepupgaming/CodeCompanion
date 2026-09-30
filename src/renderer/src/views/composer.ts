import type { ImageAttachment } from '@shared/ipc';
import { h, icon } from '../dom';

export interface ComposerActions {
  send(text: string, images: ImageAttachment[]): Promise<boolean>;
  stop(): void;
  resume(): void;
  pickImages(): Promise<ImageAttachment[]>;
  // Shown when an image is pasted for a model that does not accept images.
  notice(message: string): void;
}

const PASTE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// The API limit for one image, as for attached files (src/main/files.ts).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class Composer {
  readonly element: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly attachmentList: HTMLElement;
  private readonly attachButton: HTMLButtonElement;
  // Why images cannot be attached for the chat's model, or null when they can.
  private imagesBlocked: string | null = null;
  private images: ImageAttachment[] = [];
  private busy = false;
  private draftVersion = 0;

  constructor(private readonly actions: ComposerActions) {
    this.input = h('textarea', {
      class: 'form-control composer-input',
      rows: 1,
      placeholder: 'Describe a task or ask a question…  (Enter to send, Shift+Enter for a new line)',
      'aria-label': 'Message',
      oninput: () => this.autosize(),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void this.submit();
        }
      },
      onpaste: (event: ClipboardEvent) => this.paste(event),
    });
    this.sendButton = h(
      'button',
      { class: 'btn btn-primary', title: 'Send', onclick: () => void this.submit() },
      icon('send'),
    );
    this.stopButton = h(
      'button',
      { class: 'btn btn-danger', title: 'Stop (Ctrl+.)', hidden: true, onclick: () => this.actions.stop() },
      icon('stop-fill'),
      ' Stop',
    );
    this.resumeButton = h(
      'button',
      { class: 'btn btn-primary', title: 'Resume stopped task', hidden: true, onclick: () => this.actions.resume() },
      icon('play-fill'),
      ' Resume',
    );
    this.attachmentList = h('div', { class: 'composer-attachments' });
    this.attachButton = h(
      'button',
      {
        class: 'btn btn-outline-secondary',
        title: 'Attach images',
        'aria-label': 'Attach images',
        onclick: () => void this.attach(),
      },
      icon('paperclip'),
    );

    this.element = h(
      'div',
      { class: 'composer' },
      this.attachmentList,
      h(
        'div',
        { class: 'composer-row' },
        this.attachButton,
        this.input,
        this.sendButton,
        this.stopButton,
        this.resumeButton,
      ),
    );
  }

  setState(busy: boolean, resumable: boolean): void {
    this.busy = busy;
    this.sendButton.hidden = busy;
    this.stopButton.hidden = !busy;
    this.resumeButton.hidden = busy || !resumable;
  }

  focus(): void {
    this.input.focus();
  }

  // `reason` is why the chat's model cannot take images, or null when it can. Images already in the draft stay, marked,
  // so nothing the user attached disappears; sending them is refused with the same reason.
  setImagesBlocked(reason: string | null): void {
    if (reason === this.imagesBlocked) return;
    this.imagesBlocked = reason;
    this.attachButton.disabled = reason !== null;
    this.attachButton.title = reason ?? 'Attach images';
    this.renderAttachments();
  }

  getDraft(): { text: string; images: ImageAttachment[] } {
    return { text: this.input.value, images: [...this.images] };
  }

  setDraft(draft: { text: string; images: ImageAttachment[] }): void {
    this.draftVersion++;
    this.input.value = draft.text;
    this.images = [...draft.images];
    this.renderAttachments();
    this.autosize();
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (this.busy || (!text && this.images.length === 0)) return;
    const version = this.draftVersion;
    const sent = await this.actions.send(text, this.images);
    if (sent && version === this.draftVersion) {
      this.input.value = '';
      this.images = [];
      this.renderAttachments();
      this.autosize();
    }
  }

  private async attach(): Promise<void> {
    const version = this.draftVersion;
    const images = await this.actions.pickImages();
    if (version !== this.draftVersion) return;
    this.images.push(...images);
    this.renderAttachments();
  }

  private paste(event: ClipboardEvent): void {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => PASTE_TYPES.has(file.type));
    if (files.length === 0) return;
    if (this.imagesBlocked) {
      // Copying from Word, Excel or a browser often puts text and an image on the clipboard together: let the text
      // paste as usual, and only say why the image was left out when there is nothing else.
      if (event.clipboardData?.types.includes('text/plain')) return;
      event.preventDefault();
      this.actions.notice(this.imagesBlocked);
      return;
    }
    event.preventDefault();
    const tooLarge = files.filter((file) => file.size > MAX_IMAGE_BYTES);
    if (tooLarge.length > 0)
      this.actions.notice(`${tooLarge.map((file) => file.name || 'The pasted image').join(', ')} is larger than 5 MB.`);
    const version = this.draftVersion;
    for (const file of files.filter((candidate) => candidate.size <= MAX_IMAGE_BYTES)) {
      const reader = new FileReader();
      reader.onload = () => {
        if (version !== this.draftVersion) return;
        const base64 = String(reader.result).split(',')[1] ?? '';
        this.images.push({
          name: file.name || 'pasted image',
          mediaType: file.type as ImageAttachment['mediaType'],
          base64,
        });
        this.renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  private renderAttachments(): void {
    this.attachmentList.replaceChildren(
      ...this.images.map((image, index) =>
        h(
          'span',
          {
            class: `badge ${this.imagesBlocked ? 'text-bg-warning' : 'text-bg-secondary'} me-1`,
            title: this.imagesBlocked ?? '',
          },
          icon('image'),
          ` ${image.name} `,
          h('button', {
            // A white cross is invisible on the yellow badge of an image the model cannot take.
            class: `btn-close${this.imagesBlocked ? '' : ' btn-close-white'} btn-sm ms-1`,
            'aria-label': `Remove ${image.name}`,
            onclick: () => {
              this.images.splice(index, 1);
              this.renderAttachments();
            },
          }),
        ),
      ),
    );
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }
}
