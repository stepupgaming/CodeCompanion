import { describe, expect, it } from 'vitest';
import {
  acceptsImages,
  claudeCapabilities,
  estimateCost,
  formatCost,
  imagesNotSupportedMessage,
  MODEL_OPTIONS,
} from './models';

describe('image input', () => {
  it('is on for every built-in model', () => {
    for (const option of MODEL_OPTIONS) expect(acceptsImages(option.id)).toBe(true);
  });

  it('is part of claudeCapabilities, and off for Claude ids that are not known to accept images', () => {
    expect(claudeCapabilities('claude-haiku-4-5').images).toBe(true);
    expect(claudeCapabilities('claude-opus-5').images).toBe(true);
    for (const id of ['claude-custom', 'claude-2.1', 'claude-opus-5-5-preview']) {
      expect(claudeCapabilities(id).images).toBe(false);
      expect(acceptsImages(id)).toBe(false);
    }
  });

  it('stays allowed for OpenAI and OpenAI-compatible model ids, whose support the app cannot know', () => {
    expect(acceptsImages('llama3.2')).toBe(true);
    expect(acceptsImages('gpt-6-luna')).toBe(true);
  });

  it('explains the refusal with the model name', () => {
    expect(imagesNotSupportedMessage('claude-custom')).toMatch(/^claude-custom does not accept images\./);
  });
});

describe('estimateCost', () => {
  it('adds input, output and cached input at the model prices', () => {
    // Asymmetric categories catch accidentally treating cache writes as ordinary input or cache reads.
    expect(
      estimateCost('claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 3_000_000,
      }),
    ).toBeCloseTo(29.4);
  });

  it('prices mixed GPT-6 short and long requests without choosing a tier from chat totals', () => {
    const usage = {
      inputTokens: 300_000,
      outputTokens: 30_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 20_000,
      // Only one request was long; the other short requests make the aggregate input misleading.
      longContext: { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 80_000, cacheWriteTokens: 5_000 },
    };
    expect(estimateCost('gpt-6-sol', usage)).toBeCloseTo(1.4485);
  });

  it('returns null for unknown models and official ids on custom compatible providers', () => {
    expect(
      estimateCost('gpt-6-astra', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 }, false),
    ).toBeNull();
    expect(estimateCost('claude-custom', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })).toBeNull();
  });

  it('keeps long-context tokens at list price for models without a long-context price', () => {
    const long = { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(
      estimateCost('claude-haiku-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        longContext: long,
      }),
    ).toBe(1);
  });

  it('accepts legacy usage without cache-write or long-context fields', () => {
    expect(estimateCost('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })).toBe(1);
  });
});

describe('formatCost', () => {
  it('shows cents, and a floor for tiny amounts', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
