#!/usr/bin/env node
import { main } from "../src/jsctx.js";

main(process.argv.slice(2)).catch((err) => {
  console.error(`kaj-js-ctx: ${err.message}`);
  process.exitCode = 1;
});
