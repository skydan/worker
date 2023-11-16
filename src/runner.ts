import { getParsedCronItemsFromOptions, runCron } from "./cron";
import getTasks from "./getTasks";
import { ParsedCronItem, Runner, RunnerOptions, TaskList } from "./interfaces";
import {
  CompiledOptions,
  getUtilsAndReleasersFromOptions,
  Releasers,
} from "./lib";
import { _runTaskList, runTaskListInternal } from "./main";

export const runMigrations = async (options: RunnerOptions): Promise<void> => {
  const { release } = await getUtilsAndReleasersFromOptions(options);
  await release();
};

/** @internal */
async function assertTaskList(
  compiledOptions: CompiledOptions,
  releasers: Releasers,
): Promise<TaskList> {
  const {
    resolvedPreset: {
      worker: { taskDirectory },
    },
    _rawOptions: { taskList },
  } = compiledOptions;
  if (taskList) {
    return taskList;
  } else if (taskDirectory) {
    const watchedTasks = await getTasks(
      compiledOptions._rawOptions,
      taskDirectory,
    );
    releasers.push(() => watchedTasks.release());
    return watchedTasks.tasks;
  } else {
    throw new Error("You must specify either `taskList` or `taskDirectory`");
  }
}

export const runOnce = async (
  options: RunnerOptions,
  overrideTaskList?: TaskList,
): Promise<void> => {
  const compiledOptions = await getUtilsAndReleasersFromOptions(options);
  try {
    return await runOnceInternal(compiledOptions, overrideTaskList);
  } finally {
    await compiledOptions.release();
  }
};

export const runOnceInternal = async (
  compiledOptions: CompiledOptions,
  overrideTaskList?: TaskList,
): Promise<void> => {
  const {
    withPgClient,
    releasers,
    resolvedPreset: {
      worker: { concurrentJobs: concurrency },
    },
    _rawOptions: { noHandleSignals },
  } = compiledOptions;
  const taskList =
    overrideTaskList || (await assertTaskList(compiledOptions, releasers));
  const workerPool = _runTaskList(compiledOptions, taskList, withPgClient, {
    concurrency,
    noHandleSignals,
    continuous: false,
  });

  return await workerPool.promise;
};

export const run = async (
  rawOptions: RunnerOptions,
  overrideTaskList?: TaskList,
  overrideParsedCronItems?: Array<ParsedCronItem>,
): Promise<Runner> => {
  const compiledOptions = await getUtilsAndReleasersFromOptions(rawOptions);
  try {
    return await runInternal(
      compiledOptions,
      overrideTaskList,
      overrideParsedCronItems,
    );
  } finally {
    try {
      await compiledOptions.release();
    } catch (error) {
      compiledOptions.logger.error(
        `Error occurred whilst attempting to release options`,
        { error: error },
      );
    }
  }
};

export const runInternal = async (
  compiledOptions: CompiledOptions,
  overrideTaskList?: TaskList,
  overrideParsedCronItems?: Array<ParsedCronItem>,
): Promise<Runner> => {
  const { releasers } = compiledOptions;

  const taskList =
    overrideTaskList || (await assertTaskList(compiledOptions, releasers));

  const parsedCronItems =
    overrideParsedCronItems ||
    (await getParsedCronItemsFromOptions(compiledOptions, releasers));

  // The result of 'buildRunner' must be returned immediately, so that the
  // user can await its promise property immediately. If this is broken then
  // unhandled promise rejections could occur in some circumstances, causing
  // a process crash in Node v16+.
  return buildRunner({
    compiledOptions,
    taskList,
    parsedCronItems,
  });
};

/**
 * This _synchronous_ function exists to ensure that the promises are built and
 * returned synchronously, such that an unhandled promise rejection error does
 * not have time to occur.
 *
 * @internal
 */
function buildRunner(input: {
  compiledOptions: CompiledOptions;
  taskList: TaskList;
  parsedCronItems: ParsedCronItem[];
}): Runner {
  const { compiledOptions, taskList, parsedCronItems } = input;
  const { events, pgPool, releasers, addJob, logger } = compiledOptions;

  const cron = runCron(compiledOptions, parsedCronItems, { pgPool, events });
  releasers.push(() => cron.release());

  const workerPool = runTaskListInternal(compiledOptions, taskList, pgPool);
  releasers.push(() => {
    if (!workerPool._shuttingDown) {
      return workerPool.gracefulShutdown("Runner is shutting down");
    }
  });

  let running = true;
  const stop = async () => {
    if (running) {
      running = false;
      events.emit("stop", {});
    } else {
      throw new Error("Runner is already stopped");
    }
  };

  workerPool.promise.finally(() => {
    if (running) {
      stop();
    }
  });
  cron.promise.finally(() => {
    if (running) {
      stop();
    }
  });

  const promise = Promise.all([cron.promise, workerPool.promise]).then(
    () => {
      /* noop */
    },
    async (error) => {
      if (running) {
        logger.error(`Stopping worker due to an error: ${error}`, { error });
        await stop();
      } else {
        logger.error(
          `Error occurred, but worker is already stopping: ${error}`,
          { error },
        );
      }
      return Promise.reject(error);
    },
  );

  return {
    stop,
    addJob,
    promise,
    events,
  };
}
