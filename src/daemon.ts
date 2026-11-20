import { runtimeDirectory } from "./files.js";
import { serveDaemon } from "./server.js";
import { makeTransport } from "./transport.js";

process.umask(0o077);
try {
  const directory = await runtimeDirectory();
  process.chdir(directory);
  await serveDaemon(await makeTransport(directory));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the Colab daemon.");
  process.exitCode = 1;
}
