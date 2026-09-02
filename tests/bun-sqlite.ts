import { DatabaseSync, type StatementSync } from "node:sqlite";

export class Database {
  private readonly db: DatabaseSync;

  constructor(location: string) {
    this.db = new DatabaseSync(location);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  query(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}
