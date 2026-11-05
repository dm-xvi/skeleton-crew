// A stand-in for Linear's token and GraphQL endpoints. It hands out numbered
// tokens (secret-access-1, secret-refresh-1, ...) and records every call.
import type { Fetch } from "../src/linearOAuth.js";

export const APP_USER_ID = "e067e6e9-6080-4b37-8a80-779f63de574d";
export const ORGANIZATION_ID = "724adc74-61a9-4c01-8584-2a37b85f3118";

export interface FakeLinear {
  fetch: Fetch;
  tokenRequests: URLSearchParams[];
  // Set to make the next token request fail with this status and error code.
  failNextToken?: { status: number; error: string };
  // The token request waits on this when set, to hold a refresh in flight.
  tokenGate?: Promise<void>;
  viewerIsApp: boolean;
  organizationId: string;
}

export function fakeLinear(): FakeLinear {
  let issued = 0;
  const linear: FakeLinear = {
    tokenRequests: [],
    viewerIsApp: true,
    organizationId: ORGANIZATION_ID,
    fetch: async (input, init) => {
      const url = String(input);
      if (url === "https://api.linear.app/oauth/token") {
        const params = new URLSearchParams(String(init?.body));
        linear.tokenRequests.push(params);
        // Decided on arrival, so a request held at the gate keeps its outcome.
        const failure = linear.failNextToken;
        linear.failNextToken = undefined;
        await linear.tokenGate;
        if (failure) {
          return Response.json({ error: failure.error }, { status: failure.status });
        }
        issued++;
        return Response.json({
          access_token: `secret-access-${issued}`,
          token_type: "Bearer",
          expires_in: 86399,
          refresh_token: `secret-refresh-${issued}`,
          scope: "app:assignable app:mentionable read write",
        });
      }
      if (url === "https://api.linear.app/graphql") {
        return Response.json({
          data: { viewer: { id: APP_USER_ID, app: linear.viewerIsApp, organization: { id: linear.organizationId } } },
        });
      }
      throw new Error(`fake Linear has no route for ${url}`);
    },
  };
  return linear;
}
