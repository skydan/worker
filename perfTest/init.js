const { Pool } = require("pg");

const pgPool = new Pool({ connectionString: process.env.PERF_DATABASE_URL });

const jobCount = parseInt(process.argv[2], 10) || 1;
const queueCount = parseInt(process.argv[3], 10) || 0;

async function main() {
  if (queueCount > 0) {
    console.time("Adding jobs");
    await pgPool.query(
      `
      do $$
      begin
        perform graphile_worker.add_job('log_if_999', json_build_object('id', i), format('queue_%s', ((i - 1) % ${queueCount}))) from generate_series(1, ${jobCount}) i;
      end;
      $$ language plpgsql;
    `,
    );
    console.timeEnd("Adding jobs");
  } else {
    await pgPool.query(
        `
    do $$
    begin
      perform graphile_worker.add_job('log_if_999', json_build_object('id', i)) from generate_series(1, ${jobCount}) i;
    end;
    $$ language plpgsql;
  `,
    );
  }

  pgPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
