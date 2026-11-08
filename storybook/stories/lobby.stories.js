import { scenarioStory } from "../storyTools.js";

export default { title: "01 ロビー/入室" };

export const Initial = scenarioStory("lobby", "initial", "initial");
export const NameEntered = scenarioStory("lobby", "nameEntered", "nameEntered");
export const JoinError = scenarioStory("lobby", "joinError", "joinError");
export const StartedError = scenarioStory("lobby", "startedError", "startedError");
