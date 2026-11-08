import { renderScenario } from "./harness.js";
import { scenarios } from "./fixtures.js";

/** Build a Storybook story that renders one deterministic game-state scenario. */
export function scenarioStory(group, key, name) {
  return {
    name,
    render: (_args, context) => {
      const scenario = scenarios?.[group]?.[key];
      if (!scenario) {
        throw new Error(`Missing Storybook scenario: scenarios.${group}.${key}`);
      }
      return renderScenario(scenario, context);
    },
  };
}
