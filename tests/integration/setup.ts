import { beforeAll, afterEach, afterAll } from "vitest";
import { setupServer } from "msw/node";
import { handlers } from "./handlers/cf-mock.js";
import { setApiToken } from "../../src/utils/cf-client.js";
import { clearZoneCache } from "../../src/utils/zone-resolver.js";
import { clearAccountCache } from "../../src/utils/account-resolver.js";

export const mockServer = setupServer(...handlers);

beforeAll(() => {
  mockServer.listen({ onUnhandledRequest: "error" });
  setApiToken("test-integration-token");
});

afterEach(() => {
  mockServer.resetHandlers();
  clearZoneCache();
  clearAccountCache();
});

afterAll(() => {
  mockServer.close();
});
