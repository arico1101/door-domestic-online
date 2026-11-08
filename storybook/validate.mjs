/* Storybook の雛形とストーリーが食いちがっていないかを確かめる（build-storybook の前に走る）。
   ・ストーリーが参照している雛形が全部あり、使われていない雛形もない
   ・人数は2〜6人の範囲（ロビーの進行役ひとりの画面だけは1人）
   ・どれも開けられない（見送るしかない）トビラは、いまの盤面では起きないので雛形にも置かない
   ・結果発表より前の画面で、ほかの人の「とくい」や見えない選択肢のタグが雛形に入っていない
     （サーバーの stateFor() と同じ形になっているか） */
import { readdir, readFile } from "node:fs/promises";
import { scenarios, EXPECTED_STORIES } from "./fixtures.js";

const storiesDir = new URL("./stories/", import.meta.url);
const files = (await readdir(storiesDir)).filter(name => name.endsWith(".stories.js"));
const refs = [];

for (const file of files) {
  const source = await readFile(new URL(file, storiesDir), "utf8");
  for (const match of source.matchAll(/scenarioStory\("([^"]+)",\s*"([^"]+)"/g)) {
    refs.push(`${match[1]}.${match[2]}`);
  }
}

const fixtureRefs = Object.entries(scenarios).flatMap(([group, entries]) =>
  Object.keys(entries).map(key => `${group}.${key}`));
const duplicateRefs = refs.filter((ref, index) => refs.indexOf(ref) !== index);
const missing = refs.filter(ref => !fixtureRefs.includes(ref));
const unused = fixtureRefs.filter(ref => !refs.includes(ref));

if (refs.length !== EXPECTED_STORIES) throw new Error(`Expected ${EXPECTED_STORIES} stories, found ${refs.length}`);
if (duplicateRefs.length) throw new Error(`Duplicate story scenarios: ${[...new Set(duplicateRefs)].join(", ")}`);
if (missing.length) throw new Error(`Missing fixtures: ${missing.join(", ")}`);
if (unused.length) throw new Error(`Unused fixtures: ${unused.join(", ")}`);

const SECRET = ["perk", "perkText", "hide", "hidden", "unseen", "doorLog"];
const leak = (obj, path = "") => {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET.includes(k)) return path + k;
    const r = leak(v, path + k + ".");
    if (r) return r;
  }
  return null;
};

for (const [group, entries] of Object.entries(scenarios)) {
  for (const [key, scenario] of Object.entries(entries)) {
    const g = scenario.g;
    if (!g) continue;
    if (g.players.length > 6) throw new Error(`${group}.${key} exceeds the six-player limit`);
    const pending = g.pending;
    if (pending?.kind === "choice" && pending.states && !pending.states.includes("open")) {
      throw new Error(`${group}.${key} contains an unreachable all-locked choice`);
    }
    if (g.phase !== "result") {
      for (const p of g.players.filter(p => p.id !== scenario.pid)) {
        const found = leak(p);
        if (found) throw new Error(`${group}.${key}: another player's secret is in the state (${found})`);
      }
      if (pending && pending.for !== scenario.pid && (pending.opts || pending.states || pending.pnote || pending.pnotes)) {
        throw new Error(`${group}.${key}: another player's choice details are in the state`);
      }
    }
  }
}

console.log(`Validated ${refs.length} Storybook scenarios across ${files.length} groups.`);
