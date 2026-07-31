const {
  executeWormholeCommand,
} = require("./wormholeCommandHandlers");

const WORMHOLE_CHAT_COMMANDS = Object.freeze([
  "wormhole",
  "wormholes",
  "estate",
  "estateprologue",
  "prologue",
]);

const WORMHOLE_HELP_LINES = Object.freeze([
  "/wormholes [here|all|system]",
  "/wormholes systems [all|here|system]",
  "/wormhole status [here|all|system]",
  "/wormhole ensure [here|system|all]",
  "/wormhole random [count] [here|system]",
  "/wormhole clear [here|all|system]",
  "/estate [status|claim|members|role|services|projects|contribute|start|ledger|connections]",
  "/estateprologue [start|status|recover]",
]);

module.exports = {
  WORMHOLE_CHAT_COMMANDS,
  WORMHOLE_HELP_LINES,
  executeWormholeCommand,
};
