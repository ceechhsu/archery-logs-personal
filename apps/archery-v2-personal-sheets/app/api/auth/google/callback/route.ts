import { NextRequest, NextResponse } from "next/server";
import {
  clearOauthStateCookie,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
  readOauthStateCookie,
  setSessionCookie
} from "@/lib/server/auth";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = await readOauthStateCookie();

    if (!code || !state || !expectedState || state !== expectedState) {
      await clearOauthStateCookie();
      return NextResponse.redirect(new URL("/?authError=state_mismatch", request.url));
    }

    const tokenResponse = await exchangeCodeForTokens(code);
    const user = await fetchGoogleUserInfo(tokenResponse.access_token);

    await setSessionCookie({
      user,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000
    });
    await clearOauthStateCookie();

    return NextResponse.redirect(new URL("/", request.url));
  } catch (error) {
    console.error("OAuth callback failed", error);
    await clearOauthStateCookie();
    return NextResponse.redirect(new URL("/?authError=oauth_failed", request.url));
  }
}
