#!/usr/bin/env node
import { loadConfig } from "graphile-config/load";
import * as yargs from "yargs";

import getCronItems from "./getCronItems";
import getTasks from "./getTasks";
import { getUtilsAndReleasersFromOptions } from "./lib";
import { EMPTY_PRESET, WorkerPreset } from "./preset";
import { runInternal, runOnceInternal } from "./runner";

const defaults = WorkerPreset.worker!;

const argv = yargs
  .parserConfiguration({
    "boolean-negation": false,
  })
  .option("connection", {
    description:
      "Database connection string, defaults to the 'DATABASE_URL' envvar",
    alias: "c",
  })
  .string("connection")
  .option("schema", {
    description:
      "The database schema in which Graphile Worker is (to be) located",
    alias: "s",
    default: defaults.schema,
  })
  .string("schema")
  .option("schema-only", {
    description: "Just install (or update) the database schema, then exit",
    default: false,
  })
  .boolean("schema-only")
  .option("once", {
    description: "Run until there are no runnable jobs left, then exit",
    default: false,
  })
  .boolean("once")
  .option("watch", {
    description:
      "[EXPERIMENTAL] Watch task files for changes, automatically reloading the task code without restarting worker",
    alias: "w",
    default: false,
  })
  .boolean("watch")
  .option("crontab", {
    description: "override path to crontab file",
  })
  .string("crontab")
  .option("jobs", {
    description: "number of jobs to run concurrently",
    alias: "j",
    default: defaults.concurrentJobs,
  })
  .number("jobs")
  .option("max-pool-size", {
    description: "maximum size of the PostgreSQL pool",
    alias: "m",
    default: 10,
  })
  .number("max-pool-size")
  .option("poll-interval", {
    description:
      "how long to wait between polling for jobs in milliseconds (for jobs scheduled in the future/retries)",
    default: defaults.pollInterval,
  })
  .number("poll-interval")
  .option("no-prepared-statements", {
    description:
      "set this flag if you want to disable prepared statements, e.g. for compatibility with pgBouncer",
    default: false,
  })
  .boolean("no-prepared-statements")
  .option("config", {
    alias: "C",
    description: "The path to the config file",
    normalize: true,
  })
  .string("config")
  .strict(true).argv;

const integerOrUndefined = (n: number | undefined): number | undefined => {
  return typeof n === "number" && isFinite(n) && Math.round(n) === n
    ? n
    : undefined;
};

function stripUndefined<T extends object>(
  t: T,
): { [Key in keyof T as T[Key] extends undefined ? never : Key]: T[Key] } {
  return Object.fromEntries(
    Object.entries(t).filter(([_, value]) => value !== undefined),
  ) as T;
}

function argvToPreset(inArgv: Awaited<typeof argv>): GraphileConfig.Preset {
  return {
    worker: stripUndefined({
      connectionString: inArgv["connection"],
      maxPoolSize: integerOrUndefined(inArgv["max-pool-size"]),
      pollInterval: integerOrUndefined(inArgv["poll-interval"]),
      preparedStatements: !inArgv["no-prepared-statements"],
      schema: inArgv.schema,
      crontabFile: inArgv["crontab"],
      concurrentJobs: integerOrUndefined(inArgv.jobs),
    }),
  };
}

async function main() {
  const userPreset = await loadConfig(argv.config);
  const ONCE = argv.once;
  const SCHEMA_ONLY = argv["schema-only"];
  const WATCH = argv.watch;

  if (WATCH) {
    throw new Error(
      "`--watch` mode is no longer supported; please use an external file watcher e.g. `node --watch node_modules/.bin/graphile-worker -c postgres://...` instead",
    );
  }

  if (SCHEMA_ONLY && ONCE) {
    throw new Error("Cannot specify both --once and --schema-only");
  }

  const compiledOptions = await getUtilsAndReleasersFromOptions({
    preset: {
      extends: [userPreset ?? EMPTY_PRESET, argvToPreset(argv)],
    },
  });
  try {
    if (
      !compiledOptions.resolvedPreset.worker.connectionString &&
      !process.env.PGDATABASE
    ) {
      throw new Error(
        "Please use `--connection` flag, set `DATABASE_URL` or `PGDATABASE` envvars to indicate the PostgreSQL connection to use.",
      );
    }


    if (SCHEMA_ONLY) {
      console.log("Schema updated");
      return;
    }

    const watchedTasks = await getTasks(
      compiledOptions._rawOptions,
      compiledOptions.resolvedPreset.worker.taskDirectory,
    );
    compiledOptions.releasers.push(() => watchedTasks.release());
    const watchedCronItems = await getCronItems(
      compiledOptions._rawOptions,
      compiledOptions.resolvedPreset.worker.crontabFile,
    );
    compiledOptions.releasers.push(() => watchedCronItems.release());

    if (ONCE) {
      await runOnceInternal(compiledOptions, watchedTasks.tasks);
    } else {
      const { promise } = await runInternal(
        compiledOptions,
        watchedTasks.tasks,
        watchedCronItems.items,
      );
      // Continue forever(ish)
      await promise;
    }
  } finally {
    await compiledOptions.release();
    const timer = setTimeout(() => {
      console.error(
        `Worker failed to exit naturally after 10 seconds; terminating manually. This may indicate a bug in Graphile Worker.`,
      );
      process.exit(1);
    }, 10000);
    timer.unref();
  }
}

main().catch((e) => {
  console.error(e); // eslint-disable-line no-console
  process.exit(1);
});
