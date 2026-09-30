import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, SECRET_NAMES, type SecretName, type Settings, type SettingsView } from '@shared/settings';
import { readJson, writeJson } from './storage/json_file';

// Encrypts secrets at rest. In the app this is Electron's safeStorage (OS keychain / DPAPI); tests inject
// their own.
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

interface StoredSettings {
  settings: Partial<Settings>;
  // Base64 ciphertext when encryption is available, otherwise plain text marked with a "plain:" prefix.
  secrets: Partial<Record<SecretName, string>>;
}

export class SettingsStore extends EventEmitter {
  private settings: Settings;
  private secrets: Partial<Record<SecretName, string>>;

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher,
  ) {
    super();
    const stored = readJson<StoredSettings>(path, { settings: {}, secrets: {} });
    this.settings = sanitize({ ...DEFAULT_SETTINGS, ...stored.settings });
    this.secrets = stored.secrets ?? {};
    this.migratePlainSecrets();
  }

  get(): Settings {
    return { ...this.settings };
  }

  view(): SettingsView {
    this.migratePlainSecrets();
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, Boolean(this.secrets[name])])) as Record<
      SecretName,
      boolean
    >;
    const stored = Object.values(this.secrets).filter(Boolean);
    const secretsEncrypted =
      stored.length > 0 ? stored.every((value) => !value.startsWith('plain:')) : this.cipher.isAvailable();
    return { ...this.settings, secrets, secretsEncrypted };
  }

  update(patch: Partial<Settings>): SettingsView {
    this.persist(sanitize({ ...this.settings, ...pickKnown(patch) }), this.secrets);
    return this.view();
  }

  getSecret(name: SecretName): string {
    this.migratePlainSecrets();
    const stored = this.secrets[name];
    if (!stored) return '';
    if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
    try {
      return this.cipher.decrypt(stored);
    } catch {
      return '';
    }
  }

  setSecret(name: SecretName, value: string): SettingsView {
    const trimmed = value.trim();
    const secrets = { ...this.secrets };
    if (!trimmed) {
      delete secrets[name];
    } else if (this.cipher.isAvailable()) {
      secrets[name] = this.cipher.encrypt(trimmed);
    } else {
      secrets[name] = `plain:${trimmed}`;
    }
    this.persist(this.settings, secrets);
    return this.view();
  }

  private migratePlainSecrets(): void {
    if (!this.cipher.isAvailable() || !Object.values(this.secrets).some((value) => value?.startsWith('plain:'))) return;
    // Stage the complete migration before writing or changing memory. A failed cipher or write must leave keys usable.
    try {
      const secrets = { ...this.secrets };
      for (const name of SECRET_NAMES) {
        const value = secrets[name];
        if (value?.startsWith('plain:')) secrets[name] = this.cipher.encrypt(value.slice('plain:'.length));
      }
      writeJson(this.path, { settings: this.settings, secrets } satisfies StoredSettings);
      this.secrets = secrets;
    } catch {
      // Retain the original storage representation; a later access can retry when encryption/storage recovers.
    }
  }

  private persist(settings: Settings, secrets: Partial<Record<SecretName, string>>): void {
    writeJson(this.path, { settings, secrets } satisfies StoredSettings);
    this.settings = settings;
    this.secrets = secrets;
    this.emit('change', this.view());
  }
}

function pickKnown(patch: Partial<Settings>): Partial<Settings> {
  const known = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];
  return Object.fromEntries(Object.entries(patch).filter(([key]) => known.includes(key as keyof Settings)));
}

// Falls back to defaults for values of the wrong type, e.g. from a hand-edited settings file.
function sanitize(settings: Settings): Settings {
  const result = { ...settings };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof result[key] !== typeof DEFAULT_SETTINGS[key]) {
      (result as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
    }
  }
  if (!['ask', 'auto'].includes(result.approvalMode)) result.approvalMode = DEFAULT_SETTINGS.approvalMode;
  if (!['dark', 'light'].includes(result.theme)) result.theme = DEFAULT_SETTINGS.theme;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(result.effort)) result.effort = DEFAULT_SETTINGS.effort;
  result.maxIndexedFiles = Math.max(1, Math.floor(result.maxIndexedFiles));
  result.model = result.model.trim() || DEFAULT_SETTINGS.model;
  return result;
}
