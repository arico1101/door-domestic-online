import { scenarioStory } from "../storyTools.js";

export default { title: "02 ロビー/待機（あいことば）" };

export const HostSolo = scenarioStory("waiting", "hostSolo", "hostSolo");
export const HostSix = scenarioStory("waiting", "hostSix", "hostSix");
export const Guest = scenarioStory("waiting", "guest", "guest");
export const HostOffline = scenarioStory("waiting", "hostOffline", "hostOffline");
