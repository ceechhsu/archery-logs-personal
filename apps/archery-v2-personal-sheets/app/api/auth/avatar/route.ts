import { NextRequest, NextResponse } from "next/server";
import { fetchGoogleUserInfo, requireAccessToken } from "@/lib/server/auth";

function normalizeGooglePictureUrl(url: string, size: number): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const secure = trimmed.startsWith("http://") ? `https://${trimmed.slice(7)}` : trimmed;
  if (!secure.includes("googleusercontent.com")) return secure;
  const withoutSize = secure.replace(/=s\d+(-c)?$/, "");
  return `${withoutSize}=s${size}-c`;
}

function parseSize(request: NextRequest): number {
  const raw = Number(request.nextUrl.searchParams.get("size") || "96");
  if (!Number.isFinite(raw)) return 96;
  return Math.max(24, Math.min(512, Math.round(raw)));
}

export async function GET(request: NextRequest) {
  try {
    const accessToken = await requireAccessToken();
    const user = await fetchGoogleUserInfo(accessToken);
    if (!user.picture) return new NextResponse(null, { status: 204 });

    const pictureUrl = normalizeGooglePictureUrl(user.picture, parseSize(request));
    if (!pictureUrl) return new NextResponse(null, { status: 204 });

    const response = await fetch(pictureUrl, { cache: "no-store" });
    if (!response.ok || !response.body) {
      return new NextResponse(null, { status: 204 });
    }

    return new NextResponse(response.body, {
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "private, max-age=300"
      }
    });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
