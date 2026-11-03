import { scenarioStory } from "../storyTools.js";

export default { title: "03 盤面/手番" };

export const CheckingCards = scenarioStory("board", "checkingCards", "checkingCards");
export const HighSchoolStep = scenarioStory("board", "highSchoolStep", "highSchoolStep");
export const DiceTurn = scenarioStory("board", "diceTurn", "diceTurn");
export const OtherTurn = scenarioStory("board", "otherTurn", "otherTurn");
export const DisconnectedTurn = scenarioStory("board", "disconnectedTurn", "disconnectedTurn");
export const SixPlayers = scenarioStory("board", "sixPlayers", "sixPlayers");
export const FinishedAndLeft = scenarioStory("board", "finishedAndLeft", "finishedAndLeft");
