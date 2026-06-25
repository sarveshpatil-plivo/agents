/**
 * Plivo application provisioning.
 *
 * Idempotently points a Plivo phone number at a Worker: finds or creates the
 * `cloudflare-agents-<number>` application for that number, sets its answer
 * URL, and assigns the number to it. Runs against the Plivo REST API with
 * Basic auth.
 */

export interface PlivoSetupConfig {
  /** Plivo Auth ID from console.plivo.com */
  authId: string;
  /** Plivo Auth Token from console.plivo.com */
  authToken: string;
  /** The phone number to configure (E.164 format, e.g. "+12025551234") */
  phoneNumber: string;
  /** The public URL of the Worker's /answer endpoint */
  answerUrl: string;
}

interface PlivoApplication {
  app_id: string;
  app_name: string;
  answer_url: string;
}

interface PlivoListApplicationsResponse {
  objects: PlivoApplication[];
}

/**
 * Provision the Plivo application and assign the phone number to it.
 *
 * Idempotent: updates this number's `cloudflare-agents-<number>` application
 * if it exists, otherwise creates it. Safe to run on every deploy.
 */
export async function setupPlivoApplication(
  config: PlivoSetupConfig
): Promise<void> {
  const { authId, authToken, phoneNumber, answerUrl } = config;
  const auth = btoa(`${authId}:${authToken}`);
  const base = `https://api.plivo.com/v1/Account/${authId}`;
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json"
  };

  // Key the application by the full digits-only phone number so each number
  // maps to exactly one deterministic application. Create and lookup use the
  // same name, so re-running for a given number updates its own app and never
  // collides with the app for a different number.
  const digits = phoneNumber.replace(/\D/g, "");
  const appName = `cloudflare-agents-${digits}`;

  const listResp = await fetch(`${base}/Application/`, { headers });
  if (!listResp.ok) {
    throw new Error(`Failed to list applications: ${listResp.status}`);
  }

  const list = (await listResp.json()) as PlivoListApplicationsResponse;
  const existing = list.objects.find((a) => a.app_name === appName);

  let appId: string;

  if (existing) {
    const updateResp = await fetch(`${base}/Application/${existing.app_id}/`, {
      method: "POST",
      headers,
      body: JSON.stringify({ answer_url: answerUrl, answer_method: "GET" })
    });
    if (!updateResp.ok) {
      throw new Error(`Failed to update application: ${updateResp.status}`);
    }
    appId = existing.app_id;
  } else {
    const createResp = await fetch(`${base}/Application/`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        app_name: appName,
        answer_url: answerUrl,
        answer_method: "GET"
      })
    });
    if (!createResp.ok) {
      throw new Error(`Failed to create application: ${createResp.status}`);
    }
    const created = (await createResp.json()) as { app_id: string };
    appId = created.app_id;
  }

  const assignResp = await fetch(`${base}/Number/${digits}/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app_id: appId })
  });
  if (!assignResp.ok) {
    throw new Error(`Failed to assign phone number: ${assignResp.status}`);
  }
}
