# graphile-worker

Job queue for PostgreSQL.

- Standalone and embedded modes
- Easy to test with (including `runAllJobs` util)
- Low latency (uses `LISTEN`/`NOTIFY` to be informed of jobs as they're inserted)
- High performance (uses `SKIP LOCKED` to find jobs to execute, resulting in faster fetches)
- Small tasks (uses explicit task names / payloads resulting in minimal serialisation/deserialisation overhead)
- Parallel by default
- Adding jobs to same named queue runs them in series
- Automatically re-attempts failed jobs with exponential back-off
- Customisable retry count (default: 25 attempts over ~3 days)
- Open source
- Executes tasks written in Node.js (can call out to any other language or networked service)
- Modern JS with async/await
- Watch mode for development (experimental - iterate your jobs without restarting worker)

## Requirements

PostgreSQL 9.6+ and Node v8.6+.

If your database doesn't already include the `pgcrypto` and `uuid-ossp` extensions we'll automatically install them into the public schema for you. If you have them installed in a different schema (unlikely) you may face issues.

## Installation

```
yarn add graphile-worker
```

## Running:

`graphile-worker` manages it's own database schema (`graphile_worker`) just
point graphile-worker at your database and we handle our own migrations:

```
graphile-worker -c "postgres://localhost/mydb"
```

## Performance

`graphile-worker` is not intended to replace extremely high performance
dedicated job queues, it's intended to be a very easy way to get a job queue
up and running with Node.js and PostgreSQL. But this doesn't mean it's a
slouch by any means - it achieves an average latency from triggering a job in
one process to executing it in another of just 75ms, and each worker can
handle up to 570 jobs per second on modest hardware (2011 iMac).

`graphile-worker` is horizontally scalable. Each instance has a customisable
worker pool, this pool defaults to size 1 (only one job at a time on this
worker) but depending on the nature of your tasks (i.e. assuming they're not
compute-heavy) you will likely want to set this higher to benefit from
Node.js' concurrency. If your tasks are compute heavy you may still wish to
set it higher and then using Node's `child_process` (or Node v11's
`worker_threads`) to share the compute load over multiple cores without
significantly impacting the main worker's runloop.

To test performance you can run `yarn perfTest`. This reveals that on a 2011
iMac running both the worker and the database (and a bunch of other stuff)
starting the command, checking for jobs, and exiting takes about 0.32s and
running 20000 trivial queued jobs across a single worker pool of size 1 takes
35.10s (~570 jobs per second). Latencies are also measured - from before the
call to queue the job is fired until when the job is actually executed. These
latencies ranged from 3ms to 147ms with an average of 75.6ms.

## Creating task executors

There's no point having a job queue if there's nothing to execute the jobs!

A task executor is a simple async JS function which receives as input the job
payload and a collection of helpers. It does the work and then returns. If it
returns then the job is deemed a success and is deleted from the queue. If it
throws an error then the job is deemed a failure and the task is rescheduled
using an exponential backoff algorithm.

**IMPORTANT**: your jobs should wait for all asynchronous work to be completed
\*before returning, otherwise we might mistakenly think they were successful.

**IMPORTANT**: we automatically retry the job if it fails, so it's often
sensible to split large jobs into smaller jobs, this also allows them to run
in parallel resulting in faster execution. This is particularly important
for tasks that are not idempotent (i.e. running them a second time will
have extra side effects) - for example sending emails.

Tasks are created in the `tasks` folder in the directory from which you run
`graphile-worker`; the name of the file (less the `.js` suffix) is used as
the task identifier. Currently only `.js` files that can be directly loaded
by Node.js are supported; if you are using Babel, TypeScript or similar you
will need to compile your tasks into the `tasks` folder.

```
current directory
├── package.json
├── node_modules
└── tasks
    ├── task_1.js
    └── task_2.js
```

```js
// tasks/task_1.js
module.exports = async payload => {
  await doMyLogicWith(payload);
};
```

```js
// tasks/task_2.js
module.exports = async (payload, { debug }) => {
  // async is optional, but best practice
  debug(`Received ${JSON.stringify(payload)}`);
};
```

## Uninstallation

To delete the worker code and all the tasks from your database, just run this one SQL statement:

```sql
DROP SCHEMA graphile_worker CASCADE;
```

## Exponential backoff

We currently use the formula `exp(least(10, attempt))` to determine the
delays between attempts (the job must fail before the next attempt is
scheduled, so the total time elapsed may be greater depending on how long the
job runs for before it fails). This seems to handle temporary issues well,
after ~4 hours attempts will be made every ~6 hours until the maximum number
of attempts is achieved. The specific delays can be seen below:

```
select
  attempt,
  exp(least(10, attempt)) * interval '1 second' as delay,
  sum(exp(least(10, attempt)) * interval '1 second') over (order by attempt asc) total_delay
from generate_series(1, 24) as attempt;

 attempt |      delay      |   total_delay
---------+-----------------+-----------------
       1 | 00:00:02.718282 | 00:00:02.718282
       2 | 00:00:07.389056 | 00:00:10.107338
       3 | 00:00:20.085537 | 00:00:30.192875
       4 | 00:00:54.598150 | 00:01:24.791025
       5 | 00:02:28.413159 | 00:03:53.204184
       6 | 00:06:43.428793 | 00:10:36.632977
       7 | 00:18:16.633158 | 00:28:53.266135
       8 | 00:49:40.957987 | 01:18:34.224122
       9 | 02:15:03.083928 | 03:33:37.308050
      10 | 06:07:06.465795 | 09:40:43.773845
      11 | 06:07:06.465795 | 15:47:50.239640
      12 | 06:07:06.465795 | 21:54:56.705435
      13 | 06:07:06.465795 | 28:02:03.171230
      14 | 06:07:06.465795 | 34:09:09.637025
      15 | 06:07:06.465795 | 40:16:16.102820
      16 | 06:07:06.465795 | 46:23:22.568615
      17 | 06:07:06.465795 | 52:30:29.034410
      18 | 06:07:06.465795 | 58:37:35.500205
      19 | 06:07:06.465795 | 64:44:41.966000
      20 | 06:07:06.465795 | 70:51:48.431795
      21 | 06:07:06.465795 | 76:58:54.897590
      22 | 06:07:06.465795 | 83:06:01.363385
      23 | 06:07:06.465795 | 89:13:07.829180
      24 | 06:07:06.465795 | 95:20:14.294975
```

## Development

```
yarn
yarn watch
```

In another terminal:

```
createdb graphile_worker_test
yarn test
```
