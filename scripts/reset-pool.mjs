#!/usr/bin/env node

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function codexHome() {
  const explicit = typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "";
  if (explicit) return explicit;
  const home = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  if (home) return join(home, ".codex");
  throw new Error("CODEX_HOME or HOME must be set");
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = { parent: "", global: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--parent") args.parent = String(argv[++index] ?? "").trim();
    else if (value === "--global") args.global = true;
    else if (value === "-h" || value === "--help") args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.help && !args.parent && !args.global) throw new Error("inspect requires --parent <thread_id> or --global");
  if (args.parent && args.global) throw new Error("choose only one of --parent or --global");
  return args;
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: reset-pool.mjs (--parent <thread_id> | --global)\n");
    process.stdout.write("This command is read-only. Codex owns thread_spawn_edges lifecycle.\n");
    return;
  }
  const dbPath = join(codexHome(), "state_5.sqlite");
  if (!(await pathExists(dbPath))) throw new Error(`missing Codex state DB: ${dbPath}`);
  const where = args.parent ? `where parent_thread_id=${sqlString(args.parent)}` : "";
  const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, `select status,count(*) as count from thread_spawn_edges ${where} group by status order by status;`], {
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(`${JSON.stringify({ read_only: true, parent: args.parent || null, edges: JSON.parse(stdout.trim() || "[]") }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
