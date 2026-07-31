"use strict";

const fs = require("fs");
const path = require("path");

const config = require(path.join(__dirname, "../src/config"));
const {
  getCharacterPortraitFilePath,
} = require(path.join(
  __dirname,
  "../src/services/character/portraitImageStore",
));
const {
  loadPortraitAgentPool,
} = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniversePilotDirectory",
));

function readNumericOption(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.slice(2).find((value) => value.startsWith(prefix));
  const numeric = Number(raw ? raw.slice(prefix.length) : fallback);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPortrait(agentID, size, attempt = 1) {
  const targetPath = getCharacterPortraitFilePath(agentID, size, "jpg");
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1_000) {
    return { agentID, status: "existing", targetPath };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      `https://images.evetech.net/characters/${agentID}/portrait?size=${size}`,
      {
        headers: { "user-agent": "EveJS-Living-Universe-Portrait-Sync/1.0" },
        redirect: "follow",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length <= 1_000) {
      throw new Error(`PORTRAIT_TOO_SMALL:${bytes.length}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.download`;
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, targetPath);
    return { agentID, status: "downloaded", targetPath, bytes: bytes.length };
  } catch (error) {
    if (attempt < 3) {
      await delay(250 * attempt);
      return fetchPortrait(agentID, size, attempt + 1);
    }
    return { agentID, status: "failed", error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const configuredPopulation = Math.max(
    1,
    Math.trunc(Number(config.livingUniversePopulationSize) || 400),
  );
  const count = Math.max(1, readNumericOption("count", configuredPopulation));
  const size = Math.max(32, readNumericOption("size", 256));
  const concurrency = Math.max(1, Math.min(24, readNumericOption("concurrency", 12)));
  const agentIDs = loadPortraitAgentPool().slice(0, count);
  let cursor = 0;
  const results = [];

  async function worker() {
    while (cursor < agentIDs.length) {
      const index = cursor;
      cursor += 1;
      const result = await fetchPortrait(agentIDs[index], size);
      results.push(result);
      if (results.length % 25 === 0 || results.length === agentIDs.length) {
        process.stdout.write(
          `[LivingUniversePortraits] ${results.length}/${agentIDs.length}\n`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, agentIDs.length) }, () => worker()),
  );
  const summary = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});
  process.stdout.write(`${JSON.stringify({ count, size, ...summary })}\n`);
  const failures = results.filter((result) => result.status === "failed");
  if (failures.length > 0) {
    process.stderr.write(
      `${JSON.stringify(failures.slice(0, 20), null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[LivingUniversePortraits] ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
