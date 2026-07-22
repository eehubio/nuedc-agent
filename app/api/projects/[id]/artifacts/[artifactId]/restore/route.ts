import { NextRequest, NextResponse } from "next/server";
import { assertProjectAccess, resolveOwner } from "@/lib/auth";
import { restoreArtifact } from "@/lib/artifacts";

export const runtime = "nodejs";

/** POST → 把历史版本复制为新的最高版本（不可变历史，恢复即新版本） */
export async function POST(req: NextRequest, { params }: { params: { id: string; artifactId: string } }) {
  const denied = await assertProjectAccess(req, params.id);
  if (denied) return denied;
  const { owner } = resolveOwner(req);
  const r = await restoreArtifact(params.id, params.artifactId, owner);
  if (!r) return NextResponse.json({ error: "产物不存在" }, { status: 404 });
  return NextResponse.json(r, { status: 201 });
}
