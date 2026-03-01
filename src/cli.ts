#!/usr/bin/env node

import { runSimplyBuild } from "./app/runSimplyBuild.js";
import { HELP_TEXT, parseCliOptions } from "./cliOptions.js";
import { UserCancelledError, UserFacingError } from "./types.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { options, parseError } = parseCliOptions(argv);

  if (options.help) {
    if (parseError) {
      console.error(`Error: ${parseError}`);
      process.exitCode = 1;
    }
    console.log(HELP_TEXT);
    return;
  }

  await runSimplyBuild(options);
}

main().catch((error: unknown) => {
  if (error instanceof UserCancelledError) {
    process.exitCode = 130;
    return;
  }

  if (error instanceof UserFacingError) {
    console.error(`Error: ${error.message}`);
    for (const detail of error.details ?? []) {
      console.error(detail);
    }
    process.exitCode = 1;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
