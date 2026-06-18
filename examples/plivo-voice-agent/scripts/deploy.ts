/**
 * Deploy the Worker and provision Plivo in one command.
 *
 * Runs `wrangler deploy`, uploads the .env values as Worker secrets (the
 * browser token endpoint needs them at runtime), reads the deployed
 * workers.dev URL, and points the Plivo application and phone number at it —
 * no manual answer-URL or secret configuration.
 */

import { execSync } from "node:child_process";
import { setupPlivoApplication } from "@cloudflare/voice-plivo";
import { requirePlivoEnv } from "./env.js";

async function main(): Promise<void> {
  const env = requirePlivoEnv();

  const output = execSync("wrangler deploy", { encoding: "utf8" });
  process.stdout.write(output);

  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (!match) {
    console.error(
      "\nDeployed, but couldn't find the Worker URL in wrangler's output. " +
        "Point your Plivo app's answer URL at <worker-url>/answer manually."
    );
    process.exit(1);
  }

  // Upload .env as Worker secrets — the /api/plivo-token browser endpoint
  // reads PLIVO_AUTH_ID/TOKEN/ENDPOINT_USERNAME at runtime.
  execSync("wrangler secret bulk .env", { stdio: "inherit" });

  const workerUrl = match[0];
  await setupPlivoApplication({ ...env, answerUrl: `${workerUrl}/answer` });

  console.log(`\n✅ ${env.phoneNumber} → ${workerUrl}/answer. Call it.`);
}

main().catch((err: unknown) => {
  console.error("\nDeploy failed:", (err as Error).message);
  process.exit(1);
});
