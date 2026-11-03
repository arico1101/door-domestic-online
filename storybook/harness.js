/**
 * Render the real game page in an isolated iframe and inject a deterministic
 * server snapshot through the app's Storybook-only preview API.
 *
 * Scenario shape: { g, you, pid, room, view, modal, ...modalOptions }
 */
export function renderScenario(scenario = {}, context = {}) {
  const snapshot = scenario.state || scenario;
  const state = snapshot.g || snapshot.game || snapshot;
  const you = scenario.you ?? snapshot.you;
  const pid = scenario.pid || snapshot.pid;

  const frame = document.createElement("iframe");
  frame.title = scenario.title || "トビラ game preview";
  frame.style.cssText = "display:block;width:100%;height:100vh;min-height:640px;border:0;background:#F2F9FD";
  frame.setAttribute("loading", "eager");

  const query = new URLSearchParams({ storybook: "1" });
  if (pid) query.set("pid", pid);
  frame.src = `/index.html?${query}`;

  frame.addEventListener("load", () => {
    const api = frame.contentWindow?.__tobira;
    if (!api?.preview) {
      console.error("Storybook preview API was not found in the game iframe.");
      return;
    }

    api.preview({
      screen: scenario.view || scenario.screen,
      state,
      you,
      pid,
      room: scenario.room || snapshot.room,
      modal: scenario.modal,
      modalOptions: scenario,
      dice: scenario.dice,
      diceValue: scenario.diceValue,
    });
  }, { once: true });

  return frame;
}
