import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config";

const db = new Database(config.dbPath);

export function initDb(): void {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "db", "schema.sql"),
    "utf-8"
  );
  db.exec(schema);
}

export default db;
