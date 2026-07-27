import express from "express";
import { config } from "./core/config";
import { initDb } from "./core/db";
import webhookRouter from "./webhook/router";
import { statementRouter } from "./pillar3-statement";

initDb();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(webhookRouter);
app.use(statementRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`Duka Rafiki listening on port ${config.port}`);
});
