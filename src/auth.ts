import { setApiToken } from "./utils/cf-client.js";

export function initAuth(): void {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN environment variable is required. " +
        "Create a scoped API token at https://dash.cloudflare.com/profile/api-tokens",
    );
  }
  setApiToken(token);
}
