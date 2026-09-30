import { describe, expect, it } from 'vitest';
import { proposePlanTool } from './plan';

describe('propose_plan tool', () => {
  it('shows the plan as markdown on the approval card', async () => {
    const input = proposePlanTool.schema!.parse({ plan: '1. Do the thing\n2. Verify', summary: 'Do the thing' });
    const preview = await proposePlanTool.preview!(input, {} as never);
    expect(preview).toEqual({ title: 'Do the thing', text: '1. Do the thing\n2. Verify' });
  });

  it('tells the model the plan was approved', async () => {
    const output = await proposePlanTool.run({ plan: 'steps', summary: 'Goal' }, {} as never);
    expect(output.content).toContain('approved the plan');
    expect(output.summary).toContain('Goal');
  });
});
