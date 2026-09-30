import { z } from 'zod';
import { defineTool } from './types';

// Plan mode: the model describes what it intends to do, the user approves or declines on an approval card, and the
// decision comes back to the model before any side effect happens. Implemented through the normal approval flow:
// requiresApproval shows the card, preview renders the plan, and a decline (with or without feedback) is handled
// by the agent like any other declined action. In Auto mode the card is skipped, like every other approval.
export const proposePlanTool = defineTool({
  name: 'propose_plan',
  description:
    'Show your plan for a multi-step task as an approval card before touching anything. Use it whenever plan mode is on and the task will change files or run commands: describe the steps concretely (files, commands, order), then wait for the decision. Keep the plan short enough to read in a minute.',
  schema: z.object({
    plan: z.string().describe('The plan in markdown: numbered steps, files to change, commands to run.'),
    summary: z.string().describe('One line describing the goal, shown as the card title.'),
  }),
  requiresApproval: true,
  preview: async ({ summary, plan }) => ({ title: summary || 'Plan', text: plan }),
  async run({ summary }) {
    return {
      content:
        'The user approved the plan. Carry it out step by step; if reality differs from the plan, say what changed and why before deviating.',
      summary: `Plan approved: ${summary || '(untitled)'}`,
    };
  },
});
